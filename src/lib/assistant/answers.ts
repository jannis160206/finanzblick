import { addMonths, round, type Dashboard } from "@/lib/calc";
import { canonicalCategory, categories, type Category } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { detectDuplicateCharges, detectSubscriptions, forecastMonth, ledger } from "@/lib/insights";
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
  const monthPeriod = (month: string) => monthPeriodOf(month, today);
  const yearPeriod = (value: number) => yearPeriodOf(value, today);
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
  [/tanken|sprit|benzin|diesel/, ["Tanken"], "Tanken"],
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
  [/entertainment|kino|streaming|games|spiele/, ["Entertainment"], "Entertainment"],
  [/gesundheit|apotheke|\barzt\b/, ["Gesundheit"], "Gesundheit"],
  [/drogerie/, ["Drogerie"], "Drogerie"],
  [/körperpflege|friseur|frisör|barber/, ["Körperpflege"], "Körperpflege"],
  [/geschenk|spende/, ["Geschenke & Spenden"], "Geschenke & Spenden"],
  [/weiterbildung|fortbildung|bildung|\bkurs|bücher/, ["Bildung", "Weiterbildung"], "Bildung"],
  [/haustier|katze|hund/, ["Haustiere"], "Haustiere"],
  [/gebühr/, ["Bankgebühren", "Rücklastschriftgebühren"], "Gebühren"],
  [/guthaben/, ["Guthabenkarten"], "Guthabenkarten"],
];

export function findCategories(text: string): { categories: Category[]; label: string } | undefined {
  const plain = normalizeSearch(text);
  const exact = [...categories].sort((a, b) => b.length - a.length).find((category) => {
    const name = normalizeSearch(category);
    return plain.includes(name) || (name.length > 5 && plain.includes(name.slice(0, -1)));
  });
  if (exact) return { categories: [exact], label: exact };
  const lower = text.toLowerCase();
  const match = categoryWords.find(([pattern]) => pattern.test(lower));
  return match ? { categories: match[1], label: match[2] } : undefined;
}

const nonMerchant = /^(?:essen|lebensmittel|abos?|monat|jahr|woche|heuer|urlaub|auto|miete|tanken|kaffee|shopping|kategorie|ausgaben|einnahmen|mich|mir|das|die|der|den|dem|ein|eine|amex|american|express|kreditkarte|karte|revolut|raiffeisen|giro|girokonto|konto|trade|republic|seit|heute|aktuell)$/i;

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

type QueryMetric = "subscriptions" | "largest" | "income" | "count" | "average" | "breakdown" | "compare" | "trend" | "sum";
export const trendPattern = /entwickelt|entwicklung|verlauf|\btrend\b|monat für monat|monat fuer monat|jeden monat|über die (?:letzten )?monate|ueber die monate|monatsverlauf|von monat zu monat/;
export const comparePattern = /vergleich|verglichen|gegenüber|\bvs\.?(?=\s)|\bversus\b|mehr oder weniger|(?:mehr|weniger)\b[^?.!]{0,30}?\bals (?:im |in |letzten |vorigen |den |der )?(?:vormonat|monat davor|letzten monat|vorigen monat|jänner|januar|februar|feber|märz|april|mai|juni|juli|august|september|oktober|november|dezember)/;
export function queryMetric(text: string): QueryMetric {
  const lower = text.toLowerCase();
  if (comparePattern.test(lower)) return "compare";
  if (trendPattern.test(lower)) return "trend";
  if (/\babos?\b|abonnement/.test(lower) && !/\bbei\b/.test(lower)) return "subscriptions";
  if (/größte|grösste|teuerste|höchste|meiste geld|top\s*\d*/.test(lower)) return "largest";
  if (/\b(?:warum|wieso|weshalb)\b.*\bso\s+(?:viel|hoch|teuer)|woher kommt/.test(lower)) return "largest";
  if (/verdient|einnahmen|eingenommen|reinbekommen|gehalt bekommen|eingegangen/.test(lower)) return "income";
  if (/wie oft|wie viele (?:mal|male|buchungen|käufe|einkäufe)|wievielmal/.test(lower)) return "count";
  if (/durchschnitt|im schnitt|pro monat|monatlich|je monat/.test(lower)) return "average";
  if (/wofür|wohin|aufteilung|aufgeteilt|nach kategorie|welche kategorie|verteilt/.test(lower)) return "breakdown";
  return "sum";
}

