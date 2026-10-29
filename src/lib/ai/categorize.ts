import { z } from "zod";
import { canonicalCategory, type Category } from "@/lib/categories";
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

const answerSchema = z.array(z.object({
  ref: z.string(),
  category: z.string(),
  merchant: z.string().trim().max(80).nullish(),
  confidence: z.coerce.number().min(0).max(100),
}).loose());

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

export function interpretCategorization(
  text: string, bookings: AiBookingInput[], minConfidence = readAiConfig().minConfidence,
): AiCategorization[] {
  const parsed = answerSchema.safeParse(extractJsonArray(text));
  const answers = new Map(parsed.success ? parsed.data.map((answer) => [answer.ref, answer]) : []);
  return bookings.map((booking): AiCategorization => {
    const answer = answers.get(booking.ref);
    if (!answer) return { ref: booking.ref, category: "Prüfen", confidence: 0, accepted: false, reason: "keine Antwort" };
    const category = resolveCategoryName(answer.category);
    const merchant = cleanMerchantName(answer.merchant);
    const base = { ref: booking.ref, merchant, confidence: Math.round(answer.confidence) };
    if (!category) return { ...base, category: "Prüfen", accepted: false, reason: "unsicher" };
    // A payment provider hides the real shop, so the category cannot be known from the bank text.
    if (merchant && isPaymentProvider(merchant) && !category.startsWith("Transfer"))
      return { ...base, merchant: undefined, category, accepted: false, reason: "Zahlungsdienst verdeckt den Händler" };
    // "Sonstiges" without a recognised shop is a shrug, not a decision.
    if (category === "Sonstiges" && !merchant)
      return { ...base, category, accepted: false, reason: "kein Händler erkannt" };
    const income = isIncomeCategory(canonicalCategory(category));
    // Signs contradicting the category are model errors, never a confident answer.
    if ((income || category === "Rückerstattungen") !== booking.amount > 0 && !category.startsWith("Transfer"))
      return { ...base, category, accepted: false, reason: "Vorzeichen passt nicht" };
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
  return interpretCategorization(answer.content, bookings, config.minConfidence);
}
