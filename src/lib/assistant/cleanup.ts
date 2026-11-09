import { isAiEligibleReview } from "@/lib/ai/review-candidates";
import { aiSuggestionFor } from "@/lib/ai/suggestions";
import { classify } from "@/lib/calc";
import { canonicalCategory, knownMerchantCategory, type Category } from "@/lib/categories";
import { dateLabel } from "@/lib/format";
import { normalizeSearch, matchesTransactionSearch } from "@/lib/transaction-tools";
import type { AppState, AssistantCard, AssistantOperation, Transaction } from "@/lib/types";
import { parseAmount } from "./intent";

// Bulk work in one sentence: settle the whole review list, or assign bookings picked by merchant, date or amount.

type Line = AssistantCard["lines"][number];
export type BookingFilter = { date?: string; min?: number; max?: number; exact?: number };

const leading = /^(?:alle|die|der|das|den|dem|meine?n?|buchung(?:en)?|überweisung(?:en)?|ueberweisung(?:en)?|zahlung(?:en)?|lastschrift(?:en)?|abbuchung(?:en)?|aufladung(?:en)?|umsätze|umsaetze|umsatz|einzahlung(?:en)?|gutschrift(?:en)?|eingänge|eingaenge|von|vom|an|bei|zu|für|fuer|mit|aus|nach)\s+/i;
const trailing = /\s+(?:buchung(?:en)?|aufladung(?:en)?|überweisung(?:en)?|ueberweisung(?:en)?|zahlung(?:en)?|abbuchung(?:en)?|lastschrift(?:en)?|einzahlung(?:en)?|top-?ups?)$/i;
const datePattern = /\b(?:vom|am|den)?\s*(\d{1,2})\.\s?(\d{1,2})\.?(?:\s?(20\d{2}|\d{2})\b)?/;
const amountPattern = /(?:(über|ueber|mehr als|ab|größer als|groesser als|unter|weniger als|kleiner als|bis|mit|von|zu)\s+)?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\s*(?:€|euro\b|eur\b)/i;