const idsOf = (rows: Transaction[]) => [...rows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 50).map((row) => row.id);

// Answers a data question with fixed queries; the model never produces a number.
// `previous` holds earlier questions (latest first), so "und im September?" keeps the category of the question before.
export function answerQuestion(state: AppState, text: string, today: string, hints: { merchant?: string; category?: string } = {}, previous: string[] = []): { text: string; card: AssistantCard } {
  const ownMetric = queryMetric(text);
  const metric = ownMetric === "sum" ? previous.map(queryMetric).find((item) => item !== "sum" && item !== "compare") ?? "sum" : ownMetric;
  if (metric === "subscriptions") {
    const subscriptions = detectSubscriptions(state, today);
    const total = round(subscriptions.reduce((sum, item) => sum + item.monthlyCost, 0));
    return {
      text: subscriptions.length
        ? `Für ${plural(subscriptions.length, "Abo", "Abos")} gehen im Schnitt ${currency(total)} pro Monat weg (${currency(round(total * 12))} im Jahr).`
        : "Ich habe keine laufenden Abos in deinen Buchungen erkannt.",
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
  const hintCategory = hints.category && categories.includes(hints.category as never) ? { categories: [hints.category as Category], label: hints.category } : undefined;
  // A bank or card question is about the account, so a model category guess like "Abonnements" is ignored.
  const filter = ownFilter ?? (inherit ? findCategories(inherit) : undefined) ?? (bank ? undefined : hintCategory);
  const merchant = ownMerchant ?? (inherit && !ownFilter ? findMerchant(state, inherit) : undefined);
  const wanted = filter ? new Set(filter.categories.map(canonicalCategory)) : undefined;
  const entries = ledger(state).filter(({ row, category }) => row.date >= period.from && row.date <= period.to &&
    (!wanted || wanted.has(category)) && (!merchant || matchesTransactionSearch(row, merchant)) && (!bank || bank.pattern.test(row.bank.trim())));
  const scope = [bank?.label, merchant, filter?.label].filter(Boolean).join(" · ") || "Alle Ausgaben";
  const title = `${metric === "income" ? "Einnahmen" : scope} · ${period.label}`;
  const month = period.month;
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
  const breakdown = (metric === "breakdown" || (!filter && !merchant) || (filter && filter.categories.length > 1)) && byCategory.size > 1 ? byCategory : byMerchant;
  const lines: Line[] = [...breakdown].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({
    label, value, detail: `${Math.round(value / total * 100)} %` }));
  const card: AssistantCard = { kind: "answer", title, total, lines, transactionIds: idsOf(rows), ...(month ? { month } : {}) };
  if (metric === "count") return { text: `${plural(rows.length, "Buchung", "Buchungen")} im Zeitraum ${period.label} für ${scope}, zusammen ${currency(total)}.`, card };
  if (metric === "average") {
    const average = round(total / Math.max(1, period.months));
    return { text: `Im Schnitt ${currency(average)} pro Monat für ${scope} (${period.label}, gesamt ${currency(total)}).`, card: { ...card, total: average,
      note: `Durchschnitt über ${plural(period.months, "Monat", "Monate")}; der laufende Monat zählt mit.` } };
  }
  return { text: `Für ${scope} hast du im Zeitraum ${period.label} ${currency(total)} ausgegeben (${plural(rows.length, "Buchung", "Buchungen")}).`, card };
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
  // "mehr als im Vormonat?" compares the month asked before (or this month) with its previous one; "mehr als im September?" with September.
  if (/\bals\s+(?:im\s+|in\s+|der\s+)?(?:vormonat|monat davor|letzten monat|vorigen monat)/.test(lower) && months.length <= 1) {
    const base = earlier ?? monthPeriodOf(today.slice(0, 7), today);
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
    ? `Im ${a.label} hast du${forWhat} genauso viel ausgegeben wie im ${b.label}: ${currency(totalA)}.`
    : `Im ${a.label}${running} hast du${forWhat} ${currency(totalA)} ausgegeben, ${currency(Math.abs(diff))} ${diff > 0 ? "mehr" : "weniger"} als im ${b.label} (${currency(totalB)}).`;
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
