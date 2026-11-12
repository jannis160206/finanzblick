import { classify } from "@/lib/calc";
import { canonicalCategory } from "@/lib/categories";
import { currency, dateLabel } from "@/lib/format";
import type { AppState, AssistantCard, AssistantOperation, Transaction } from "@/lib/types";
import { findPeriod } from "./answers";
import { amountIn, dateIn, findTarget } from "./bookings";

/**
 * Deleting and tagging bookings by chat, like "Umsatz löschen" and the tag dialog in the ledger. Deleting needs a
 * clearly named booking and is capped, so the chat never wipes many bookings at once.
 */
export type BookingActionPlan = { operations: AssistantOperation[]; title: string; card: AssistantCard } | { text: string; choices?: string[] };

const MAX_DELETE = 10;
const bookingWord = /(?:buchung|umsatz|umsätze|umsaetze|zahlung|abbuchung|überweisung|ueberweisung)\w*/i;
const removeTag = /\b(?:entfern|lösch|loesch|nimm)\w*\s+(?:den\s+|das\s+)?(?:tag|hashtag|schlagwort)\s+[„"#]?([\p{L}\p{N}][\p{L}\p{N} _-]{0,39}?)[“"]?(?=\s*(?:$|[.!?,]|\s(?:von|bei|aus|vom|an|für|fuer)\b))/iu;
const addTag = [
  /\bmit\s+(?:dem\s+)?(?:tag|hashtag|schlagwort)\s+[„"#]?([\p{L}\p{N}][\p{L}\p{N} _-]{0,39}?)[“"]?(?=\s*(?:$|[.!?,]|\s(?:von|bei|für|fuer|vom|im|zu|an)\b))/iu,
  /\b(?:den|einen)\s+(?:tag|hashtag|schlagwort)\s+[„"#]?([\p{L}\p{N}][\p{L}\p{N} _-]{0,39}?)[“"]?(?=\s*(?:$|[.!?,]|\s(?:von|bei|für|fuer|vom|im|zu|an|hinzu)\b))/iu,
  /\btagg\w*\b.*?\b(?:mit|als)\s+[„"#]?([\p{L}\p{N}][\p{L}\p{N} _-]{0,39}?)[“"]?\s*[.!]?$/iu,
  /#([\p{L}\p{N}][\p{L}\p{N}_-]{0,39})/u,
];