function cleanPart(part: string): string {
  let value = part.replace(new RegExp(datePattern.source, "gi"), " ").replace(new RegExp(amountPattern.source, "gi"), " ")
    .replace(/[„“"'.,!?:;()]/g, " ").replace(/\s+/g, " ").trim();
  for (let step = 0; step < 6; step++) {
    const next = value.replace(leading, "").replace(trailing, "").trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

// Merchant text only: a search for "Revolut" must not hit every booking of the Revolut account.
// Whole words first: "Spar" means SPAR, not a Trade Republic "Sparplan".
function strictMatch(row: Transaction, name: string, whole = false): boolean {
  const words = normalizeSearch(name).split(" ").filter(Boolean);
  if (!words.length) return false;
  const text = normalizeSearch([row.description, row.merchantAlias, row.rawDescription, ...(row.rawDetails ?? [])].filter(Boolean).join(" "));
  if (!whole) return words.every((word) => text.includes(word));
  const tokens = ` ${text.replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return words.every((word) => tokens.includes(` ${word} `));
}

// "Trade Republic ist Transfer intern" means payments to Trade Republic, not interest or card payments on the Trade Republic account itself.
function ownAccount(row: Transaction, name: string): boolean {
  const words = normalizeSearch(name).split(" ").filter(Boolean);
  const account = normalizeSearch(`${row.bank} ${row.pocket ?? ""}`);
  return words.length > 0 && words.every((word) => account.includes(word));
}

export function merchantRows(state: AppState, name: string): { rows: Transaction[]; strict: boolean } {
  const whole = state.transactions.filter((row) => strictMatch(row, name, true) && !ownAccount(row, name));
  if (whole.length) return { rows: whole, strict: true };
  const strict = state.transactions.filter((row) => strictMatch(row, name) && !ownAccount(row, name));
  if (strict.length) return { rows: strict, strict: true };
  const loose = state.transactions.filter((row) => matchesTransactionSearch(row, name) && !ownAccount(row, name));
  if (loose.length) return { rows: loose, strict: false };
  // Only the account itself carries the name: its transfers are meant, never its card payments or interest.
  return { rows: state.transactions.filter((row) => ownAccount(row, name) && classify(row).isTransfer), strict: true };
}

// The longest run of words (up to 4) that really appears in the bookings.
function longestKnown(state: AppState, text: string): string | undefined {
  const words = text.split(/\s+/).filter(Boolean);
  for (let size = Math.min(4, words.length); size >= 1; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      const name = words.slice(start, start + size).join(" ");
      if (name.length >= 3 && !/^\d/.test(name) && state.transactions.some((row) => strictMatch(row, name))) return name;
    }
  }
  return undefined;
}

// "Buchung Trade Republic", "Überweisungen an Max Muster", "Billa und Spar" → the merchant names as they appear in the bookings.
export function resolveMerchants(state: AppState, phrase: string): string[] | undefined {
  const parts = phrase.split(/\s*,\s*|\s+(?:und|sowie|oder)\s+|\s+[&+]\s+/i).map(cleanPart).filter((part) => part.length >= 2);
  if (!parts.length) return undefined;
  const names: string[] = [];
  for (const part of parts) {
    const found = state.transactions.some((row) => strictMatch(row, part)) ? part : longestKnown(state, part);
    if (!found) {
      const whole = cleanPart(phrase);
      const single = whole && (state.transactions.some((row) => strictMatch(row, whole)) ? whole : longestKnown(state, whole));
      if (single) return [single];
      return parts.length === 1 && state.transactions.some((row) => matchesTransactionSearch(row, part)) ? [part] : undefined;
    }
    if (!names.includes(found)) names.push(found);
  }
  return names;
}

export function bookingFilter(text: string, asOf: string): BookingFilter {
  const filter: BookingFilter = {};
  const date = datePattern.exec(text);
  if (date && /\b(?:vom|am|den)\s*\d/.test(text) || date && /\d{1,2}\.\s?\d{1,2}\./.test(text)) {
    const [, day, month, rawYear] = date!;
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
      const year = rawYear ? (rawYear.length === 2 ? `20${rawYear}` : rawYear) : asOf.slice(0, 4);
      const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      filter.date = !rawYear && value > asOf ? `${Number(year) - 1}${value.slice(4)}` : value;
    }
  }
  const amount = amountPattern.exec(text);
  if (amount) {
    const value = parseAmount(`${amount[2]}${amount[3] ? `,${amount[3]}` : ""}`);
    const word = (amount[1] ?? "").toLowerCase();
    // "die Buchung über 200 €" is one booking of 200 €, "alle Buchungen über 100 €" means above 100 €.
    const plural = /\balle\b|buchungen|zahlungen|überweisungen|ueberweisungen|abbuchungen|umsätze|umsaetze/i.test(text);
    if (value !== undefined) {
      if (/^(?:mehr als|ab|größer als|groesser als)$/.test(word) || /^(?:über|ueber)$/.test(word) && plural) filter.min = value;
      else if (/^(?:unter|weniger als|kleiner als|bis)$/.test(word)) filter.max = value;
      else filter.exact = value;
    }
  }
  return filter;
}

export const hasFilter = (filter: BookingFilter) => Object.keys(filter).length > 0;

export function matchesFilter(row: Transaction, filter: BookingFilter): boolean {
  const amount = Math.abs(row.amount);
  return (!filter.date || row.date === filter.date) && (filter.min === undefined || amount > filter.min - 0.005) &&
    (filter.max === undefined || amount < filter.max + 0.005) && (filter.exact === undefined || Math.abs(amount - filter.exact) < 0.005);
}

export function filterLabel(filter: BookingFilter): string {
  const money = (value: number) => `${value.toLocaleString("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  return [filter.date && `vom ${dateLabel(filter.date)}`, filter.exact !== undefined && `über ${money(filter.exact)}`,
    filter.min !== undefined && `ab ${money(filter.min)}`, filter.max !== undefined && `bis ${money(filter.max)}`].filter(Boolean).join(" ");
}

export const cleanupQuestion = (lower: string) =>
  /\b(?:arbeit\w*|erledig\w*|abarbeit\w*|räum\w*|raeum\w*|ordne\w*|kategorisier\w*|zuordn\w*|zuweis\w*|sortier\w*|kümmer\w*|kuemmer\w*|klär\w*|klaer\w*|mach\w*|geh\w*)\b.{0,40}\b(?:prüf\w*|pruef\w*|offene\w*|ungeprüft\w*|ungeprueft\w*|unklare?\w*|unzugeordnet\w*|nicht zugeordnet\w*|unsortiert\w*|ohne kategorie)/.test(lower) ||
  /\b(?:prüf|pruef)(?:liste|-?buchungen|-?fälle|-?faelle|-?einträge|-?eintraege)\b/.test(lower) && /\b(?:ab|erledig\w*|zuordn\w*|weg|abarbeit\w*|aufräum\w*|durch)\b/.test(lower) ||
  /\b(?:ordne|kategorisiere|sortiere)\s+(?:mir\s+)?alles\b|\balles (?:automatisch |selbst )?(?:zuordnen|kategorisieren|abarbeiten|einordnen)\b|\baufräumen\b.*\bbuchungen\b|\bbuchungen\b.*\baufräumen\b/.test(lower);

const keyOf = (text: string) => normalizeSearch(text).replace(/\d+/g, " ").split(" ").filter((word) => word.length > 1).slice(0, 3).join(" ");
const fitsSign = (category: Category, amount: number) => {
  const income = ["Einkommen", "Gehalt", "Rufbereitschaft", "Rückerstattungen"].includes(canonicalCategory(category));
  return amount > 0 ? income || /Transfer|Sonstiges|Urlaub/.test(category) : !income;
};

type Guess = { category: Category; why: string };

function historyGuess(state: AppState, description: string, amount: number, skip: string): Guess | undefined {
  const key = keyOf(description);
  if (!key) return undefined;
  const counts = new Map<Category, number>();
  for (const row of state.transactions) {
    if (row.id === skip || row.ignored || keyOf(row.merchantAlias || row.description) !== key && keyOf(row.description) !== key) continue;
    const category = canonicalCategory(classify(row).category);
    if (category === "Prüfen" || (row.amount > 0) !== (amount > 0)) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  return best && best[1] / total >= 0.6 ? { category: best[0], why: `wie ${best[1] === 1 ? "die frühere Buchung" : `${best[1]} frühere Buchungen`}` } : undefined;
}

// Plain words in foreign card payments ("2Day Supermarket", "Napa Suites", "Coral Gas").
const keywordCategories: [RegExp, Category][] = [
  [/super ?market|supermercado|supermarch|\bmarket\b|\bmarkt\b|\bgrocer|σκλαβενιτησ|\bbakery\b|\bbäckerei\b|\bbaeckerei\b/i, "Lebensmittel"],
  [/\bcoffee\b|\bcaf[eé]\b|\bkiosk|\bgelato|\bice ?cream\b|\bbakery\b/i, "Cafés & Snacks"],
  [/\brestaurant|\btaverna|\btrattoria|\bpizz|\bgrill\b|\bbistro|\bsushi\b|\bburger/i, "Restaurants"],
  [/\bhotel|\bsuites?\b|\bresort\b|\bhospitality\b|\bhostel\b|\bairbnb\b|\bbooking\.com\b|\bapartments?\b/i, "Urlaub"],
  [/\bgas\b|\bpetrol|\bfuel\b|\btankstelle\b|\bshell\b|\bomv\b|\bbp\b|\beni\b|\baral\b/i, "Tanken"],
  [/\bpharmac|\bapotheke\b|\bfarmac/i, "Gesundheit"],
  [/\bparking\b|\bparkhaus\b|\bparkgarage\b|\bmaut\b|\btoll\b/i, "Parken & Maut"],
];
// Stored model suggestions are only a hint: fees and "Sonstiges" need matching words in the booking.
const feeCategories = /^(?:Bankgebühren|Rücklastschriftgebühren)$/;
const feeWords = /geb(?:ü|ue|u)hr|entgelt|spesen|\bfee\b|rücklast|ruecklast|zinsen|kontof(?:ü|ue|u)hrung/i;

function guess(state: AppState, description: string, amount: number, id: string, stored?: { category: Category; source: string }): Guess | undefined {
  const history = historyGuess(state, description, amount, id);
  if (history) return history;
  const suggested = stored && canonicalCategory(stored.category);
  if (suggested && stored.source !== "KI" && suggested !== "Prüfen" && fitsSign(suggested, amount)) return { category: suggested, why: stored.source === "Historie" ? "wie frühere Buchungen" : "bekannte Regel" };
  const known = knownMerchantCategory(description, amount);
  if (known && canonicalCategory(known) !== "Prüfen" && fitsSign(known, amount)) return { category: canonicalCategory(known), why: "bekannter Händler" };
  const keyword = amount < 0 ? keywordCategories.find(([pattern]) => pattern.test(description)) : undefined;
  if (keyword) return { category: keyword[1], why: "erkannt am Namen" };
  if (suggested && suggested !== "Prüfen" && suggested !== "Sonstiges" && fitsSign(suggested, amount) &&
    (!feeCategories.test(suggested) || feeWords.test(description))) return { category: suggested, why: "KI-Vorschlag" };
  return undefined;
}

export type CleanupPlan = { operations: AssistantOperation[]; title: string; card: AssistantCard; count: number; open: number };

// Everything still waiting for a decision: the review list and bookings classified as "Prüfen".
export function cleanupPlan(state: AppState): CleanupPlan | string {
  const decisions: Extract<AssistantOperation, { op: "review_resolve" }>["decisions"] = [];
  const byCategory = new Map<Category, string[]>();
  const lines: Line[] = [];
  const unresolved: Line[] = [];
  for (const item of state.reviewQueue ?? []) {
    if (!isAiEligibleReview(item)) continue;
    const draft = item.draft;
    const stored = aiSuggestionFor(state, item.id);
    const found = guess(state, draft.description, draft.amount ?? 0, item.id, stored);
    const label = `${dateLabel(draft.date ?? "")} · ${draft.merchantAlias || draft.description}`.slice(0, 200);
    if (!found) { unresolved.push({ label, value: draft.amount ?? 0, detail: "bleibt offen", tone: "warn" }); continue; }
    decisions.push({ reviewId: item.id, category: found.category, ...(stored?.merchantAlias ? { merchantAlias: stored.merchantAlias } : {}) });
    lines.push({ label, value: draft.amount ?? 0, detail: `→ ${found.category} · ${found.why}` });
  }
  for (const row of state.transactions) {
    if (row.ignored || canonicalCategory(classify(row).category) !== "Prüfen") continue;
    const found = guess(state, row.merchantAlias || row.description, row.amount, row.id);
    const label = `${dateLabel(row.date)} · ${row.merchantAlias || row.description.slice(0, 60)}`.slice(0, 200);
    if (!found) { unresolved.push({ label, value: row.amount, detail: "bleibt offen", tone: "warn", transactionIds: [row.id] }); continue; }
    byCategory.set(found.category, [...(byCategory.get(found.category) ?? []), row.id]);
    lines.push({ label, value: row.amount, detail: `→ ${found.category} · ${found.why}`, transactionIds: [row.id] });
  }
  const groups = [...byCategory].sort((a, b) => b[1].length - a[1].length).slice(0, decisions.length ? 19 : 20);
  const operations: AssistantOperation[] = [
    ...(decisions.length ? [{ op: "review_resolve" as const, decisions: decisions.slice(0, 500) }] : []),
    ...groups.map(([category, ids]) => ({ op: "categorize" as const, ids: ids.slice(0, 2000), category, learn: false })),
  ];
  const count = decisions.length + groups.reduce((sum, [, ids]) => sum + ids.length, 0);
  if (!count && !unresolved.length) return "Es ist nichts offen – alle Buchungen sind zugeordnet. 🎉";
  const card: AssistantCard = { kind: "rule", title: `${count} von ${count + unresolved.length} offenen Buchungen zuordnen`, total: count,
    lines: [...lines, ...unresolved].slice(0, 40),
    transactionIds: groups.flatMap(([, ids]) => ids).slice(0, 50),
    note: unresolved.length ? `${unresolved.length} kann ich nicht sicher zuordnen. Sag mir z. B. „${unresolved[0].label.split(" · ")[1] ?? "Händler"} ist Lebensmittel“.` : "Alles mit einem Klick bestätigt und mit einem Klick rückgängig." };
  if (!count) return `Die ${unresolved.length} offenen Buchungen kann ich nicht sicher zuordnen. Sag mir einfach z. B. „${unresolved[0].label.split(" · ")[1] ?? "Händler"} ist Lebensmittel“.`;
  return { operations, title: `${count} offene Buchungen zuordnen`, card, count, open: unresolved.length };
}
