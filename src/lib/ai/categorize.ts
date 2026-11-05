import { z } from "zod";
import { canonicalCategory, knownMerchantCategory, type Category } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";
import { chat, type ChatOptions } from "./client";
import { readAiConfig } from "./config";
import { aiCategories, type AiBookingInput, type AiExample } from "./review-candidates";

export type AiCategorization = {
  ref: string;
  category: Category | "Prüfen";
  merchant?: string;
  confidence: number;
  accepted: boolean;
  reason?: string;
};

const SENSITIVE: readonly Category[] = ["Transfer", "Transfer intern", "Rückerstattungen", "Gehalt", "Rufbereitschaft", "Einkommen"];

const HINTS: Partial<Record<Category, string>> = {
  "Lebensmittel": "Supermarkt-Einkauf (BILLA, SPAR, Hofer, Lidl, Penny)",
  "Mittagessen": "Mittagessen unter der Woche, Kantine, Mensa",
  "Restaurants": "Restaurant, Bar, Gasthaus, Fast Food vor Ort",
  "Lieferdienste": "Essenslieferung (Wolt, Foodora, Lieferando)",
  "Guthabenkarten": "Gutscheine, Prepaid-/Spielguthaben",
  "Abonnements": "Streaming, Software, wiederkehrende Abos",
  "Mobilität": "Taxi, Uber, Carsharing, sonstige Mobilität",
  "Öffentliche Verkehrsmittel": "ÖBB, Wiener Linien, Westbahn, Flixbus",
  "Urlaub": "Hotels, Flüge, Unterkünfte, Reisebuchungen",
  "Transfer": "Überweisung an andere Personen ohne Konsum",
  "Transfer intern": "Umbuchung zwischen eigenen Konten/Karten, Kreditkartenabrechnung",
  "Rückerstattungen": "Gutschrift/Refund eines Händlers (positiver Betrag)",
  "Einkommen": "sonstige Einnahmen (positiver Betrag)",
};

export function buildCategorizationMessages(bookings: AiBookingInput[], examples: AiExample[]) {
  const list = aiCategories.map((category) => HINTS[category] ? `- ${category}: ${HINTS[category]}` : `- ${category}`).join("\n");
  const learned = examples.length
    ? examples.map((example) => `- "${example.text}" => ${example.category}`).join("\n")
    : "- (noch keine)";
  const system = `Du kategorisierst österreichische Bankbuchungen eines Privathaushalts.
Erlaubte Kategorien (exakt so schreiben):
${list}

Bisherige Entscheidungen des Nutzers (haben Vorrang vor allgemeinem Wissen):
${learned}

Regeln:
- Negative Beträge sind Ausgaben, positive Beträge Einnahmen oder Rückerstattungen.
- "merchant" ist der kurze Markenname ohne Rechtsform, Ort, PLZ oder Terminalnummer (z. B. "CINEPLEXX Kinobetriebe GmbH" => "Cineplexx", "BILLA DANKT 1234 WIEN" => "BILLA") oder null, wenn kein Händler erkennbar ist.
- Zahlungsdienste (PayPal, Klarna, SumUp, Stripe) sind KEINE Händler: steht der eigentliche Shop nicht im Text, setze "category":"Prüfen".
- "confidence" (0-100) ist deine Sicherheit für Kategorie UND Händler. Rate nie: wenn der Text mehrdeutig ist, setze "category":"Prüfen" und confidence unter 50.
- Antworte NUR mit einem JSON-Array, ein Objekt pro Buchung, ohne Erklärtext:
[{"ref":"b1","category":"…","merchant":"…","confidence":95}]`;
  const user = bookings.map((booking) => JSON.stringify({
    ref: booking.ref, text: booking.text, betrag: booking.amount, datum: booking.date, bank: booking.bank,
    ...(booking.hint ? { hinweis: booking.hint } : {}),
  })).join("\n");
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `Buchungen:\n${user}` },
  ];
}

const answerItemSchema = z.object({
  ref: z.string(),
  category: z.string(),
  merchant: z.string().trim().max(80).nullish(),
  confidence: z.coerce.number().min(0).max(100),
}).loose();

// One malformed entry must not discard the whole batch.
function parseAnswers(text: string) {
  const raw = extractJsonArray(text);
  return Array.isArray(raw) ? raw.flatMap((item) => {
    const parsed = answerItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }) : [];
}