export type BookingAction = "delete" | "tag" | "untag";
export function bookingActionRequest(text: string): BookingAction | undefined {
  const lower = text.toLowerCase();
  if (/\?\s*$/.test(lower) || /^(?:wie|was|welche\w*|wann|warum|hab(?:e)? ich|zeig)\b/.test(lower)) return undefined;
  if (removeTag.test(text)) return "untag";
  if (addTag.some((pattern) => pattern.test(text)) && (bookingWord.test(lower) || /#|\btagg/.test(lower))) return "tag";
  if (/\b(?:lösch|loesch|entfern)\w*\b/.test(lower) && bookingWord.test(lower) && !/\b(?:position|vertrag|abo|sparziel|regel|kontoregel)\b/.test(lower)) return "delete";
  return undefined;
}

// "vom 10. bis 15.8.", "10.–15.8.2026": a range of days.
function rangeIn(text: string, asOf: string): { from: string; to: string } | undefined {
  const match = /\b(?:vom\s+)?(\d{1,2})\.(?:\s?(\d{1,2})\.)?\s*(?:bis|-|–)\s*(?:zum\s+)?(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(20\d{2}))?/.exec(text);
  if (!match) return undefined;
  const year = match[5] ?? asOf.slice(0, 4);
  const pad = (value: string) => value.padStart(2, "0");
  const from = `${year}-${pad(match[2] ?? match[4])}-${pad(match[1])}`;
  const to = `${year}-${pad(match[4])}-${pad(match[3])}`;
  if (from > to) return undefined;
  return !match[5] && from > asOf ? { from: `${Number(year) - 1}${from.slice(4)}`, to: `${Number(year) - 1}${to.slice(4)}` } : { from, to };
}

const label = (row: Transaction) => `${dateLabel(row.date)} · ${row.merchantAlias || row.description.slice(0, 60)}`.slice(0, 200);
function card(rows: Transaction[], title: string): AssistantCard {
  return { kind: "answer", title: title.slice(0, 200), total: Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100,
    lines: rows.slice(0, 12).map((row) => ({ label: label(row), value: row.amount, detail: [canonicalCategory(classify(row).category), ...(row.tags ?? []).map((tag) => `#${tag}`)].join(" · ").slice(0, 300),
      transactionIds: [row.id] })), transactionIds: rows.slice(0, 50).map((row) => row.id) };
}

function select(state: AppState, text: string, asOf: string, hint?: string): { rows: Transaction[]; what: string; specific: boolean } {
  const range = rangeIn(text, asOf);
  const date = range ? undefined : dateIn(text, asOf);
  const amount = amountIn(text);
  const scrubbed = text.replace(/\b(?:vom\s+)?\d{1,2}\.(?:\s?\d{1,2}\.)?\s*(?:bis|-|–)\s*(?:zum\s+)?\d{1,2}\.\s?\d{1,2}\.(?:\s?20\d{2})?/g, " ")
    .replace(/\b(?:vom|am|den)\s+\d{1,2}\.\s?\d{1,2}\.?(?:\s?\d{2,4})?/g, " ").replace(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,\d{1,2})?\s*(?:€|euro)/gi, " ");
  const merchant = (hint && state.transactions.some((row) => row.description.toLowerCase().includes(hint.toLowerCase())) ? hint : undefined) ?? findTarget(state.transactions, scrubbed);
  const period = !range && !date && /\b(?:im|in|seit|letzten|diesen|heuer|20\d\d)\b/i.test(text) ? findPeriod(text, asOf) : undefined;
  const rows = state.transactions.filter((row) => (!merchant || row.description.toLowerCase().includes(merchant.toLowerCase()) || (row.merchantAlias ?? "").toLowerCase().includes(merchant.toLowerCase())) &&
    (!date || row.date === date) && (!range || row.date >= range.from && row.date <= range.to) &&
    (amount === undefined || Math.abs(Math.abs(row.amount) - amount) < 0.005) && (!period || row.date >= period.from && row.date <= period.to))
    .sort((a, b) => b.date.localeCompare(a.date));
  const what = [merchant && `„${merchant}“`, date && `vom ${dateLabel(date)}`, range && `vom ${dateLabel(range.from)} bis ${dateLabel(range.to)}`,
    period && !date && !range && period.label, amount !== undefined && `über ${currency(amount)}`].filter(Boolean).join(" ");
  return { rows, what, specific: !!(merchant || date || range || period || amount !== undefined) };
}

/** "Lösch die Buchung vom 3.8. bei MediaMarkt", "Tagge die Buchungen vom 10. bis 15.8. mit Malaga 2026". */
export function bookingAction(state: AppState, text: string, asOf: string, hint?: string): BookingActionPlan {
  const action = bookingActionRequest(text);
  if (!action) return { text: "Was soll ich mit den Buchungen machen? Zum Beispiel „Lösch die Buchung vom 3.8. über 249 €“ oder „Tagge die Buchungen vom 10. bis 15.8. mit Malaga 2026“." };
  if (action === "delete") {
    const { rows, what, specific } = select(state, text, asOf, hint);
    if (!specific) return { text: "Welche Buchung soll ich löschen? Nenne den Händler und das Datum oder den Betrag, zum Beispiel „Lösch die Buchung vom 3.8. über 249 €“." };
    if (!rows.length) return { text: `Ich finde keine Buchung ${what}.` };
    const all = /\b(?:alle|beide|sämtliche)\b/i.test(text);
    if (rows.length > 1 && !all) return { text: `Ich finde ${rows.length} Buchungen ${what}. Welche soll ich löschen?`,
      choices: rows.slice(0, 4).map((row) => `Lösch die Buchung vom ${dateLabel(row.date)} über ${currency(Math.abs(row.amount))}`) };
    if (rows.length > MAX_DELETE) return { text: `Das wären ${rows.length} Buchungen. Löschen kann ich im Chat höchstens ${MAX_DELETE} auf einmal – bitte grenz es ein, oder blende sie mit „Ignorier …“ aus der Statistik aus.` };
    const title = rows.length === 1 ? `Buchung ${label(rows[0])} löschen` : `${rows.length} Buchungen ${what} löschen`;
    return { operations: [{ op: "transaction_delete", ids: rows.map((row) => row.id) }], title: title.slice(0, 120),
      card: { ...card(rows, `${rows.length === 1 ? "1 Buchung" : `${rows.length} Buchungen`} ${what}`), note: "Gelöschte Buchungen fallen aus allen Berechnungen; Rückgängig machen geht unter „Änderungen“." } };
  }
  const tag = (action === "untag" ? removeTag.exec(text)?.[1] : addTag.map((pattern) => pattern.exec(text)?.[1]).find(Boolean))?.trim();
  if (!tag) return { text: "Welchen Tag soll ich setzen? Zum Beispiel „Tagge die Buchungen vom 10. bis 15.8. mit Malaga 2026“." };
  const rest = text.replace(tag, " ").replace(/#/g, " ");
  const { rows: found, what, specific } = select(state, rest, asOf, hint);
  const rows = action === "untag" && !specific ? state.transactions.filter((row) => (row.tags ?? []).some((entry) => entry.toLowerCase() === tag.toLowerCase())) : found;
  if (!specific && action === "tag") return { text: `Welche Buchungen sollen den Tag „${tag}“ bekommen? Nenne einen Zeitraum, ein Datum oder den Händler, z. B. „vom 10. bis 15.8.“.` };
  if (!rows.length) return { text: action === "untag" ? `Keine Buchung ${what || ""} hat den Tag „${tag}“.`.replace(/\s+/g, " ") : `Ich finde keine Buchung ${what}.` };
  const ids = rows.slice(0, 2000).map((row) => row.id);
  return { operations: [{ op: "transaction_tag", ids, tag, ...(action === "untag" ? { remove: true } : {}) }],
    title: `${action === "untag" ? "Tag entfernen" : "Tag setzen"}: #${tag}`.slice(0, 120),
    card: card(rows, `${rows.length === 1 ? "1 Buchung" : `${rows.length} Buchungen`} ${what || `mit #${tag}`}`) };
}
