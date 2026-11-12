import { addMonths, round, type Dashboard } from "@/lib/calc";
import { canonicalCategory, categories, type Category } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { detectDuplicateCharges, detectSubscriptions, forecastMonth, ledger } from "@/lib/insights";
import { contractSummary, detectContracts } from "@/lib/contracts";
import { plannedOccurrences } from "@/lib/planned-one-offs";
import { openReviewCount } from "@/lib/import/review";
import { matchesTransactionSearch, normalizeSearch } from "@/lib/transaction-tools";
import type { AppState, AssistantCard, Transaction } from "@/lib/types";
import { reminderLines } from "./extras";
import { kzLabel, TAX_FOLDER_NOTE, taxFolder } from "@/lib/tax-folder";
import { buildChart, shortMonth } from "./chart";
import { accountForecast } from "./forecast";

type Line = AssistantCard["lines"][number];
const DAY_MS = 86_400_000;
const pad = (value: number) => String(value).padStart(2, "0");
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const monthEnd = (month: string) => {
  const [year, value] = month.split("-").map(Number);
  return `${month}-${pad(new Date(Date.UTC(year, value, 0)).getUTCDate())}`;
};
const merchantOf = (row: Transaction) => row.merchantAlias?.trim() || row.description.trim().slice(0, 60);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const list = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} und ${items.at(-1)}` : items[0] ?? "";

const monthWords: [string, number][] = [
  ["jänner", 1], ["jaenner", 1], ["januar", 1], ["februar", 2], ["feber", 2], ["märz", 3], ["maerz", 3], ["april", 4], ["mai", 5],
  ["juni", 6], ["juli", 7], ["august", 8], ["september", 9], ["oktober", 10], ["november", 11], ["dezember", 12],
];
const numberWords: Record<string, number> = { zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12 };

export type Period = { from: string; to: string; label: string; month?: string; months: number };

const dayPattern = "(\\d{1,2})\\.\\s?(\\d{1,2})(?:\\.(?:\\s?(\\d{4}|\\d{2})\\b)?)?(?![\\d,])";
// "11.10." → the latest such day up to today; an explicit year is kept.
function pastDay(day: string, month: string, year: string | undefined, today: string): string | undefined {
  const d = Number(day), m = Number(month);
  if (d < 1 || d > 31 || m < 1 || m > 12) return undefined;
  const y = year ? Number(year.length === 2 ? `20${year}` : year) : Number(today.slice(0, 4));
  let date = `${y}-${pad(m)}-${pad(d)}`;
  if (!year && date > today) date = `${y - 1}-${pad(m)}-${pad(d)}`;
  return date;
}
const shortDate = (date: string) => `${Number(date.slice(8))}.${Number(date.slice(5, 7))}.`;

// Explicit day ranges: "seit 11.10.", "ab dem 11.10", "vom 1.10. bis 15.10.", "11.10-aktuell".
export function parseDateRange(text: string, today: string): Period | undefined {
  const lower = text.toLowerCase();
  const span = new RegExp(`(?:\\b(?:vom|von|zwischen)\\s+(?:dem\\s+)?)?${dayPattern}\\s*(?:-|–|bis(?:\\s+(?:zum|einschließlich))?|und)\\s*(?:(?:dem\\s+)?${dayPattern}|(heute|jetzt|aktuell|now))`).exec(lower);
  if (span) {
    const from = pastDay(span[1], span[2], span[3], today);
    const to = span[7] ? today : pastDay(span[4], span[5], span[6] ?? span[3], today);
    if (from && to && from <= to) {
      const months = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / (30.4 * DAY_MS)));
      return { from, to, label: span[7] ? `seit ${shortDate(from)}` : `${shortDate(from)}–${shortDate(to)}`, months };
    }
  }
  const since = new RegExp(`\\b(?:seit|ab)\\s+(?:dem\\s+|am\\s+)?${dayPattern}`).exec(lower);
  if (since) {
    const from = pastDay(since[1], since[2], since[3], today);
    if (from && from <= today) return { from, to: today, label: `seit ${shortDate(from)}`,
      months: Math.max(1, Math.round((Date.parse(today) - Date.parse(from)) / (30.4 * DAY_MS))) };
  }
  const single = new RegExp(`\\bam\\s+${dayPattern}`).exec(lower);
  if (single) {
    const date = pastDay(single[1], single[2], single[3], today);
    if (date) return { from: date, to: date, label: `am ${shortDate(date)}`, months: 1 };
  }
  return undefined;
}

const monthPeriodOf = (month: string, today: string): Period => ({ from: `${month}-01`, to: monthEnd(month) < today ? monthEnd(month) : today,
  label: monthLabel(month), month, months: 1 });
const yearPeriodOf = (value: number, today: string): Period => {
  const year = Number(today.slice(0, 4));
  return { from: `${value}-01-01`, to: value === year ? today : `${value}-12-31`,
    label: value === year ? `${value} bis heute` : String(value), months: value === year ? Number(today.slice(5, 7)) : 12 };
};

// Questions look back: a month without a year means its latest occurrence up to today.
export function parsePeriod(text: string, today: string): Period {
  return findPeriod(text, today) ?? yearPeriodOf(Number(today.slice(0, 4)), today);
}

// Like parsePeriod, but undefined when the text names no period, so follow-up questions can keep the previous one.
export function findPeriod(text: string, today: string): Period | undefined {
  const range = parseDateRange(text, today);
  if (range) return range;
  const lower = text.toLowerCase();
  const year = Number(today.slice(0, 4));
  const current = today.slice(0, 7);
  const day = (offset: number, label: string): Period => ({ from: shiftDate(today, offset), to: shiftDate(today, offset), label, months: 1 });
  if (/\bvorgestern\b/.test(lower)) return day(-2, "vorgestern");
  if (/\bgestern\b/.test(lower)) return day(-1, "gestern");
  if (/(?<!\bbis\s)\bheute\b/.test(lower) && !/\bbis\s+heute\b/.test(lower)) return day(0, "heute");
  const lastDays = /\b(?:letzten|vergangenen)\s+(\d{1,2}|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+tage/.exec(lower);
  if (lastDays) {
    const count = Math.min(90, numberWords[lastDays[1]] ?? Number(lastDays[1]));
    return { from: shiftDate(today, -count + 1), to: today, label: `letzte ${count} Tage`, months: 1 };
  }
  const monthPeriod = (month: string) => monthPeriodOf(month, today);
  const yearPeriod = (value: number) => yearPeriodOf(value, today);
  if (/wochenende/.test(lower)) {
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const saturday = weekday >= 5 ? shiftDate(today, 5 - weekday) : shiftDate(today, -weekday - 2);
    const last = /\b(?:letzte[ns]?|vorige[ns]?|vergangene[ns]?)\s+wochenende/.test(lower) && weekday >= 5;
    const from = last ? shiftDate(saturday, -7) : saturday;
    const to = shiftDate(from, 1) > today ? today : shiftDate(from, 1);
    return { from, to, label: last || weekday < 5 ? "letztes Wochenende" : "dieses Wochenende", months: 1 };
  }
  if (/\b(?:diese|dieser)\s+woche\b/.test(lower)) {
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    return { from: shiftDate(today, -weekday), to: today, label: "diese Woche", months: 1 };
  }
  if (/\b(?:letzte|letzten|vorige|vorigen)\s+woche\b/.test(lower)) {
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    return { from: shiftDate(today, -weekday - 7), to: shiftDate(today, -weekday - 1), label: "letzte Woche", months: 1 };
  }
  const lastMonths = /\b(?:letzten|vergangenen)\s+(\d{1,2}|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)\s+monat/.exec(lower);
  if (lastMonths) {
    const count = Math.min(24, numberWords[lastMonths[1]] ?? Number(lastMonths[1]));
    return { from: `${addMonths(current, -count)}-01`, to: today, label: `letzte ${count} Monate`, months: count };
  }
  if (/\b(?:diesen|diesem|dieser|laufenden|aktuellen)\s+monat\b/.test(lower)) return monthPeriod(current);
  if (/\b(?:letzten|letzter|vorigen|voriger|vergangenen)\s+monat\b|\bvormonat\b/.test(lower)) return monthPeriod(addMonths(current, -1));
  if (/\b(?:letztes|letzten|voriges|vorigen|vergangenes)\s+jahr\b|\bvorjahr\b/.test(lower)) return yearPeriod(year - 1);
  const since = new RegExp(`\\bseit\\s+(${monthWords.map(([word]) => word).join("|")})\\b`).exec(lower);
  for (const [word, value] of monthWords) {
    const match = new RegExp(`\\b${word}\\b(?:\\s+(20\\d{2}))?`).exec(lower);
    if (!match) continue;
    const explicit = match[1] ? Number(match[1]) : undefined;
    let month = `${explicit ?? year}-${pad(value)}`;
    if (!explicit && month > current) month = `${year - 1}-${pad(value)}`;
    if (since && since[1] === word) {
      const months = (Number(current.slice(0, 4)) - Number(month.slice(0, 4))) * 12 + Number(current.slice(5)) - Number(month.slice(5)) + 1;
      return { from: `${month}-01`, to: today, label: `seit ${monthLabel(month)}`, months };
    }
    return monthPeriod(month);
  }
  const explicitYear = /\b(20\d{2})\b/.exec(lower);
  if (explicitYear && Number(explicitYear[1]) <= year) return yearPeriod(Number(explicitYear[1]));
  if (/\bheuer\b|\bdieses\s+jahr\b|\bdiesem\s+jahr\b/.test(lower)) return yearPeriod(year);
  return undefined;
}

// Months named in the text, in reading order: "Oktober mit September" → [Oktober, September].
export function monthsIn(text: string, today: string): Period[] {
  const lower = text.toLowerCase();
  const year = Number(today.slice(0, 4));
  const current = today.slice(0, 7);
  const found: { index: number; month: string }[] = [];
  for (const [word, value] of monthWords) {
    for (const match of lower.matchAll(new RegExp(`\\b${word}\\b(?:\\s+(20\\d{2}))?`, "g"))) {
      const explicit = match[1] ? Number(match[1]) : undefined;
      let month = `${explicit ?? year}-${pad(value)}`;
      if (!explicit && month > current) month = `${year - 1}-${pad(value)}`;
      found.push({ index: match.index ?? 0, month });
    }
  }
  if (/\b(?:diesen|diesem|dieser|laufenden|aktuellen)\s+monat\b/.exec(lower)) found.push({ index: lower.search(/\b(?:diesen|diesem|dieser|laufenden|aktuellen)\s+monat\b/), month: current });
  if (/\b(?:letzten|letzter|vorigen|voriger|vergangenen)\s+monat\b|\bvormonat\b/.test(lower))
    found.push({ index: lower.search(/\b(?:letzten|letzter|vorigen|voriger|vergangenen)\s+monat\b|\bvormonat\b/), month: addMonths(current, -1) });
  const seen = new Set<string>();
  return found.sort((a, b) => a.index - b.index).filter(({ month }) => !seen.has(month) && seen.add(month)).map(({ month }) => monthPeriodOf(month, today));
}

const eating: Category[] = ["Lebensmittel", "Mittagessen", "Restaurants", "Lieferdienste", "Cafés & Snacks"];
const categoryWords: [RegExp, Category[], string][] = [
  [/essen gehen|auswärts essen|restaurant|lokal/, ["Restaurants"], "Restaurants"],
  [/lieferdienst|lieferung|essen bestellen/, ["Lieferdienste"], "Lieferdienste"],
  [/lebensmittel|supermarkt|einkäufe|einkaufen|groceries/, ["Lebensmittel"], "Lebensmittel"],
  [/kaffee|café|cafe|snack/, ["Cafés & Snacks"], "Cafés & Snacks"],
  [/mittagessen|\bmittag\b/, ["Mittagessen"], "Mittagessen"],
  [/\bessen\b|verpflegung|ernährung|\bfood\b/, eating, "Essen"],
  [/\babos?\b|abonnement/, ["Abonnements"], "Abonnements"],
  [/tanken|getankt|sprit|benzin|diesel/, ["Tanken", "Mobilität"], "Tanken"],
  [/öffis|öffentlich|\bzug\b|\bbahn\b|\bbus\b/, ["Öffentliche Verkehrsmittel"], "Öffis"],
  [/parken|maut|vignette/, ["Parken & Maut"], "Parken & Maut"],
  [/\bauto\b|mobilität|fahrzeug/, ["Mobilität", "Tanken", "Parken & Maut", "Fahrzeugwartung", "Leasing"], "Auto & Mobilität"],
  [/\bmiete\b/, ["Miete"], "Miete"],
  [/strom|energie|nebenkosten|heizung|\bgas\b/, ["Energie & Nebenkosten"], "Energie & Nebenkosten"],
  [/wohnen|haushalt|möbel|einrichtung/, ["Wohnen & Haushalt", "Möbel & Einrichtung", "Reparaturen & Instandhaltung"], "Wohnen & Haushalt"],
  [/versicherung/, ["Versicherungen"], "Versicherungen"],
  [/handy|internet|telefon/, ["Telefon & Internet"], "Telefon & Internet"],
  [/shopping|kleidung|klamotten|elektronik|online.?shop/, ["Shopping"], "Shopping"],
  [/urlaub|reise|flug|hotel/, ["Urlaub"], "Urlaub"],
  [/sport|fitness|\bgym\b/, ["Sport & Fitness"], "Sport & Fitness"],
  [/freizeit|hobby|hobbys/, ["Freizeit", "Entertainment"], "Freizeit"],
  // Streaming services are booked as subscriptions.
  [/streaming|musikabo|serienabo/, ["Abonnements", "Entertainment"], "Streaming"],
  [/entertainment|kino|games|spiele/, ["Entertainment"], "Entertainment"],
  [/gesundheit|apotheke|\barzt\b/, ["Gesundheit"], "Gesundheit"],
  [/drogerie/, ["Drogerie"], "Drogerie"],
  [/körperpflege|friseur|frisör|barber/, ["Körperpflege"], "Körperpflege"],
  [/geschenk|spende/, ["Geschenke & Spenden"], "Geschenke & Spenden"],
  [/weiterbildung|fortbildung|bildung|\bkurs|bücher/, ["Bildung", "Weiterbildung"], "Bildung"],
  [/haustier|katze|hund/, ["Haustiere"], "Haustiere"],
  [/gebühr/, ["Bankgebühren", "Rücklastschriftgebühren"], "Gebühren"],
  [/guthaben/, ["Guthabenkarten"], "Guthabenkarten"],
];

// Fuel stations are classified as Mobilität, so "Tanken" also searches there.
const widerCategories: Partial<Record<Category, Category[]>> = { Tanken: ["Tanken", "Mobilität"] };

export function findCategories(text: string): { categories: Category[]; label: string } | undefined {
  const plain = normalizeSearch(text);
  const exact = [...categories].sort((a, b) => b.length - a.length).find((category) => {
    const name = normalizeSearch(category);
    return plain.includes(name) || (name.length > 5 && plain.includes(name.slice(0, -1)));
  });
  if (exact) return { categories: widerCategories[exact] ?? [exact], label: exact };
  const lower = text.toLowerCase();
  const match = categoryWords.find(([pattern]) => pattern.test(lower));
  return match ? { categories: match[1], label: match[2] } : undefined;
}

const nonMerchant = /^(?:essen|lebensmittel|abos?|monat|jahr|woche|heuer|urlaub|auto|miete|tanken|kaffee|shopping|kategorie|ausgaben|einnahmen|mich|mir|das|die|der|den|dem|ein|eine|amex|american|express|kreditkarte|karte|revolut|raiffeisen|giro|girokonto|konto|trade|republic|seit|heute|aktuell|geld|euro|eur|buchungen|buchung|zahlungen|sachen|zeug|alle|alles)$/i;

const banks: [RegExp, RegExp, string][] = [
  [/\bamex\b|american express|kreditkarte/, /^(?:amex|american express)$/i, "Amex"],
  [/\brevolut\b/, /^revolut$/i, "Revolut"],
  [/raiffeisen|girokonto|\bgiro\b/, /^raiffeisen/i, "Raiffeisen"],
  [/trade republic|\btr\b/, /^trade republic$/i, "Trade Republic"],
];
// "mit Amex bezahlt", "vom Revolut-Konto": the paying account, not a merchant.
export function findBank(text: string): { pattern: RegExp; label: string } | undefined {
  const lower = text.toLowerCase();
  const match = banks.find(([words]) => words.test(lower));
  return match ? { pattern: match[1], label: match[2] } : undefined;
}
const fillers = /^(?:mein\w*|dein\w*|unser\w*|was|wen|wem|alles|diese[nmrs]?|letzte[nmrs]?|vorige[nmrs]?|im|in|den|das|die|der|ein\w*|essen\w*|sonstiges|sachen|zeug|mich|mir|uns|heuer|immer|insgesamt|gesamt|jetzt|noch|schon)$/i;
// "für Lieferando", "bei Hofer": a named shop the bookings don't know.
function unknownName(text: string) {
  for (const match of text.matchAll(/\b(?:bei|beim|für|fuer|koste[tn] mich|kosten mich)\s+([A-Za-zÄÖÜäöü][\w&.'+-]{2,})/g)) {
    const name = match[1].replace(/[.,!?]+$/, "");
    if (fillers.test(name) || nonMerchant.test(name) || monthWords.some(([word]) => word === name.toLowerCase()) || findCategories(name) || findBank(name)) continue;
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return undefined;
}

// A merchant only counts when it really appears in bookings.
export function findMerchant(state: AppState, text: string, hint?: string): string | undefined {
  const rows = state.transactions;
  const candidates: string[] = [];
  if (hint) candidates.push(hint);
  for (const match of text.matchAll(/\b(?:bei|an|für|fuer|von|auf)\s+([A-Za-zÄÖÜäöü0-9][\w&.'+-]*(?:\s+[A-ZÄÖÜ][\w&.'+-]*)?)/g)) candidates.push(match[1]);
  for (const match of text.matchAll(/(?<=\s)([A-ZÄÖÜ][\w&.'+-]{2,})/g)) candidates.push(match[1]);
  for (const candidate of candidates) {
    const name = candidate.replace(/[.,!?]+$/, "").trim();
    if (name.length < 2 || nonMerchant.test(name) || monthWords.some(([word]) => word === name.toLowerCase()) || findCategories(name)) continue;
    if (rows.some((row) => matchesTransactionSearch(row, name))) return name;
    const first = name.split(/\s+/)[0];
    if (first !== name && first.length >= 3 && !nonMerchant.test(first) && rows.some((row) => matchesTransactionSearch(row, first))) return first;
  }
  return undefined;
}

type QueryMetric = "saved" | "merchants" | "fixed" | "duplicates" | "subscriptions" | "largest" | "income" | "count" | "average" | "breakdown" | "compare" | "trend" | "sum";
export const trendPattern = /entwickelt|entwicklung|verlauf|\btrend\b|monat für monat|monat fuer monat|jeden monat|über die (?:letzten )?monate|ueber die monate|monatsverlauf|von monat zu monat/;
export const comparePattern = /vergleich|verglichen|gegenüber|\bvs\.?(?=\s)|\bversus\b|mehr oder weniger|(?:mehr|weniger|besser|schlechter|sparsamer)\b[^?.!]{0,30}?\bals (?:im |in |letzten |vorigen |den |der )?(?:vormonat|monat davor|letzten monat|vorigen monat|(?:letzten|vorigen)(?=\s*[?.!]*$)|jänner|januar|februar|feber|märz|april|mai|juni|juli|august|september|oktober|november|dezember)/;
export function queryMetric(text: string): QueryMetric {
  const lower = text.toLowerCase();
  if (/gespart|übrig geblieben|uebrig geblieben|zurückgelegt|zurueckgelegt/.test(lower)) return "saved";
  if (/welche[rnms]? (?:händler|haendler|geschäft|geschaeft|laden|shop|firma|anbieter)|bei wem\b|wo (?:kaufe|kauf) ich am meisten/.test(lower)) return "merchants";
  if (/fixkosten|fixe kosten|laufenden kosten/.test(lower) && !/\bnoch\b|kommen|offen/.test(lower)) return "fixed";
  if (/doppelt|zweimal (?:abgebucht|bezahlt|belastet|verrechnet)|mehrfach (?:abgebucht|belastet)/.test(lower)) return "duplicates";
  if (comparePattern.test(lower)) return "compare";
  if (trendPattern.test(lower)) return "trend";
  if (/preiserhöh|preiserhoeh|teurer geworden|teurer wurde|preis\w* (?:gestiegen|erhöht|angehoben)/.test(lower)) return "subscriptions";
  if (/\babos?\b|abonnement/.test(lower) && !/\bbei\b/.test(lower)) return "subscriptions";
  if (/(?:teuerste|größte|grösste|meiste)\w* (?:kategorie|bereich|posten|brocken)|kostenfresser|geldfresser|spend (?:the )?most|most money on|am meisten (?:geld )?(?:aus\b|ausgegeben|weg|hin)|meiste geld (?:hin|weg|geblieben|drauf)|(?:wo(?:hin)?|wofür|wofuer) (?:ist|sind|ging|gingen|geht|gehen|fließt) .{0,30}(?:das )?meiste/.test(lower)) return "breakdown";
  if (/größte|grösste|teuerste|höchste|meiste geld|top\s*\d*|\b(?:biggest|largest|most expensive)\b/.test(lower)) return "largest";
  if (/\b(?:warum|wieso|weshalb)\b.*\bso\s+(?:viel|hoch|teuer)|woher kommt/.test(lower)) return "largest";
  if (/verdient|einnahmen|eingenommen|reinbekommen|gehalt bekommen|eingegangen|(?:rein|herein)gekommen|gutgeschrieben|\bgehalt\b.*\b(?:bekommen|erhalten|gekommen)\b/.test(lower)) return "income";
  if (/wie oft|wie viele (?:mal|male|buchungen|käufe|einkäufe)|wievielmal/.test(lower)) return "count";
  if (/\bzahl(?:e)? ich\b|\bkoste[tn] mich\b|\bgebe? ich\b/.test(lower) && !/wofür|wofuer|wohin|am meisten|aufteilung|verteilt|insgesamt|gesamt|bisher|schon|jänner|januar|februar|märz|april|\bmai\b|juni|juli|august|september|oktober|november|dezember|monat\b|woche|jahr|heuer|gestern|heute|seit|letzte|vorige|20\d\d/.test(lower)) return "average";
  if (/durchschnitt|im schnitt|pro monat|pro woche|wöchentlich|woechentlich|monatlich|je monat|\bim monat\b(?!\s+(?:jänner|januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember))/.test(lower)) return "average";
  if (/wofür|wohin|aufteilung|aufgeteilt|nach kategorie|welche kategorie|verteilt/.test(lower)) return "breakdown";
  return "sum";
}

const idsOf = (rows: Transaction[]) => [...rows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 50).map((row) => row.id);

// Answers a data question with fixed queries; the model never produces a number.
// `previous` holds earlier questions (latest first), so "und im September?" keeps the category of the question before.
export function answerQuestion(state: AppState, text: string, today: string, hints: { merchant?: string; category?: string } = {}, previous: string[] = []): { text: string; card: AssistantCard } {
  const ownMetric = queryMetric(text);
  const metric = ownMetric === "sum" ? previous.map(queryMetric).find((item) => item !== "sum" && item !== "compare" && item !== "duplicates" && item !== "fixed" && item !== "saved") ?? "sum" : ownMetric;
  if (metric === "duplicates") {
    const from = findPeriod(text, today)?.from ?? shiftDate(today, -90);
    const found = detectDuplicateCharges(state, from);
    const total = round(found.reduce((sum, item) => sum + Math.abs(item.amount), 0));
    return {
      text: found.length
        ? `${plural(found.length, "Abbuchung sieht", "Abbuchungen sehen")} doppelt aus, zusammen ${currency(total)}. Prüf kurz, ob das wirklich zweimal bezahlt wurde – wenn ja, beim Händler zurückfordern.`
        : `Seit ${dateLabel(from)} finde ich keine doppelten Abbuchungen.`,
      card: { kind: "answer", title: `Doppelte Abbuchungen seit ${dateLabel(from)}`, total, transactionIds: found.flatMap((item) => item.ids).slice(0, 50),
        lines: found.slice(0, 20).map((item) => ({ label: item.merchant, value: Math.abs(item.amount), detail: item.dates.map(dateLabel).join(" und "), tone: "warn" as const, transactionIds: item.ids })),
        note: "Gleicher Händler und gleicher Betrag innerhalb weniger Tage. Abos und Teilzahlungen können ähnlich aussehen." },
    };
  }
  if (metric === "fixed") return fixedCosts(state, today);
  if (metric === "subscriptions") {
    const subscriptions = detectSubscriptions(state, today);
    const total = round(subscriptions.reduce((sum, item) => sum + item.monthlyCost, 0));
    const priciest = [...subscriptions].sort((a, b) => b.monthlyCost - a.monthlyCost)[0];
    const raised = subscriptions.filter((item) => item.priceChange);
    const lower = text.toLowerCase();
    const raisedText = raised.length
      ? `${plural(raised.length, "Abo wurde", "Abos wurden")} teurer: ${raised.slice(0, 4).map((item) => `${item.merchant} ${currency(item.priceChange!.from)} → ${currency(item.priceChange!.to)}`).join(", ")}.`
      : "Keines deiner Abos ist zuletzt teurer geworden.";
    return {
      text: !subscriptions.length ? "Ich habe keine laufenden Abos in deinen Buchungen erkannt."
        : /preis|teurer geworden|teurer wurde/.test(lower) ? raisedText
        : `Für ${plural(subscriptions.length, "Abo", "Abos")} gehen im Schnitt ${currency(total)} pro Monat weg (${currency(round(total * 12))} im Jahr). ` +
          `Am teuersten ist ${priciest.merchant} mit ${currency(priciest.monthlyCost)} im Monat.${raised.length ? ` ${raisedText}` : ""}`,
      card: { kind: "answer", title: "Laufende Abos", total, lines: subscriptions.slice(0, 40).map((item) => ({
        label: item.merchant, value: item.monthlyCost,
        detail: `${item.interval === "jährlich" ? `jährlich ${currency(item.amount)}` : "monatlich"} · nächste ${dateLabel(item.nextDate)}${item.priceChange ? ` · teurer seit ${dateLabel(item.priceChange.date)} (${currency(item.priceChange.from)} → ${currency(item.priceChange.to)})` : ""}`,
        ...(item.priceChange ? { tone: "warn" as const } : {}),
      })), note: "Beträge pro Monat; Jahresabos sind auf 12 Monate verteilt." },
    };
  }
  const ownFilter = findCategories(text);
  const ownMerchant = findMerchant(state, text, hints.merchant && !findBank(hints.merchant) ? hints.merchant : undefined);
  // A follow-up that names a new category or merchant replaces both; otherwise the earlier scope stays.
  const inherit = !ownFilter && !ownMerchant ? previous.find((item) => findCategories(item) || findMerchant(state, item)) : undefined;
  const bank = findBank(text) ?? previous.map(findBank).find(Boolean);
  if (metric === "compare") return compareMonths(state, text, today, {
    filter: ownFilter ?? (inherit ? findCategories(inherit) : undefined),
    merchant: ownMerchant ?? (inherit ? findMerchant(state, inherit) : undefined), bank, previous });
  if (metric === "trend") {
    const named = findPeriod(text, today) ?? earlierPeriod(previous, today);
    return spendingTrend(state, today, named && !named.month && named.months > 1 ? named.months : 6, {
      filter: ownFilter ?? (inherit ? findCategories(inherit) : undefined),
      merchant: ownMerchant ?? (inherit && !ownFilter ? findMerchant(state, inherit) : undefined), bank, previous });
  }
  const period = findPeriod(text, today) ?? earlierPeriod(previous, today) ?? parsePeriod(text, today);
  // Bookkeeping categories are no guess for "Buchungen über 100 Euro"; they only count when the question names them.
  const bookkeeping = ["Transfer", "Transfer intern", "Prüfen", "Sonstiges"].includes(hints.category ?? "") &&
    !normalizeSearch(text).includes(normalizeSearch(hints.category ?? "").slice(0, 6));
  // The model's category guess only counts when the question carries a word of it ("Futter" never becomes "Guthabenkarten").
  const plainText = normalizeSearch(text);
  const grounded = (category: string) => normalizeSearch(category).split(" ").some((word) => word.length >= 5 && plainText.includes(word.slice(0, 5)));
  const hintCategory = hints.category && categories.includes(hints.category as never) && !bookkeeping && grounded(hints.category)
    ? { categories: [hints.category as Category], label: hints.category } : undefined;
  // A bank or card question is about the account, so a model category guess like "Abonnements" is ignored.
  const filter = ownFilter ?? (inherit ? findCategories(inherit) : undefined) ?? (bank || ownMerchant ? undefined : hintCategory);
  const merchant = ownMerchant ?? (inherit && !ownFilter ? findMerchant(state, inherit) : undefined);
  // "Wie viel für Lieferando?" without any Lieferando booking must not answer with all spending.
  const unknown = !filter && !merchant && !bank && !inherit ? unknownName(text) : undefined;
  if (unknown) return { text: `Für „${unknown}“ finde ich keine Buchungen im Zeitraum ${period.label}.`,
    card: { kind: "answer", title: `${unknown} · ${period.label}`, total: 0, lines: [] } };
  const askedPeriod = findPeriod(text, today) ?? earlierPeriod(previous, today);
  if (merchant && !askedPeriod && !filter && (metric === "sum" || metric === "average") && !/\b(?:im|pro|aufs?|ein) jahr\b|jährlich|jaehrlich|insgesamt|gesamt|bisher|schon/.test(text.toLowerCase())) {
    const plain = normalizeSearch(merchant);
    const subscription = detectSubscriptions(state, today).find((item) => normalizeSearch(item.merchant).includes(plain) || plain.includes(normalizeSearch(item.merchant)));
    if (subscription) {
      const yearly = round(subscription.monthlyCost * 12);
      return { text: `${subscription.merchant} kostet dich ${currency(subscription.amount)} ${subscription.interval === "jährlich" ? "im Jahr" : "im Monat"}` +
        `${subscription.interval === "jährlich" ? "" : `, also ${currency(yearly)} im Jahr`}.` +
        (subscription.priceChange && subscription.priceChange.percent > 0 ? ` Seit ${dateLabel(subscription.priceChange.date)} ist es ${currency(round(subscription.priceChange.to - subscription.priceChange.from))} teurer.` : ""),
        card: { kind: "answer", title: subscription.merchant, total: subscription.monthlyCost, lines: [
          { label: "pro Monat", value: subscription.monthlyCost }, { label: "pro Jahr", value: yearly },
          { label: "nächste Abbuchung", detail: dateLabel(subscription.nextDate), tone: "info" }], page: { label: "Vertragsordner öffnen", href: "/vertraege" } } };
    }
  }
  if (merchant && /\b(?:im|pro|aufs?|ein) jahr\b|jährlich|jaehrlich/.test(text.toLowerCase())) {
    const plain = normalizeSearch(merchant);
    const subscription = detectSubscriptions(state, today).find((item) => normalizeSearch(item.merchant).includes(plain) || plain.includes(normalizeSearch(item.merchant)));
    if (subscription) {
      const yearly = round(subscription.monthlyCost * 12);
      return { text: `${subscription.merchant} kostet dich ${currency(subscription.monthlyCost)} im Monat, also ${currency(yearly)} im Jahr.`,
        card: { kind: "answer", title: `${subscription.merchant} · pro Jahr`, total: yearly, lines: [
          { label: "pro Monat", value: subscription.monthlyCost }, { label: "pro Jahr", value: yearly },
          { label: "nächste Abbuchung", detail: dateLabel(subscription.nextDate), tone: "info" }] } };
    }
    const since = new Date(`${today}T00:00:00Z`); since.setUTCFullYear(since.getUTCFullYear() - 1);
    const from = since.toISOString().slice(0, 10);
    const rows = state.transactions.filter((row) => row.amount < 0 && row.date > from && row.date <= today && matchesTransactionSearch(row, merchant));
    if (rows.length) {
      const yearly = round(rows.reduce((sum, row) => sum - row.amount, 0));
      return { text: `Für ${merchant} hast du in den letzten 12 Monaten ${currency(yearly)} ausgegeben (${plural(rows.length, "Buchung", "Buchungen")}), im Schnitt ${currency(round(yearly / 12))} im Monat.`,
        card: { kind: "answer", title: `${merchant} · letzte 12 Monate`, total: yearly, lines: [
          { label: "letzte 12 Monate", value: yearly }, { label: "Schnitt pro Monat", value: round(yearly / 12) }], transactionIds: idsOf(rows) } };
    }
  }
  const wanted = filter ? new Set(filter.categories.map(canonicalCategory)) : undefined;
  const limit = amountLimit(text);
  const entries = ledger(state).filter(({ row, category }) => row.date >= period.from && row.date <= period.to &&
    (!wanted || wanted.has(category)) && (!merchant || matchesTransactionSearch(row, merchant)) && (!bank || bank.pattern.test(row.bank.trim())) &&
    (!limit || (limit.over ? Math.abs(row.amount) > limit.value : Math.abs(row.amount) < limit.value)));
  const merchantLabel = merchant && merchant === merchant.toLowerCase() ? merchant.charAt(0).toUpperCase() + merchant.slice(1) : merchant;
  const scope = [bank?.label, merchantLabel, filter?.label].filter(Boolean).join(" · ") || "Alle Ausgaben";
  const title = `${metric === "income" ? "Einnahmen" : scope} · ${period.label}`;
  const month = period.month;
  if (metric === "saved") {
    const income = round(entries.filter(({ row, category }) => row.amount > 0 && isIncomeCategory(category)).reduce((sum, { row }) => sum + row.amount, 0));
    const spent = round(entries.filter(({ row }) => row.amount < 0).reduce((sum, { row }) => sum - row.amount, 0));
    const saved = round(income - spent);
    const rate = income > 0 ? Math.round(saved / income * 100) : undefined;
    return { text: saved >= 0
      ? `Im Zeitraum ${period.label} sind dir ${currency(saved)} übrig geblieben${rate !== undefined ? ` (${rate} % deiner Einnahmen)` : ""} – ${currency(income)} rein, ${currency(spent)} raus.`
      : `Im Zeitraum ${period.label} hast du ${currency(-saved)} mehr ausgegeben als eingenommen (${currency(income)} rein, ${currency(spent)} raus).`,
      card: { kind: "answer", title: `Gespart · ${period.label}`, total: saved, ...(month ? { month } : {}), lines: [
        { label: "Einnahmen", value: income, tone: "good" }, { label: "Ausgaben", value: -spent, tone: "warn" },
        { label: saved >= 0 ? "Übrig" : "Fehlbetrag", value: saved, tone: saved >= 0 ? "good" : "bad", ...(rate !== undefined ? { detail: `${rate} % Sparquote` } : {}) }],
        note: "Einnahmen minus Ausgaben; Umbuchungen zwischen deinen Konten zählen nicht." } };
  }
  if (metric === "income") {
    const rows = entries.filter(({ row, category }) => row.amount > 0 && isIncomeCategory(category)).map(({ row }) => row);
    const total = round(rows.reduce((sum, row) => sum + row.amount, 0));
    const bySource = new Map<string, number>();
    for (const row of rows) bySource.set(merchantOf(row), round((bySource.get(merchantOf(row)) ?? 0) + row.amount));
    return { text: `Eingenommen hast du ${period.label === "diese Woche" ? "diese Woche" : `im Zeitraum ${period.label}`} ${currency(total)}.`,
      card: { kind: "answer", title, total, ...(month ? { month } : {}), transactionIds: idsOf(rows),
        lines: [...bySource].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ label, value })) } };
  }
  const spending = entries.filter(({ row }) => row.amount < 0);
  const rows = spending.map(({ row }) => row);
  const total = round(rows.reduce((sum, row) => sum - row.amount, 0));
  if (!rows.length) return { text: `Im Zeitraum ${period.label} finde ich keine passenden Ausgaben${merchant || filter ? ` für ${scope}` : ""}.`,
    card: { kind: "answer", title, total: 0, lines: [], ...(month ? { month } : {}) } };
  if (limit) {
    const top = [...rows].sort((a, b) => a.amount - b.amount);
    const label = `${limit.over ? "über" : "unter"} ${currency(limit.value)}`;
    return { text: `${plural(rows.length, "Ausgabe", "Ausgaben")} ${label} im Zeitraum ${period.label}${merchant || filter ? ` für ${scope}` : ""}, zusammen ${currency(total)}.` +
      ` Die größte: ${merchantOf(top[0])} mit ${currency(-top[0].amount)} am ${dateLabel(top[0].date)}.`,
      card: { kind: "answer", title: `Ausgaben ${label} · ${period.label}`, total, ...(month ? { month } : {}), transactionIds: top.slice(0, 50).map((row) => row.id),
        lines: top.slice(0, 25).map((row) => ({ label: merchantOf(row), value: round(-row.amount), detail: `${dateLabel(row.date)} · ${canonicalCategory(row.category)}`, transactionIds: [row.id] })) } };
  }
  if (metric === "largest") {
    const top = [...rows].sort((a, b) => a.amount - b.amount).slice(0, 10);
    const first = top[0];
    return { text: `Deine größte Ausgabe im Zeitraum ${period.label} war ${merchantOf(first)} mit ${currency(-first.amount)} am ${dateLabel(first.date)}.`,
      card: { kind: "answer", title: `Größte Ausgaben · ${period.label}`, total: round(-first.amount), ...(month ? { month } : {}),
        transactionIds: top.map((row) => row.id),
        lines: top.map((row) => ({ label: merchantOf(row), value: round(-row.amount), detail: `${dateLabel(row.date)} · ${canonicalCategory(row.category)}`, transactionIds: [row.id] })) } };
  }
  const byCategory = new Map<string, number>();
  for (const { row, category } of spending) byCategory.set(category, round((byCategory.get(category) ?? 0) - row.amount));
  const byMerchant = new Map<string, number>();
  for (const row of rows) byMerchant.set(merchantOf(row), round((byMerchant.get(merchantOf(row)) ?? 0) - row.amount));
  const breakdown = metric === "merchants" ? byMerchant : (metric === "breakdown" || (!filter && !merchant) || (filter && filter.categories.length > 1)) && byCategory.size > 1 ? byCategory : byMerchant;
  const lines: Line[] = [...breakdown].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({
    label, value, detail: `${Math.round(value / total * 100)} %` }));
  const card: AssistantCard = { kind: "answer", title, total, lines, transactionIds: idsOf(rows), ...(month ? { month } : {}) };
  if (metric === "breakdown" && breakdown === byCategory && lines.length) {
    const [first, ...rest] = lines;
    return { text: `Am meisten gibst du für ${first.label} aus: ${currency(first.value ?? 0)} (${first.detail}) im Zeitraum ${period.label}.` +
      (rest.length ? ` Danach kommen ${rest.slice(0, 2).map((line) => `${line.label} (${currency(line.value ?? 0)})`).join(" und ")}.` : ""), card };
  }
  if (metric === "merchants" && lines.length)
    return { text: `Am meisten Geld lässt du bei ${lines[0].label}: ${currency(lines[0].value ?? 0)} im Zeitraum ${period.label}.` +
      (lines.length > 1 ? ` Danach ${lines.slice(1, 3).map((line) => `${line.label} (${currency(line.value ?? 0)})`).join(" und ")}.` : ""), card };
  if (metric === "count") return { text: `${plural(rows.length, "Buchung", "Buchungen")} im Zeitraum ${period.label} für ${scope}, zusammen ${currency(total)}.`, card };
  // Averages start with the first booking at all, so a year that was imported from July on is not divided by twelve.
  const firstBooking = state.transactions.reduce((first, row) => row.date < first ? row.date : first, "9999-12-31");
  const start = firstBooking > period.from && firstBooking <= period.to ? firstBooking : period.from;
  if (metric === "average" && /pro woche|wöchentlich|woechentlich|in der woche|die woche\b/.test(text.toLowerCase())) {
    const end = period.to > today ? today : period.to;
    const weeks = Math.max(1, (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS / 7 + 1 / 7);
    const weekly = round(total / weeks);
    return { text: `Im Schnitt ${currency(weekly)} pro Woche für ${scope} (${period.label}, gesamt ${currency(total)}).`, card: { ...card, total: weekly,
      note: `Durchschnitt über ${Math.round(weeks)} Wochen.` } };
  }
  if (metric === "average") {
    const end = (period.to > today ? today : period.to).slice(0, 7);
    const months = start === period.from ? period.months
      : Math.max(1, (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(start.slice(5, 7)) + 1);
    const average = round(total / Math.max(1, months));
    return { text: `Im Schnitt ${currency(average)} pro Monat für ${scope} (${start === period.from ? period.label : `seit ${monthLabel(start.slice(0, 7))}`}, gesamt ${currency(total)}).`,
      card: { ...card, total: average, note: `Durchschnitt über ${plural(months, "Monat", "Monate")}${start === period.from ? "" : " mit Buchungen"}; der laufende Monat zählt mit.` } };
  }
  return { text: `${scope === "Alle Ausgaben" ? "Insgesamt hast du" : `Für ${scope} hast du`} im Zeitraum ${period.label} ${currency(total)} ausgegeben (${plural(rows.length, "Buchung", "Buchungen")}).`, card };
}

// "Wie stehen meine Sparziele?": saved so far, monthly rate and whether each goal makes it in time.
/** "Wann hab ich das Motorrad zusammen?", "Wie viel fehlt mir noch für Japan?" */
export const goalProgressQuestion = (lower: string) =>
  /\bwann\b.*\b(?:zusammen|erreicht|voll|fertig|geschafft|beisammen)\b|\bwie viel fehlt\b|\bwie weit bin ich\b|\bwie (?:steht|läuft|laeuft|schaut|sieht)\b|\bwie viel (?:hab|habe) ich (?:schon )?(?:für|fürs|fuer)\b|\bsparziel\b/.test(lower);
export const namedGoal = (dashboard: Dashboard, text: string) => {
  const plain = ` ${normalizeSearch(text)} `;
  return dashboard.goals.filter((goal) => !goal.completedAt).find((goal) => normalizeSearch(goal.name).length >= 3 && plain.includes(` ${normalizeSearch(goal.name)}`));
};

function goalProgress(dashboard: Dashboard, goal: Dashboard["goals"][number]): { text: string; card: AssistantCard } {
  const saved = round(dashboard.goalStatuses[goal.id]?.amount ?? 0);
  const missing = round(Math.max(0, goal.target - saved));
  const reach = dashboard.timeline.find((row) => (row.goalEnd[goal.id] ?? 0) + 0.5 >= goal.target)?.month;
  const due = goal.date.slice(8, 10) === "01" ? addMonths(goal.date.slice(0, 7), -1) : goal.date.slice(0, 7);
  const rate = goalRate(goal);
  const text = missing <= 0 ? `${goal.name} hast du geschafft: ${currency(saved)} von ${currency(goal.target)}.`
    : `Für ${goal.name} hast du ${currency(saved)} von ${currency(goal.target)} – es fehlen noch ${currency(missing)}.` +
      (reach ? ` Laut Plan hast du es im ${monthLabel(reach)} zusammen${reach > due ? `, also später als geplant (${dateLabel(goal.date)})` : ", rechtzeitig"}.`
        : " Mit dem aktuellen Plan reicht es in den nächsten Monaten nicht – mehr sparen oder das Ziel verschieben?") +
      (rate ? ` Dafür legst du ${currency(rate)} im Monat zur Seite.` : "");
  return { text, card: { kind: "answer", title: `Sparziel · ${goal.name}`, total: saved, lines: [
    { label: "Angespart", value: saved, tone: "info" }, { label: "Ziel", value: goal.target, detail: `bis ${dateLabel(goal.date)}` },
    ...(missing > 0 ? [{ label: "Fehlt noch", value: missing, tone: "warn" as const }] : []),
    ...(rate ? [{ label: "Sparrate", value: rate, detail: "pro Monat" }] : []),
    ...(reach ? [{ label: "Erreicht laut Plan", detail: monthLabel(reach), tone: reach > due ? "warn" as const : "good" as const }] : []),
  ], page: { label: "Sparen öffnen", href: "/sparen" } } };
}

export function goalsStatus(dashboard: Dashboard, today: string, text = ""): { text: string; card: AssistantCard } {
  const one = text ? namedGoal(dashboard, text) : undefined;
  if (one) return goalProgress(dashboard, one);
  const goals = dashboard.goals.filter((goal) => !goal.completedAt);
  if (!goals.length) return { text: "Du hast gerade keine offenen Sparziele. Sag z. B. „Ich will bis Juli 3.000 € für Japan sparen“, dann lege ich eins an.",
    card: { kind: "answer", title: "Sparziele", total: 0, lines: [] } };
  const behind: string[] = [], onTrack: string[] = [];
  const lines: Line[] = goals.slice(0, 20).map((goal) => {
    const saved = round(dashboard.goalStatuses[goal.id]?.amount ?? 0);
    const goalMonth = goal.date.slice(8, 10) === "01" ? addMonths(goal.date.slice(0, 7), -1) : goal.date.slice(0, 7);
    const projected = dashboard.timeline.find((row) => row.month === goalMonth)?.goalEnd[goal.id];
    const late = goal.date >= today && projected !== undefined && projected !== null && projected + 0.5 < goal.target;
    (late ? behind : onTrack).push(late ? `${goal.name} (fehlen ${currency(round(goal.target - (projected ?? 0)))} bis ${dateLabel(goal.date)})` : goal.name);
    const percent = goal.target > 0 ? Math.min(100, Math.round(saved / goal.target * 100)) : 0;
    return { label: goal.name, value: saved, tone: late ? "bad" as const : percent >= 100 ? "good" as const : "info" as const,
      detail: `${percent} % von ${currency(goal.target)} · bis ${dateLabel(goal.date)}${goalRate(goal) ? ` · ${currency(goalRate(goal))}/Monat` : ""}${late ? " · hinter Plan" : ""}` };
  });
  const saved = round(lines.reduce((sum, line) => sum + (line.value ?? 0), 0));
  return {
    text: `${plural(goals.length, "Sparziel", "Sparziele")}, zusammen ${currency(saved)} angespart. ` +
      (behind.length ? `Hinter Plan: ${behind.join(", ")}.${onTrack.length ? ` Im Plan: ${onTrack.join(", ")}.` : ""}` : "Alle liegen im Plan."),
    card: { kind: "answer", title: "Sparziele", total: saved, lines },
  };
}

// "über 100 €", "mehr als 50 Euro", "unter 20 €"
export function amountLimit(text: string): { over: boolean; value: number } | undefined {
  const match = /(?<![\wäöüß])(über|ueber|mehr als|größer als|groesser als|ab|unter|weniger als|kleiner als)\s+(\d+(?:[.,]\d{1,2})?)\s*(?:€|euro\b|eur\b)/i.exec(text);
  if (!match) return undefined;
  return { over: !/unter|weniger|kleiner/i.test(match[1]), value: Number(match[2].replace(",", ".")) };
}

// Planned fixed costs this month from the plan, largest first.
function fixedCosts(state: AppState, today: string): { text: string; card: AssistantCard } {
  const month = today.slice(0, 7);
  const items = state.financeRows.filter((row) => row.kind === "fixed").map((row) => ({ label: row.label, value: round(Math.abs(row.values[month] ?? 0)) }))
    .filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const total = round(items.reduce((sum, item) => sum + item.value, 0));
  const income = round(state.financeRows.filter((row) => row.kind === "income").reduce((sum, row) => sum + Math.max(0, row.values[month] ?? 0), 0));
  const share = income > 0 ? Math.round(total / income * 100) : undefined;
  if (!items.length) {
    // No fixed costs planned yet: the contracts found in the bookings are the next best answer.
    const contracts = detectContracts(state, today).filter((contract) => contract.status !== "ignored");
    const summary = contractSummary(contracts, today);
    return { text: "In deinem Plan sind für diesen Monat keine Fixkosten eingetragen." +
      (summary.active ? ` Aus deinen Buchungen erkenne ich ${plural(summary.active, "laufenden Vertrag", "laufende Verträge")} mit zusammen ${currency(summary.monthly)} im Monat.` : ""),
    card: { kind: "answer", title: `Fixkosten · ${monthLabel(month)}`, total: 0, lines: [], month,
      ...(summary.active ? { page: { label: "Verträge öffnen", href: "/vertraege" } } : {}) } };
  }
  return {
    text: `Deine Fixkosten liegen bei ${currency(total)} im Monat (${plural(items.length, "Posten", "Posten")}${share !== undefined ? `, ${share} % vom Einkommen` : ""}). ` +
      `Die größten: ${items.slice(0, 3).map((item) => `${item.label} ${currency(item.value)}`).join(", ")}.` +
      (share !== undefined && share > 50 ? " Das ist mehr als die Hälfte deines Einkommens – hier lohnt sich Sparen am meisten." : ""),
    card: { kind: "answer", title: `Fixkosten · ${monthLabel(month)}`, total, month,
      lines: items.slice(0, 30).map((item) => ({ label: item.label, value: item.value, detail: `${Math.round(item.value / total * 100)} %` })),
      note: "Laut deinem Monatsplan; Abos und Leasing zählen dazu, wenn sie als Fixkosten geplant sind." },
  };
}

const goalRate = (goal: Dashboard["goals"][number]) => goal.funding?.monthly ?? 0;

type Scope = { filter?: { categories: Category[]; label: string }; merchant?: string; bank?: { pattern: RegExp; label: string }; previous: string[] };
// The period of the latest earlier question; a comparison counts with its first month.
function earlierPeriod(previous: string[], today: string, monthOnly = false): Period | undefined {
  for (const [index, item] of previous.entries()) {
    const period = comparePattern.test(item.toLowerCase()) ? compareSelection(item, today, previous.slice(index + 1))[0] : findPeriod(item, today);
    if (period && (!monthOnly || period.month)) return period;
  }
  return undefined;
}

// Which two months a comparison means; earlier questions fill in the month when the text names none.
export function compareSelection(text: string, today: string, previous: string[]): [Period, Period] {
  let months = monthsIn(text, today);
  const earlier = earlierPeriod(previous, today, true);
  const lower = text.toLowerCase();
  // "im Vergleich zum Vorjahr": the named month against the same month a year earlier, otherwise this year so far against the same span last year.
  if (/vorjahr|(?:letzte[nms]?|vorige[nms]?|vergangene[nms]?) jahr/.test(lower) && months.length <= 1) {
    if (months.length === 1) return [months[0], monthPeriodOf(addMonths(months[0].month!, -12), today)];
    const year = Number(today.slice(0, 4));
    return [{ from: `${year}-01-01`, to: today, label: "heuer", months: Number(today.slice(5, 7)) },
      { from: `${year - 1}-01-01`, to: `${year - 1}${today.slice(4)}`, label: `Vorjahr bis ${dateLabel(`${year - 1}${today.slice(4)}`)}`, months: Number(today.slice(5, 7)) }];
  }
  // "mehr als im Vormonat?" compares the month asked before (or this month) with its previous one; "mehr als im September?" with September.
  if (/\bals\s+(?:im\s+|in\s+|der\s+)?(?:vormonat|monat davor|letzten monat|vorigen monat|(?:letzten|vorigen)(?=\s*[?.!]*$))/.test(lower) && months.length <= 1) {
    const base = monthsIn(text.replace(/\bals\s.*$/i, ""), today)[0] ?? earlier ?? monthPeriodOf(today.slice(0, 7), today);
    months = [base, monthPeriodOf(addMonths(base.month!, -1), today)];
  } else if (months.length === 1 && /\bals\s+(?:im\s+|in\s+)?[a-zäöü]+/.test(lower)) {
    const base = earlier && earlier.month !== months[0].month ? earlier : monthPeriodOf(today.slice(0, 7), today);
    months = [base, months[0]];
  }
  if (!months.length) months = [earlier ?? monthPeriodOf(today.slice(0, 7), today)];
  if (months.length === 1) months.push(monthPeriodOf(addMonths(months[0].month!, -1), today));
  return [months[0], months[1]];
}

// "Vergleich Oktober mit September", "mehr als im Vormonat?": two months side by side, computed from the ledger.
export function compareMonths(state: AppState, text: string, today: string, scope: Scope): { text: string; card: AssistantCard } {
  const [a, b] = compareSelection(text, today, scope.previous);
  const wanted = scope.filter ? new Set(scope.filter.categories.map(canonicalCategory)) : undefined;
  const all = ledger(state);
  const spend = (period: Period) => all.filter(({ row, category }) => row.amount < 0 && row.date >= period.from && row.date <= period.to &&
    (!wanted || wanted.has(category)) && (!scope.merchant || matchesTransactionSearch(row, scope.merchant)) && (!scope.bank || scope.bank.pattern.test(row.bank.trim())));
  const left = spend(a), right = spend(b);
  const sum = (entries: typeof left) => round(entries.reduce((total, { row }) => total - row.amount, 0));
  const totalA = sum(left), totalB = sum(right);
  const diff = round(totalA - totalB);
  // Nothing imported for the earlier span (e.g. last year): an honest note instead of "everything is more".
  if (!right.length && !all.some(({ row }) => row.date <= b.to && row.date >= b.from))
    return { text: `Für ${b.month ? `den ${b.label}` : `den Zeitraum ${b.label}`} habe ich keine Buchungen – deine Umsätze reichen nur bis ${dateLabel(all.reduce((min, { row }) => row.date < min ? row.date : min, today))} zurück. Ein Vergleich ist deshalb nicht möglich; ${a.month ? `im ${a.label}` : "heuer"} waren es ${currency(totalA)}.`,
      card: { kind: "answer", title: `Vergleich · ${a.label}`, total: totalA, lines: [{ label: a.label, value: totalA, detail: "erfasst" }, { label: b.label, value: 0, detail: "keine Daten" }] } };
  const byCategory = !scope.merchant && (!scope.filter || scope.filter.categories.length > 1);
  const key = ({ row, category }: (typeof left)[number]) => byCategory ? category : merchantOf(row);
  const groups = new Map<string, [number, number]>();
  for (const entry of left) { const item = groups.get(key(entry)) ?? [0, 0]; item[0] = round(item[0] - entry.row.amount); groups.set(key(entry), item); }
  for (const entry of right) { const item = groups.get(key(entry)) ?? [0, 0]; item[1] = round(item[1] - entry.row.amount); groups.set(key(entry), item); }
  const changes = [...groups].map(([label, [x, y]]) => ({ label, x, y, delta: round(x - y) })).filter((item) => Math.abs(item.delta) >= 1)
    .sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta)).slice(0, 8);
  const label = [scope.bank?.label, scope.merchant, scope.filter?.label].filter(Boolean).join(" · ");
  const forWhat = label ? ` für ${label}` : "";
  const running = a.to === today && a.month === today.slice(0, 7) ? " (Monat läuft noch)" : "";
  const sentence = diff === 0
    ? `${a.month ? `Im ${a.label}` : "Heuer"} hast du${forWhat} genauso viel ausgegeben wie im ${b.label}: ${currency(totalA)}.`
    : `${a.month ? `Im ${a.label}` : "Heuer"}${running} hast du${forWhat} ${currency(totalA)} ausgegeben, ${currency(Math.abs(diff))} ${diff > 0 ? "mehr" : "weniger"} als im ${b.label} (${currency(totalB)}).`;
  const top = changes[0];
  const reason = top && diff !== 0 && Math.sign(top.delta) === Math.sign(diff)
    ? ` Am meisten ${diff > 0 ? "dazu kam" : "weniger war"} bei ${top.label} (${top.delta > 0 ? "+" : "−"}${currency(Math.abs(top.delta))}).` : "";
  return { text: sentence + reason, card: { kind: "answer", title: `Vergleich${label ? ` · ${label}` : ""} · ${a.label} vs ${b.label}`, total: diff,
    transactionIds: idsOf(left.map(({ row }) => row)),
    chart: changes.length >= 2
      ? buildChart("bar", [{ name: a.label, points: changes.map((item) => ({ label: item.label, value: item.x })) },
        { name: b.label, points: changes.map((item) => ({ label: item.label, value: item.y })) }])
      : buildChart("bar", [{ name: "Ausgaben", points: [{ label: a.label, value: totalA }, { label: b.label, value: totalB }] }]),
    lines: [
      { label: a.label, value: totalA, detail: `${plural(left.length, "Buchung", "Buchungen")}${running}`, transactionIds: idsOf(left.map(({ row }) => row)) },
      { label: b.label, value: totalB, detail: plural(right.length, "Buchung", "Buchungen"), transactionIds: idsOf(right.map(({ row }) => row)) },
      ...changes.map((item): Line => ({ label: item.label, value: item.delta, detail: `${currency(item.x)} statt ${currency(item.y)}`,
        tone: item.delta > 0 ? "warn" : "good" })),
    ], note: "Differenz = erster minus zweiter Monat; positive Werte heißen mehr ausgegeben." } };
}

// "Wie haben sich meine Ausgaben entwickelt?": one line per full month, compared with the average.
export function spendingTrend(state: AppState, today: string, count: number, scope: Scope): { text: string; card: AssistantCard } {
  const current = today.slice(0, 7);
  const n = Math.max(2, Math.min(24, count));
  const months = Array.from({ length: n }, (_, index) => addMonths(current, index - n));
  const wanted = scope.filter ? new Set(scope.filter.categories.map(canonicalCategory)) : undefined;
  const byMonth = new Map(months.map((month) => [month, [] as Transaction[]]));
  for (const { row, category } of ledger(state)) {
    const list = byMonth.get(row.date.slice(0, 7));
    if (!list || row.amount >= 0 || (wanted && !wanted.has(category)) || (scope.merchant && !matchesTransactionSearch(row, scope.merchant)) ||
      (scope.bank && !scope.bank.pattern.test(row.bank.trim()))) continue;
    list.push(row);
  }
  const totals = months.map((month) => ({ month, rows: byMonth.get(month)!, total: round(byMonth.get(month)!.reduce((sum, row) => sum - row.amount, 0)) }));
  const label = [scope.bank?.label, scope.merchant, scope.filter?.label].filter(Boolean).join(" · ");
  const forWhat = label ? ` für ${label}` : "";
  const range = `${monthLabel(months[0])} bis ${monthLabel(months[months.length - 1])}`;
  const title = `Verlauf${label ? ` · ${label}` : " · Ausgaben"} · ${range}`;
  const all = totals.flatMap((item) => item.rows);
  if (!all.length) return { text: `Von ${range} finde ich keine passenden Ausgaben${forWhat}.`, card: { kind: "answer", title, total: 0, lines: [] } };
  const average = round(totals.reduce((sum, item) => sum + item.total, 0) / totals.length);
  const highest = totals.reduce((a, b) => (b.total > a.total ? b : a));
  const lowest = totals.reduce((a, b) => (b.total < a.total ? b : a));
  const half = Math.floor(totals.length / 2);
  const firstHalf = totals.slice(0, half).reduce((sum, item) => sum + item.total, 0) / Math.max(1, half);
  const secondHalf = totals.slice(totals.length - half).reduce((sum, item) => sum + item.total, 0) / Math.max(1, half);
  const direction = firstHalf > 0 && secondHalf > firstHalf * 1.1 ? "steigt"
    : firstHalf > 0 && secondHalf < firstHalf * 0.9 ? "sinkt" : "bleibt ziemlich gleich";
  const text = `Deine Ausgaben${forWhat} lagen von ${range} im Schnitt bei ${currency(average)} pro Monat und ${direction === "bleibt ziemlich gleich" ? "blieben ziemlich gleich" : direction === "steigt" ? "sind zuletzt gestiegen" : "sind zuletzt gesunken"}.` +
    ` Am meisten war es im ${monthLabel(highest.month)} (${currency(highest.total)}), am wenigsten im ${monthLabel(lowest.month)} (${currency(lowest.total)}).`;
  return { text, card: { kind: "answer", title, total: average, transactionIds: idsOf(all),
    chart: buildChart("bar", [{ name: "Ausgaben", points: totals.map((item) => ({ label: shortMonth(item.month), value: item.total })) }],
      { label: "Schnitt", value: average }),
    lines: totals.map((item): Line => {
      const delta = round(item.total - average);
      return { label: monthLabel(item.month), value: item.total, transactionIds: idsOf(item.rows),
        detail: `${plural(item.rows.length, "Buchung", "Buchungen")} · ${delta === 0 ? "genau im Schnitt" : `${delta > 0 ? "+" : "−"}${currency(Math.abs(delta))} zum Schnitt`}`,
        ...(average > 0 && item.total > average * 1.15 ? { tone: "warn" as const } : average > 0 && item.total < average * 0.85 ? { tone: "good" as const } : {}) };
    }), note: "Nur volle Monate; der laufende Monat zählt nicht mit. Summe oben = Durchschnitt pro Monat." } };
}

// Proactive start message: what is due this week, what changed, which goals fall behind.
export function weeklyBriefing(state: AppState, dashboard: Dashboard, today: string, salaryDay?: number): { text: string; card: AssistantCard } {
  const end = shiftDate(today, 6);
  const lines: Line[] = [];
  const subscriptions = detectSubscriptions(state, today);
  const due = [
    ...subscriptions.filter((item) => item.nextDate >= today && item.nextDate <= end).map((item) => ({ name: item.merchant, date: item.nextDate, amount: item.amount })),
    ...plannedOccurrences(state.plannedOneOffs).filter((item) => item.date >= today && item.date <= end && !item.bookingId)
      .map((item) => ({ name: item.name, date: item.date, amount: item.ownAmount })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const dueTotal = round(due.reduce((sum, item) => sum + item.amount, 0));
  for (const item of due.slice(0, 8)) lines.push({ label: `Fällig: ${item.name}`, value: item.amount, detail: dateLabel(item.date), tone: "info" });
  const increases = subscriptions.filter((item) => item.priceChange && item.priceChange.date >= shiftDate(today, -60));
  for (const item of increases.slice(0, 4)) lines.push({ label: `${item.merchant} wurde teurer`, value: item.priceChange!.to,
    detail: `vorher ${currency(item.priceChange!.from)} (+${item.priceChange!.percent.toLocaleString("de-AT")} %)`, tone: "warn" });
  const behind: string[] = [];
  for (const goal of dashboard.goals) {
    if (goal.completedAt || goal.date < today) continue;
    // The balance on the goal date is the end of the month before; the goal month itself
    // already contains the purchase, which would otherwise count as a shortfall.
    const goalMonth = goal.date.slice(8, 10) === "01" ? addMonths(goal.date.slice(0, 7), -1) : goal.date.slice(0, 7);
    const projected = dashboard.timeline.find((row) => row.month === goalMonth)?.goalEnd[goal.id];
    if (projected === undefined || projected === null || projected + 0.5 >= goal.target) continue;
    const missing = round(goal.target - projected);
    const monthly = goalRate(goal);
    const months = monthly > 0 ? Math.ceil(missing / monthly) : undefined;
    behind.push(months ? `${goal.name} liegt ${plural(months, "Monat", "Monate")} hinter dem Plan` : `${goal.name} wird nicht rechtzeitig fertig`);
    lines.push({ label: `${goal.name} hinter Plan`, value: missing, detail: `fehlen bis ${dateLabel(goal.date)}${months ? ` · ca. ${plural(months, "Monat", "Monate")} Verzug` : ""}`, tone: "bad" });
  }
  const duplicates = detectDuplicateCharges(state, shiftDate(today, -30));
  for (const item of duplicates.slice(0, 3)) lines.push({ label: `Doppelt abgebucht? ${item.merchant}`, value: -item.amount,
    detail: `${dateLabel(item.dates[0])} und ${dateLabel(item.dates[1])}`, tone: "warn", transactionIds: item.ids });
  const forecast = forecastMonth(state, subscriptions, today);
  if (forecast.averageSpending && forecast.projectedSpending > forecast.averageSpending * 1.1)
    lines.push({ label: `Prognose ${monthLabel(forecast.month)}`, value: forecast.projectedSpending,
      detail: `über deinem Schnitt von ${currency(forecast.averageSpending)}`, tone: "warn" });
  const reviews = openReviewCount(state.reviewQueue ?? []);
  const dueReminders = reminderLines(state, today, end);
  lines.unshift(...dueReminders);
  if (reviews) lines.push({ label: `${plural(reviews, "Buchung wartet", "Buchungen warten")} auf Prüfung`, tone: "info" });
  if (salaryDay) {
    const day = Number(today.slice(8, 10));
    const thisMonth = `${today.slice(0, 7)}-${pad(Math.min(salaryDay, Number(monthEnd(today.slice(0, 7)).slice(8))))}`;
    const next = day <= salaryDay ? thisMonth : `${addMonths(today.slice(0, 7), 1)}-${pad(salaryDay)}`;
    const days = Math.round((Date.parse(`${next}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
    lines.push({ label: days === 0 ? "Heute kommt dein Gehalt" : `Gehalt in ${plural(days, "Tag", "Tagen")}`, detail: dateLabel(next), tone: "good" });
  }
  const amexShortfall = round(dashboard.amex?.shortfall ?? 0);
  const soon = shiftDate(today, 30);
  const low = dashboard.timeline?.length ? accountForecast(state, dashboard, today).giro.lows.find((item) => item.date <= soon) : undefined;
  if (low) lines.push({ label: `Girokonto knapp am ${dateLabel(low.date)}`, value: low.balance, tone: "bad",
    detail: low.cause ? `wegen ${low.cause.kind === "amex" ? "der Amex-Abbuchung" : low.cause.label}` : "laut Kontoprognose" });
  if (amexShortfall > 0.5) lines.push({ label: "Noch auf Amex-Rückzahlung überweisen", value: amexShortfall,
    detail: `offen ${currency(dashboard.amex.outstanding)} · reserviert ${currency(dashboard.amex.reserved)}`, tone: "warn" });
  const surplus = dashboard.current?.surplus;
  if (surplus !== undefined && surplus < 0) lines.push({ label: `${monthLabel(today.slice(0, 7))} geht sich nicht aus`, value: round(surplus),
    detail: "Einnahmen minus Fixkosten, Amex und Plan sind negativ", tone: "bad" });
  const parts = [
    due.length ? `diese Woche ${due.length === 1 ? "ist" : "sind"} ${currency(dueTotal)} fällig` : "diese Woche ist nichts Größeres fällig",
    ...(dueReminders.length ? [`${plural(dueReminders.length, "Erinnerung ist", "Erinnerungen sind")} dran`] : []),
    ...(amexShortfall > 0.5 ? [`für die Amex fehlen noch ${currency(amexShortfall)}`] : []),
    ...(low ? [`am ${dateLabel(low.date)} wird dein Girokonto knapp`] : []),
    ...(surplus !== undefined && surplus < 0 ? [`der Monat liegt ${currency(-surplus)} im Minus`] : []),
    ...increases.slice(0, 2).map((item) => `${item.merchant} wurde teurer`),
    ...behind.slice(0, 2),
    ...(duplicates.length ? [`${plural(duplicates.length, "Abbuchung sieht", "Abbuchungen sehen")} doppelt aus`] : []),
  ];
  const sentence = list(parts);
  return { text: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`,
    card: { kind: "briefing", title: `Wochenüberblick bis ${dateLabel(end)}`, total: dueTotal, lines } };
}

const discretionary: [Category, number][] = [
  ["Lieferdienste", 0.4], ["Restaurants", 0.25], ["Cafés & Snacks", 0.3], ["Mittagessen", 0.2], ["Shopping", 0.25],
  ["Entertainment", 0.25], ["Freizeit", 0.2], ["Guthabenkarten", 0.5], ["Körperpflege", 0.15], ["Lebensmittel", 0.1],
];

// Concrete savings ideas with amounts: cancel subscriptions or spend less where the last three months were high.
export function savingsCoach(state: AppState, today: string, target: number): { text: string; card: AssistantCard } {
  const current = today.slice(0, 7);
  const months = [1, 2, 3].map((offset) => addMonths(current, -offset));
  const spent = new Map<Category, number>();
  for (const { row, category } of ledger(state)) {
    if (row.amount >= 0 || !months.includes(row.date.slice(0, 7))) continue;
    spent.set(category, (spent.get(category) ?? 0) - row.amount);
  }
  const ideas: (Line & { value: number })[] = [];
  for (const [category, share] of discretionary) {
    const average = (spent.get(category) ?? 0) / 3;
    const saving = Math.floor(average * share / 5) * 5;
    if (saving >= 10) ideas.push({ label: `${category}: ${Math.round(share * 100)} % weniger`, value: saving,
      detail: `bisher Ø ${currency(round(average))} pro Monat`, tone: "info" });
  }
  for (const item of detectSubscriptions(state, today)) {
    if (item.monthlyCost < 3) continue;
    ideas.push({ label: `Abo ${item.merchant} kündigen`, value: item.monthlyCost,
      detail: `${item.interval}${item.priceChange ? ", zuletzt teurer geworden" : ""}`, tone: item.priceChange ? "warn" : "info" });
  }
  ideas.sort((a, b) => b.value - a.value);
  const picked: typeof ideas = [];
  let sum = 0;
  for (const idea of ideas) {
    if (sum >= target) break;
    picked.push(idea);
    sum = round(sum + idea.value);
  }
  const reached = sum >= target;
  return {
    text: !ideas.length ? "Ich finde in den letzten drei Monaten keine Ausgaben, bei denen sich Sparen spürbar lohnt."
      : reached ? `So kommst du auf ${currency(sum)} mehr im Monat: ${list(picked.slice(0, 3).map((item) => item.label))}${picked.length > 3 ? " und mehr" : ""}.`
        : `Mit allen Vorschlägen kommst du auf ${currency(sum)} von ${currency(target)} im Monat. Den Rest bräuchte es über Fixkosten oder mehr Einnahmen.`,
    card: { kind: "coach", title: `Spar-Coach · Ziel ${currency(target)} pro Monat`, total: sum, lines: picked.slice(0, 20),
      note: "Basis sind deine Ausgaben der letzten drei vollen Monate. Kündigungen erst prüfen, bevor du sie umsetzt." },
  };
}

export const depotScenarios = [
  { label: "Vorsichtig", rate: 0.03 }, { label: "Mittel", rate: 0.05 }, { label: "Gut", rate: 0.07 },
] as const;
export function futureValue(monthly: number, years: number, start: number, rate: number) {
  const months = Math.round(years * 12);
  const monthlyRate = rate / 12;
  const growth = (1 + monthlyRate) ** months;
  return round(start * growth + (monthlyRate ? monthly * (growth - 1) / monthlyRate : monthly * months));
}

// Compound interest with three assumed returns; a calculation, not investment advice.
export function depotProjection(monthly: number, years: number, start = 0): { text: string; card: AssistantCard } {
  const paid = round(start + monthly * years * 12);
  const lines = depotScenarios.map((scenario) => {
    const value = futureValue(monthly, years, start, scenario.rate);
    return { label: `${scenario.label} (${Math.round(scenario.rate * 100)} % p. a.)`, value, detail: `Ertrag ${currency(round(value - paid))}` };
  });
  const steps = Array.from({ length: Math.max(1, Math.ceil(years)) + 1 }, (_, year) => Math.min(year, years));
  const curve = (rate: number) => steps.map((year) => ({ label: `${Math.round(year * 10) / 10} J.`, value: rate < 0 ? round(start + monthly * year * 12) : futureValue(monthly, year, start, rate) }));
  return {
    text: `Mit ${currency(monthly)} im Monat${start ? ` und ${currency(start)} Start` : ""} hast du nach ${plural(years, "Jahr", "Jahren")} ${currency(paid)} eingezahlt. ` +
      `Je nach Rendite wären es etwa ${currency(lines[0].value)} bis ${currency(lines[2].value)}.`,
    card: { kind: "depot", title: `Depot-Rechner · ${currency(monthly)} / Monat · ${plural(years, "Jahr", "Jahre")}`, total: paid,
      lines: [{ label: "Eingezahlt", value: paid }, ...lines],
      chart: buildChart("line", [{ name: "Eingezahlt", points: curve(-1) }, { name: "Vorsichtig 3 %", points: curve(depotScenarios[0].rate) },
        { name: "Gut 7 %", points: curve(depotScenarios[2].rate) }]),
      note: "Reine Rechnung mit angenommenen Renditen, keine Anlageberatung. Kosten, Steuern (KESt 27,5 %) und Kursschwankungen sind nicht berücksichtigt." },
  };
}

// Collects bookings that may be deductible in the Austrian employee tax assessment, grouped by L1 Kennzahl.
export function taxDeductibles(state: AppState, year: number): { text: string; card: AssistantCard } {
  const folder = taxFolder(state, year);
  const lines: Line[] = folder.groups.map((group) => ({
    label: `${kzLabel(group)} · ${group.label} (${group.count})`, value: group.total,
    detail: `${group.detail}${group.missing ? ` · ${plural(group.missing, "Beleg", "Belege")} aufheben/prüfen` : ""}`.slice(0, 300),
    transactionIds: [...group.rows].sort((a, b) => b.amount - a.amount).slice(0, 50).map((row) => row.id),
  }));
  return {
    text: lines.length
      ? `Für die Arbeitnehmerveranlagung ${year} habe ich ${plural(folder.count, "Buchung", "Buchungen")} über ${currency(folder.total)} gefunden, die absetzbar sein könnten. Die Steuer-Mappe kannst du als CSV oder Druckansicht herunterladen.`
      : `Für ${year} habe ich keine Buchungen gefunden, die typischerweise absetzbar sind.`,
    card: { kind: "tax", title: `Steuer-Mappe · Arbeitnehmerveranlagung ${year}`, year, total: folder.total, lines,
      transactionIds: folder.groups.flatMap((group) => group.rows).sort((a, b) => b.amount - a.amount).slice(0, 50).map((row) => row.id),
      note: `${TAX_FOLDER_NOTE} Pendlerpauschale, Familienbonus und Homeoffice-Pauschale stehen nicht in deinen Umsätzen.` },
  };
}