export function extractJsonArray(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const categoryByName = new Map(aiCategories.map((category) => [category.toLocaleLowerCase("de-AT"), category]));

// The model sometimes echoes the hint ("Lebensmittel: Supermarkt"); only the exact name before it counts.
export function resolveCategoryName(value: string) {
  const name = value.trim().toLocaleLowerCase("de-AT");
  return categoryByName.get(name) ?? categoryByName.get(name.split(/\s*[:(–-]\s+|\s*:\s*/)[0].trim());
}

const LEGAL_FORM = /\s+(?:gmbh|ges\.?m\.?b\.?h\.?|ag|kg|og|e\.?\s?u\.?|se|ltd\.?|limited|inc\.?|llc|s\.?\s?a\.?\s?r\.?\s?l\.?|s\.?c\.?a\.?|b\.?v\.?|co\.?|& co\.?.*|kinobetriebe|handelsgesellschaft|betriebs.*)(?=\s|$).*$/i;
const GENERIC_MERCHANT = /^(?:null|none|n\/a|unbekannt|unknown|-|händler|haendler|zahlungsempfänger|empfänger|auftraggeber|überweisung|lastschrift|kartenzahlung|sonstige[sn]?)$/i;
const PAYMENT_PROVIDER = /^(?:paypal|klarna|sumup|stripe|adyen|sofort|eps|mollie|wise|curve|google pay|apple pay)\b/i;

// Bank texts carry legal forms, terminal ids and postcodes; the alias should be the brand only.
export function cleanMerchantName(value: string | null | undefined) {
  if (!value || GENERIC_MERCHANT.test(value.trim()) || resolveCategoryName(value)) return undefined;
  let name = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  for (let previous = ""; previous !== name;) {
    previous = name;
    name = name.replace(LEGAL_FORM, "").replace(/\s+(?:[A-Z]{0,2}\d[\w-]*|\d+)$/i, "").replace(/[\s,.*/-]+$/, "").trim();
  }
  return name.length >= 2 && /\p{L}/u.test(name) ? name.slice(0, 80) : undefined;
}

export const isPaymentProvider = (merchant: string) => PAYMENT_PROVIDER.test(merchant.trim());

const PROVIDER_MERCHANT = /\b(?:paypal|klarna|sumup|sq|zettle|stripe)\s*\*\s*([^|]+)/i;
const LEGAL_WORDS = /^(?:com|ltd|inc|gmbh|llc|bv|sa|sl|srl|ag|kg|eea|europe|eu|limited|co)$/i;

// The shop behind a payment provider: "PAYPAL *RENOVARO 06136922270" => "Renovaro".
// Plain PayPal debits ("1051861566294/PAYPAL") carry no shop name.
export function providerMerchant(text: string): string | undefined {
  const match = PROVIDER_MERCHANT.exec(text.normalize("NFKC"));
  if (!match) return undefined;
  const word = match[1].trim().split(/\s+/)
    .find((token) => /\p{L}/u.test(token) && !/\d{4,}/.test(token) && !LEGAL_WORDS.test(token));
  if (!word || /^(?:paypal|klarna)$/i.test(word) || word.length < 2) return undefined;
  return /\d/.test(word) || word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1).toLowerCase();
}

// The model reports ~95 % for nearly everything, so these technical categories need a matching bank rule.
const RULE_ONLY: readonly Category[] = [
  "Bankgebühren", "Rücklastschriftgebühren", "Guthabenkarten", "Leasing", "Miete", "Versicherungen",
  "Gehalt", "Rufbereitschaft", "Einkommen", "Rückerstattungen", "Transfer", "Transfer intern", "Sonstiges",
];
// A rule naming the broad purpose still allows the model to pick the matching sub-category.
export const RULE_REFINEMENTS: Partial<Record<Category, readonly Category[]>> = {
  "Mobilität": ["Tanken", "Öffentliche Verkehrsmittel"],
};
const comparable = (value: string) => value.toLocaleLowerCase("de-AT").replace(/[^\p{L}\p{N}]/gu, "");
const CASH_WITHDRAWAL = /\batm\d*\b|\bbankomat\b|geldautomat|sb-behebung|bargeld|cash\s*withdrawal/i;
const PAYMENT_PROVIDER_IN_TEXT = /\b(?:paypal|klarna|sumup|stripe|adyen)\b/i;

// The merchant must be what the bank text starts with, not a city or payment reference further on.
export function merchantMatchesText(merchant: string, text: string) {
  const head = text.split("|").map((part) => part.trim()
    .replace(/^(?:paypal|sumup|sq|zettle|klarna)\s*\*\s*/i, "").replace(/^www\./i, "").split(/\s+/)[0] ?? "");
  const word = comparable(merchant.split(/\s+/)[0] ?? "");
  return word.length >= 2 && head.some((token) => {
    const first = comparable(token);
    return first.length >= 2 && (first.includes(word) || word.includes(first));
  });
}

export function plausibilityIssue(booking: AiBookingInput, category: Category, merchant: string | undefined) {
  if (CASH_WITHDRAWAL.test(booking.text)) return "Bargeldbehebung";
  // Small station receipts are snacks or car wash, not fuel.
  if (category === "Tanken" && Math.abs(booking.amount) < 10) return "Betrag zu klein zum Tanken";
  if (!merchant && PAYMENT_PROVIDER_IN_TEXT.test(booking.text) && !providerMerchant(booking.text) && !category.startsWith("Transfer"))
    return "Zahlungsdienst verdeckt den Händler";
  const rule = knownMerchantCategory(booking.text, booking.amount);
  if (rule && rule !== "Prüfen" && rule !== category && !RULE_REFINEMENTS[rule]?.includes(category))
    return `widerspricht Händlerregel (${rule})`;
  if (RULE_ONLY.includes(category) && rule !== category) return "Kategorie nur mit Bankregel";
  if (merchant && !merchantMatchesText(merchant, booking.text)) return "Händler nicht eindeutig";
  if (merchant && containsLocation(merchant, booking.text)) return "Händlername enthält den Ort";
  return undefined;
}

// Card texts end with the terminal's town ("VILLACH ATRIO SHOPPING VILLACH"); a
// merchant name starting with that word is a place, not a business name.
function containsLocation(merchant: string, text: string) {
  const first = comparable(merchant.split(/\s+/)[0] ?? "");
  return first.length >= 3 && text.split("|").some((part) => {
    const alpha = part.trim().replace(/^(?:paypal|sumup|sq|zettle|klarna)\s*\*\s*/i, "")
      .split(/\s+/).filter((token) => !/\d/.test(token));
    return alpha.length >= 2 && comparable(alpha[alpha.length - 1]) === first;
  });
}

export function interpretCategorization(
  text: string, bookings: AiBookingInput[], minConfidence = readAiConfig().minConfidence,
): AiCategorization[] {
  const answers = new Map(parseAnswers(text).map((answer) => [answer.ref, answer]));
  return bookings.map((booking): AiCategorization => {
    const answer = answers.get(booking.ref);
    if (!answer) return { ref: booking.ref, category: "Prüfen", confidence: 0, accepted: false, reason: "keine Antwort" };
    const category = resolveCategoryName(answer.category);
    const named = cleanMerchantName(answer.merchant);
    const shop = providerMerchant(booking.text);
    // "PAYPAL *ZALANDO" names the shop; the provider alone hides it.
    const merchant = named && isPaymentProvider(named) ? shop ?? named : named ?? shop;
    const base = { ref: booking.ref, merchant, confidence: Math.round(answer.confidence) };
    if (!category) return { ...base, category: "Prüfen", accepted: false, reason: "unsicher" };
    if (merchant && isPaymentProvider(merchant) && !category.startsWith("Transfer"))
      return { ...base, merchant: undefined, category, accepted: false, reason: "Zahlungsdienst verdeckt den Händler" };
    const income = isIncomeCategory(canonicalCategory(category));
    // Signs contradicting the category are model errors, never a confident answer.
    if ((income || category === "Rückerstattungen") !== booking.amount > 0 && !category.startsWith("Transfer"))
      return { ...base, category, accepted: false, reason: "Vorzeichen passt nicht" };
    const issue = plausibilityIssue(booking, category, merchant);
    if (issue) return { ...base, category, accepted: false, reason: issue };
    const threshold = SENSITIVE.includes(category) ? Math.max(minConfidence, 97) : minConfidence;
    return base.confidence >= threshold
      ? { ...base, category, accepted: true }
      : { ...base, category, accepted: false, reason: `Sicherheit ${base.confidence} % < ${threshold} %` };
  });
}

export async function categorizeBookings(
  bookings: AiBookingInput[], examples: AiExample[], options: ChatOptions = {},
): Promise<AiCategorization[]> {
  if (!bookings.length) return [];
  const config = options.config ?? readAiConfig();
  const answer = await chat(buildCategorizationMessages(bookings, examples), {
    ...options, config, maxTokens: 60 + bookings.length * 45,
  });
  const results = interpretCategorization(answer.content, bookings, config.minConfidence);
  const missing = bookings.filter((_, index) => results[index].reason === "keine Antwort");
  if (bookings.length === 1 || !missing.length) return results;
  // Retry lost answers one by one; a single booking rarely breaks the JSON.
  for (const booking of missing) {
    const [retry] = await categorizeBookings([booking], examples, { ...options, config });
    results[bookings.indexOf(booking)] = retry;
  }
  return results;
}
