import { classify } from "@/lib/calc";
import { canonicalCategory } from "@/lib/categories";
import { dateLabel } from "@/lib/format";
import { matchesTransactionSearch } from "@/lib/transaction-tools";
import type { AppState, AssistantCard, AssistantOperation, Transaction } from "@/lib/types";
import { findPeriod } from "./answers";
import { parseAmount } from "./intent";

// Edits on existing bookings by chat: "Benenne BILLA DANKT in Billa um", "Nimm die Buchung vom 3.11. aus dem Plan",
// "Netflix ist Fixkosten", "Markier alle Billa-Buchungen als geprüft".
const planOut = /aus dem (?:monats)?plan\b|nicht (?:mehr )?(?:im|in den|zum) (?:monats)?plan\b|im (?:monats)?plan ignorier|nicht (?:mehr )?mit(?:zählen|zaehlen|rechnen)/;
const planIn = /(?:zurück|zurueck|wieder) in den (?:monats)?plan|in den (?:monats)?plan (?:auf)?nehmen|wieder mit(?:zählen|zaehlen|rechnen)/;
const fixedWord = /fix ?kosten|fixe kosten|fixkost/;
const fixedVerb = /\b(?:ist|sind|als|markier\w*|zähl\w*|zaehl\w*|kein\w*|nicht|mach\w*|setz\w*|gehör\w*|gehoer\w*)\b/;
const fixedOff = /\bkeine?\b|\bnicht\b|variabel/;
const reviewedWord = /\bgeprüft\b|\bgeprueft\b|abhak|\bhak\w*\b.*\bab\b|\bkontrolliert\b|ungeprüft|ungeprueft/;
const reviewedOff = /ungeprüft|ungeprueft|nicht (?:als )?geprüft|nicht (?:als )?geprueft/;
// "Ignorier die Buchung vom 3.11." drops bookings from every statistic; "im Plan ignorieren" stays a plan edit.
const ignoreOn = /\bignorier\w*|aus (?:der|den|allen) (?:statistik\w*|auswertung\w*)|in keiner (?:statistik|auswertung)/;
const ignoreOff = /nicht (?:mehr )?ignorier\w*|wieder (?:berücksichtig|beruecksichtig)\w*|wieder in (?:die|den) (?:statistik\w*|auswertung\w*)/;
const planIgnore = /(?:im|aus dem) (?:monats)?plan ignorier/;
const question = /^(?:wie|was|welche\w*|wo|wann|warum|wieso|weshalb|zeig mir|hab(?:e)? ich|sind|ist|gibt)\b|\?\s*$/;
const renamePatterns = [
  /^(?:bitte\s+)?(?:benenn\w*|nenn\w*)\s+(.+?)\s+in\s+[„"']?(.+?)[“"']?\s+um\s*[.!]?$/i,
  /^(?:bitte\s+)?(.+?)\s+in\s+[„"']?(.+?)[“"']?\s+umbenennen\s*[.!]?$/i,
  /^(.+?)\s+soll\s+(?:ab jetzt\s+|künftig\s+|in zukunft\s+)?(?:als\s+)?[„"']?(.+?)[“"']?\s+(?:heißen|heissen|angezeigt werden)\s*[.!]?$/i,
  /^(?:bitte\s+)?zeig\w*\s+(.+?)\s+(?:ab jetzt\s+|künftig\s+)?als\s+[„"']?(.+?)[“"']?\s+an\s*[.!]?$/i,
];
const fillers = new Set(["alle", "die", "der", "das", "den", "dem", "des", "buchung", "buchungen", "umsatz", "umsätze", "umsaetze", "zahlung", "zahlungen",
  "von", "vom", "bei", "am", "im", "in", "aus", "zum", "zur", "als", "ist", "sind", "nimm", "nehm", "bitte", "markier", "markiere", "markieren", "plan",
  "monatsplan", "fixkosten", "fix", "kosten", "fixe", "geprüft", "geprueft", "ungeprüft", "nicht", "mehr", "keine", "kein", "wieder", "zurück", "zurueck",
  "mach", "setz", "setze", "zähl", "zählen", "zaehlen", "mitzählen", "mitrechnen", "ab", "hak", "abhaken", "kontrolliert", "und", "auch", "mal", "doch",
  "jetzt", "immer", "eine", "einen", "ein", "mein", "meine", "meinen", "raus", "rein", "aufnehmen", "nehmen", "auf", "gehört", "gehoert", "zu", "variabel",
  "ignorieren", "ignorier", "euro", "€", "januar", "jänner", "februar", "feber", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober",
  "november", "dezember", "monat", "diesen", "letzten", "heuer", "seit", "es", "sie", "er", "dieser", "diese", "dieses", "ignoriere", "ignoriert",
  "statistik", "statistiken", "auswertung", "auswertungen", "berücksichtigen", "beruecksichtigen", "keiner", "allen"]);

export function renameRequest(text: string): { target: string; alias: string } | undefined {
  for (const pattern of renamePatterns) {
    const match = pattern.exec(text.trim());
    if (match && match[2].trim().length >= 2) return { target: match[1].replace(/^(?:alle|die|der|das|den)\s+(?:buchungen\s+)?(?:von\s+|vom\s+)?/i, "").trim(),
      alias: match[2].trim().replace(/^(?:„|")|(?:“|")$/g, "").slice(0, 200) };
  }
  return undefined;
}

// `known`: the text names an existing goal or planned expense, which the edit tool handles instead.
export function bookingRequest(text: string, known: boolean): boolean {
  const lower = text.toLowerCase().trim();
  if (question.test(lower)) return false;
  const bookingWord = /\b(?:buchung|buchungen|umsatz|umsätze|umsaetze|zahlung|zahlungen)\b/.test(lower);
  if ((ignoreOn.test(lower) || ignoreOff.test(lower)) && !planIgnore.test(lower) && (!known || bookingWord)) return true;
  if ((planOut.test(lower) || planIn.test(lower)) && (!known || bookingWord)) return true;
  if (fixedWord.test(lower) && fixedVerb.test(lower) && !/\bwie ?viel\b|\bwelche\b/.test(lower)) return true;
  if (reviewedWord.test(lower) && /markier|\bals\b|abhak|\bhak|\bsetz/.test(lower)) return true;
  return !known && renameRequest(text) !== undefined;
}

const dateIn = (text: string, asOf: string) => {
  const match = /\b(?:vom|am|den)\s+(\d{1,2})\.\s?(\d{1,2})\.?(?:\s?(20\d{2}|\d{2})\b)?/.exec(text);
  if (!match) return undefined;
  const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : asOf.slice(0, 4);
  const date = `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  // Without a year a date after today means last year.
  return !match[3] && date > asOf ? `${Number(year) - 1}${date.slice(4)}` : date;
};
const amountIn = (text: string) => {
  const match = /(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\s*(?:€|euro)/i.exec(text);
  return match ? parseAmount(`${match[1]}${match[2] ? `,${match[2]}` : ""}`) : undefined;
};

// The merchant is the longest run of words (up to 3) that actually appears in the bookings.
function findTarget(rows: Transaction[], text: string): string | undefined {
  const words = text.replace(/[„“"'.,!?:;()]/g, " ").replace(/-buchung\w*/gi, " ").split(/\s+/).filter(Boolean);
  for (let size = 3; size >= 1; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      const part = words.slice(start, start + size);
      if (part.some((word) => fillers.has(word.toLowerCase()) || /^\d/.test(word))) continue;
      const name = part.join(" ");
      if (name.length >= 3 && rows.some((row) => matchesTransactionSearch(row, name))) return name;
    }
  }
  return undefined;
}

export type BookingPlan = { operations: AssistantOperation[]; title: string; card: AssistantCard; count: number };

export function bookingEdit(state: AppState, text: string, asOf: string, hint?: string): BookingPlan | string {
  const lower = text.toLowerCase();
  const rename = renameRequest(text);
  const update: Extract<AssistantOperation, { op: "transaction_update" }> = { op: "transaction_update", ids: ["pending"] };
  if (rename) update.alias = rename.alias;
  else if (ignoreOff.test(lower)) update.ignored = false;
  else if (ignoreOn.test(lower) && !planIgnore.test(lower)) update.ignored = true;
  else {
    if (planIn.test(lower)) update.includeInPlan = true;
    else if (planOut.test(lower)) update.includeInPlan = false;
    if (fixedWord.test(lower)) update.fixedCost = !fixedOff.test(lower);
    if (reviewedWord.test(lower)) update.reviewed = !reviewedOff.test(lower);
  }
  if (Object.keys(update).length === 2) return "Was soll ich an den Buchungen ändern? Zum Beispiel „Benenne BILLA DANKT in Billa um“, „Netflix ist Fixkosten“ oder „Nimm die Buchung vom 3.11. aus dem Plan“ oder „Ignorier die Buchung vom 3.11.“.";
  const scope = rename ? rename.target : text;
  const date = dateIn(scope, asOf);
  const amount = amountIn(scope);
  const merchant = (hint && state.transactions.some((row) => matchesTransactionSearch(row, hint)) ? hint : undefined) ??
    findTarget(state.transactions, rename ? rename.target : text.replace(/\b(?:vom|am|den)\s+\d{1,2}\.\s?\d{1,2}\.?(?:\s?\d{2,4})?/g, " "));
  const period = !date && /\b(?:im|in|seit|letzten|diesen|heuer|20\d\d)\b/.test(lower) ? findPeriod(scope, asOf) : undefined;
  if (!merchant && !date && amount === undefined)
    return rename ? `Ich finde keine Buchungen mit „${rename.target}“. Wie steht der Händler in den Umsätzen?` : "Welche Buchungen meinst du? Nenne den Händler, ein Datum (z. B. „vom 3.11.“) oder einen Betrag.";
  const rows = state.transactions.filter((row) => (!merchant || matchesTransactionSearch(row, merchant)) &&
    (!date || row.date === date) && (amount === undefined || Math.abs(Math.abs(row.amount) - amount) < 0.005) &&
    (!period || row.date >= period.from && row.date <= period.to))
    .sort((a, b) => b.date.localeCompare(a.date));
  const what = [merchant && `„${merchant}“`, date && `vom ${dateLabel(date)}`, amount !== undefined && `über ${amount.toLocaleString("de-AT", { minimumFractionDigits: 2 })} €`]
    .filter(Boolean).join(" ");
  if (!rows.length) return `Ich finde keine Buchung ${what}.`;
  update.ids = rows.slice(0, 2000).map((row) => row.id);
  const action = update.alias ? `als „${update.alias}“ anzeigen` : update.ignored ? "ignorieren (zählt in keiner Statistik)"
    : update.ignored === false ? "wieder berücksichtigen" : update.includeInPlan === false ? "aus dem Monatsplan nehmen"
    : update.includeInPlan ? "wieder in den Monatsplan nehmen" : update.fixedCost === true ? "als Fixkosten markieren" : update.fixedCost === false ? "nicht mehr als Fixkosten zählen"
    : update.reviewed === false ? "als ungeprüft markieren" : "als geprüft markieren";
  const count = rows.length;
  const card: AssistantCard = { kind: "answer", title: `${count === 1 ? "1 Buchung" : `${count} Buchungen`} ${what}`.slice(0, 200), total: Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100,
    lines: rows.slice(0, 12).map((row) => ({ label: `${dateLabel(row.date)} · ${row.merchantAlias || row.description.slice(0, 60)}`.slice(0, 200), value: row.amount,
      detail: [canonicalCategory(classify(row).category), row.includeInPlan ? "im Plan" : "nicht im Plan", row.fixedCost ? "Fixkosten" : "", row.reviewed ? "geprüft" : "", row.ignored ? "ignoriert" : ""]
        .filter(Boolean).join(" · "), transactionIds: [row.id] })),
    transactionIds: update.ids.slice(0, 50),
    note: update.alias ? "Nur der Anzeigename ändert sich, Beschreibung und Kategorie bleiben gleich."
      : update.ignored ? "Die Buchungen bleiben in den Umsätzen und im Kontostand, zählen aber in keiner Statistik, keinem Budget und keiner Auswertung mehr." : undefined };
  return { operations: [update], title: `${count === 1 ? "Buchung" : `${count} Buchungen`} ${action}`.slice(0, 120), card, count };
}
