import { addMonths, round, type Dashboard } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { ledger } from "@/lib/insights";
import type { AppState, AssistantCard, AssistantMemory, AssistantOperation, Transaction } from "@/lib/types";
import { parseAmount } from "./intent";

type Result = { text: string; card?: AssistantCard; suggestions?: string[] };
type Line = AssistantCard["lines"][number];

const DAY_MS = 86_400_000;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const percent = (value: number) => `${value.toLocaleString("de-AT", { maximumFractionDigits: 1 })} %`;
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const monthNames = ["jänner", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
const monthIndex = (word: string) => {
  const lower = word.toLowerCase();
  if (lower === "januar" || lower === "jan") return 0;
  if (lower === "feber") return 1;
  return monthNames.findIndex((name) => name.startsWith(lower.slice(0, 3)));
};
const monthPattern = "(jänner|januar|feber|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)";
const lastDayOf = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const validDate = (date: string) => !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

// ---------------------------------------------------------------------------
// Kredit- und Ratenrechner
// ---------------------------------------------------------------------------

export const loanQuestion = (lower: string) =>
  /\b(?:kredit|darlehen|finanzierung|finanzieren|ratenkredit|konsumkredit|leasing|ratenzahlung|kreditrate|tilgung|zinsen zahlen)\b/.test(lower) &&
  !/sparziel|depot|\betf\b|was ist|was bedeutet|erklär/.test(lower);

// Monthly annuity payment.
export function annuity(principal: number, yearlyRate: number, months: number) {
  const rate = yearlyRate / 12;
  return rate === 0 ? principal / months : principal * rate / (1 - (1 + rate) ** -months);
}

export function parseLoan(text: string) {
  const lower = text.toLowerCase();
  const rateMatch = /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:%|prozent)/.exec(lower);
  const rate = rateMatch ? Number(rateMatch[1].replace(",", ".")) / 100 : undefined;
  const monthsMatch = /(\d{1,3})\s*(?:monate?n?|raten)\b/.exec(lower);
  const yearsMatch = /(\d{1,2}(?:[.,]5)?)\s*jahre?n?\b/.exec(lower);
  const months = monthsMatch ? Number(monthsMatch[1]) : yearsMatch ? Math.round(Number(yearsMatch[1].replace(",", ".")) * 12) : undefined;
  const rest = lower.replace(/\d{1,2}(?:[.,]\d{1,2})?\s*(?:%|prozent)/g, " ").replace(/\d{1,3}\s*(?:monate?n?|raten|jahre?n?)\b/g, " ");
  const amounts = [...rest.matchAll(/(\d[\d.\s]*(?:,\d{1,2})?)\s*(k\b|tausend)?\s*(?:€|euro)?/g)]
    .map((match) => { const value = parseAmount(match[1].trim()); return value === undefined ? undefined : match[2] ? value * 1000 : value; })
    .filter((value): value is number => value !== undefined && value >= 100 && value <= 2_000_000);
  return { principal: amounts.length ? Math.max(...amounts) : undefined, rate, months: months && months >= 1 && months <= 480 ? months : undefined };
}

export function loanAnswer(text: string, dashboard: Dashboard): Result {
  const { principal, rate, months } = parseLoan(text);
  if (!principal) return { text: "Wie viel möchtest du finanzieren, über wie lange und zu welchem Zinssatz? Zum Beispiel „Kredit 10.000 € auf 5 Jahre zu 6 %“.",
    suggestions: ["Kredit 10.000 € auf 5 Jahre zu 6 %", "Laptop 1.200 € in 12 Raten mit 9,9 %"] };
  const term = months ?? 60;
  const scenarios = rate !== undefined ? [rate] : [0.04, 0.07, 0.1];
  const free = dashboard.current?.surplus;
  const lines: Line[] = scenarios.map((yearly) => {
    const monthly = round(annuity(principal, yearly, term));
    const interest = round(monthly * term - principal);
    return { label: `${rate === undefined ? "Bei " : ""}${percent(yearly * 100)} Sollzins`, value: monthly,
      detail: `Monatsrate · Zinsen gesamt ${currency(interest)} · zurück gesamt ${currency(round(principal + interest))}`,
      ...(free !== undefined ? { tone: monthly > free ? "bad" as const : monthly > free * 0.5 ? "warn" as const : "good" as const } : {}) };
  });
  const main = lines[rate === undefined ? 1 : 0].value!;
  const interest = round(main * term - principal);
  const saveMonths = Math.ceil(principal / main);
  lines.push({ label: "Stattdessen ansparen", detail: `mit ${currency(main)} im Monat hättest du ${currency(principal)} in ${plural(saveMonths, "Monat", "Monaten")} beisammen, ohne Zinsen`, tone: "info" });
  if (free !== undefined) lines.push({ label: `Frei im ${monthLabel(dashboard.currentMonth)}`, value: round(free),
    detail: free <= 0 ? "der Monat geht sich schon jetzt nicht aus" : `die Rate wären ${percent(Math.round(main / free * 1000) / 10)} davon`, tone: free <= 0 || main > free ? "bad" : "info" });
  const verdict = free === undefined ? "" : main > free ? " Die Rate ist höher als das, was dir im Monat frei bleibt; das würde ich nicht machen."
    : main > free * 0.5 ? " Das geht sich aus, frisst aber mehr als die Hälfte deines freien Geldes." : " Das ginge sich mit deinem Monatsplan aus.";
  return {
    text: `${currency(principal)} über ${plural(term, "Monat", "Monate")}${rate === undefined ? " bei 7 % Sollzins" : ` zu ${percent(rate * 100)}`}: ` +
      `${currency(main)} im Monat, ${currency(interest)} Zinsen insgesamt.${verdict}${months ? "" : " Ich habe 5 Jahre Laufzeit angenommen."}`,
    card: { kind: "loan", title: `Kreditrechner · ${currency(principal)} · ${plural(term, "Monat", "Monate")}`, total: main, lines,
      note: "Annuitätenrechnung mit festem Sollzins; Bearbeitungsgebühren, Versicherungen und Effektivzins der Bank sind nicht enthalten. Keine Kreditberatung." },
    suggestions: [`Kann ich mir ${currency(principal)} leisten?`, "Was ist der Effektivzins?"],
  };
}

// ---------------------------------------------------------------------------
// Erinnerungen
// ---------------------------------------------------------------------------

export const reminderRequest = (lower: string) => /\berinner(?:e|st)?\s+mich\b|\berinnerung\s+(?:für|am|an|setzen|anlegen|erstellen)\b|\bsag mir (?:am|in|bis)\b/.test(lower);
export const reminderListQuestion = (lower: string) => /\b(?:welche|meine|alle|offene[n]?|zeig(?:e)? (?:mir )?(?:die|meine)?)\s+erinnerungen\b|\berinnerungen\s*\??$|\bworan (?:soll|musst) (?:ich|du)\b/.test(lower);

// Understands "am 1. Dezember", "am 3.12.", "morgen", "in 2 Wochen", "nächsten Montag", "Ende des Monats", "im März".
export function parseDue(text: string, today: string): string | undefined {
  const lower = text.toLowerCase();
  const year = Number(today.slice(0, 4));
  const future = (date: string) => date < today ? `${Number(date.slice(0, 4)) + 1}${date.slice(4)}` : date;
  const numeric = /\b(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2})\b)?/.exec(lower);
  if (numeric) {
    const y = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : year;
    const date = `${y}-${String(Number(numeric[2])).padStart(2, "0")}-${String(Number(numeric[1])).padStart(2, "0")}`;
    if (validDate(date)) return numeric[3] ? date : future(date);
  }
  const named = new RegExp(`\\b(\\d{1,2})\\.?\\s+${monthPattern}(?:\\s+(\\d{4}))?`).exec(lower);
  if (named) {
    const date = `${named[3] ?? year}-${String(monthIndex(named[2]) + 1).padStart(2, "0")}-${String(Number(named[1])).padStart(2, "0")}`;
    if (validDate(date)) return named[3] ? date : future(date);
  }
  if (/(?<!\p{L})übermorgen(?!\p{L})/u.test(lower)) return shiftDate(today, 2);
  if (/(?<!\p{L})morgen(?!\p{L})/u.test(lower)) return shiftDate(today, 1);
  if (/\bheute\b/.test(lower)) return today;
  const relative = /\bin\s+(\d{1,3}|einem|einer|zwei|drei|vier)\s+(tag|tagen|woche|wochen|monat|monaten)\b/.exec(lower);
  if (relative) {
    const count = ({ einem: 1, einer: 1, zwei: 2, drei: 3, vier: 4 } as Record<string, number>)[relative[1]] ?? Number(relative[1]);
    if (relative[2].startsWith("tag")) return shiftDate(today, count);
    if (relative[2].startsWith("woche")) return shiftDate(today, count * 7);
    const month = addMonths(today.slice(0, 7), count);
    const day = Math.min(Number(today.slice(8)), Number(lastDayOf(month).slice(8)));
    return `${month}-${String(day).padStart(2, "0")}`;
  }
  const weekdays = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"];
  const weekday = new RegExp(`\\b(?:am\\s+|nächsten\\s+|kommenden\\s+)?(${weekdays.join("|")})\\b`).exec(lower);
  if (weekday) {
    const current = new Date(`${today}T00:00:00Z`).getUTCDay();
    const diff = (weekdays.indexOf(weekday[1]) - current + 7) % 7 || 7;
    return shiftDate(today, diff);
  }
  if (/nächste woche|kommende woche/.test(lower)) return shiftDate(today, 7);
  if (/ende (?:des|vom|dieses) monats|monatsende/.test(lower)) return lastDayOf(today.slice(0, 7));
  if (/anfang (?:des )?nächsten monats|nächsten monat|kommenden monat/.test(lower)) return `${addMonths(today.slice(0, 7), 1)}-01`;
  if (/ende des jahres|jahresende/.test(lower)) return `${year}-12-31`;
  const month = new RegExp(`\\b(?:im|anfang|ende)\\s+${monthPattern}(?:\\s+(\\d{4}))?`).exec(lower);
  if (month) {
    const key = `${month[2] ?? year}-${String(monthIndex(month[1]) + 1).padStart(2, "0")}`;
    const date = lower.includes(`ende ${month[1]}`) ? lastDayOf(key) : `${key}-01`;
    return month[2] ? date : future(date);
  }
  return undefined;
}

// Removes the command and the date words, so only the task remains ("Kfz-Versicherung kündigen").
export function reminderTask(text: string) {
  return text
    .replace(/^\s*(?:bitte\s+)?(?:kannst du\s+)?(?:erinner(?:e|st)?\s+mich|sag mir|erinnerung(?:\s+(?:setzen|anlegen|erstellen))?)\s*(?:bitte\s+)?/i, "")
    .replace(new RegExp(`\\b(?:am|bis|ab|zum)?\\s*\\d{1,2}\\.?\\s*(?:\\d{1,2}\\.(?:\\s?\\d{2,4})?|${monthPattern}(?:\\s+\\d{4})?)`, "gi"), " ")
    .replace(/(?<!\p{L})(?:übermorgen|morgen|heute|in\s+(?:\d{1,3}|einem|einer|zwei|drei|vier)\s+(?:tag|tagen|woche|wochen|monat|monaten)|nächste woche|kommende woche|ende (?:des|vom|dieses) monats|monatsende|anfang (?:des )?nächsten monats|nächsten monat|kommenden monat|ende des jahres|jahresende)(?!\p{L})/giu, " ")
    .replace(/\b(?:am\s+|nächsten\s+|kommenden\s+)?(?:sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)\b/gi, " ")
    .replace(new RegExp(`\\b(?:im|anfang|ende)\\s+${monthPattern}(?:\\s+\\d{4})?`, "gi"), " ")
    .replace(/^\s*(?:bitte|mal|doch)(?!\p{L})\s*/iu, "")
    .replace(/^\s*[,:]?\s*(?:daran|dran)?\s*,?\s*(?:dass ich|dass|an|zu|daran zu|ans|ich soll|ich muss)?\s+/i, "")
    .replace(/\s+(?:zu|bitte)\s*[.!?]*\s*$/i, "")
    .replace(/^(?:die|den|das|der|meine[nm]?|mein)\s+/i, "")
    .replace(/\s+zu\s+(\p{L}+(?:en|ern|eln))\s*$/iu, " $1")
    .replace(/\s{2,}/g, " ").replace(/[\s,.!?]+$/, "").trim();
}

export function parseReminder(text: string, today: string): Extract<AssistantOperation, { op: "memory_add" }> | string {
  const due = parseDue(text, today);
  const task = reminderTask(text);
  if (task.length < 3) return "Woran soll ich dich erinnern? Zum Beispiel „Erinner mich am 1. Dezember, die Kfz-Versicherung zu kündigen“.";
  if (!due) return `Wann soll ich dich an „${task}“ erinnern? Zum Beispiel „am 1. Dezember“ oder „in 2 Wochen“.`;
  const label = task.charAt(0).toUpperCase() + task.slice(1);
  return { op: "memory_add", key: "reminder", due, text: `${label} (${dateLabel(due)})`.slice(0, 200) };
}

export const reminders = (state: AppState): AssistantMemory[] =>
  (state.assistantMemory ?? []).filter((entry) => entry.key === "reminder" && entry.due).sort((a, b) => a.due!.localeCompare(b.due!));

export function reminderLines(state: AppState, today: string, until: string): Line[] {
  return reminders(state).filter((entry) => entry.due! <= until).map((entry) => ({
    label: `Erinnerung: ${entry.text.replace(/\s*\([^)]*\)$/, "")}`,
    detail: entry.due! < today ? `überfällig seit ${dateLabel(entry.due!)}` : entry.due === today ? "heute" : dateLabel(entry.due!),
    tone: entry.due! < today ? "bad" as const : "warn" as const,
  }));
}

export function reminderList(state: AppState, today: string): Result {
  const items = reminders(state);
  if (!items.length) return { text: "Du hast keine Erinnerungen. Sag zum Beispiel „Erinner mich am 1. Dezember, die Kfz-Versicherung zu kündigen“.",
    suggestions: ["Erinner mich morgen, die Miete zu überweisen"] };
  const overdue = items.filter((entry) => entry.due! < today).length;
  return {
    text: `Du hast ${plural(items.length, "Erinnerung", "Erinnerungen")}${overdue ? `, ${overdue} davon überfällig` : ""}. Fällige zeige ich dir auch im Wochenüberblick.`,
    card: { kind: "memory", title: "Erinnerungen", lines: items.slice(0, 40).map((entry) => ({
      label: entry.text.replace(/\s*\([^)]*\)$/, ""),
      detail: entry.due! < today ? `überfällig seit ${dateLabel(entry.due!)}` : entry.due === today ? "heute" : dateLabel(entry.due!),
      tone: entry.due! < today ? "bad" as const : entry.due! <= shiftDate(today, 6) ? "warn" as const : "info" as const })),
      note: "Erledigt? Sag „Vergiss die Erinnerung …“ oder lösch sie unter „Gedächtnis“." },
  };
}

// ---------------------------------------------------------------------------
// Jahresrückblick
// ---------------------------------------------------------------------------

export const reviewQuestion = (lower: string) =>
  /jahresrückblick|jahresbilanz|jahresabschluss|jahresübersicht|rückblick|bilanz (?:für|von|über) (?:20\d{2}|dieses jahr|das jahr|heuer)|wie war (?:mein|das) (?:jahr|20\d{2})|mein (?:finanz)?jahr(?: 20\d{2})?\s*(?:zusammengefasst|im überblick)|(?:fass|fasse) (?:mein|das) jahr|wrapped/.test(lower);

const merchantOf = (row: Transaction) => row.merchantAlias?.trim() || row.description.trim().slice(0, 60);

export function yearReview(state: AppState, text: string, today: string): Result {
  const lower = text.toLowerCase();
  const explicit = /\b(20\d{2})\b/.exec(lower);
  const year = explicit ? Number(explicit[1]) : /letztes jahr|vorjahr|voriges jahr/.test(lower) ? Number(today.slice(0, 4)) - 1 : Number(today.slice(0, 4));
  const entries = ledger(state);
  const ofYear = (value: number) => entries.filter(({ row }) => row.date.startsWith(`${value}-`) && row.date <= today);
  const sums = (list: ReturnType<typeof ofYear>) => {
    const income = round(list.filter(({ row, category }) => row.amount > 0 && isIncomeCategory(category)).reduce((sum, { row }) => sum + row.amount, 0));
    const spending = round(list.filter(({ row }) => row.amount < 0).reduce((sum, { row }) => sum - row.amount, 0));
    return { income, spending };
  };
  const current = ofYear(year);
  if (!current.length) return { text: `Für ${year} habe ich keine Buchungen.` };
  const { income, spending } = sums(current);
  const months = new Set(current.map(({ row }) => row.date.slice(0, 7))).size;
  const saved = round(income - spending);
  const rate = income > 0 ? Math.round(saved / income * 1000) / 10 : undefined;
  const byCategory = new Map<string, { total: number; ids: Transaction[] }>();
  const byMonth = new Map<string, number>();
  const byMerchant = new Map<string, number>();
  for (const { row, category } of current) {
    if (row.amount >= 0) continue;
    const item = byCategory.get(category) ?? { total: 0, ids: [] };
    item.total += -row.amount; item.ids.push(row);
    byCategory.set(category, item);
    byMonth.set(row.date.slice(0, 7), (byMonth.get(row.date.slice(0, 7)) ?? 0) - row.amount);
    byMerchant.set(merchantOf(row), (byMerchant.get(merchantOf(row)) ?? 0) - row.amount);
  }
  const topCategories = [...byCategory].sort((a, b) => b[1].total - a[1].total).slice(0, 5);
  const biggest = current.filter(({ row }) => row.amount < 0).sort((a, b) => a.row.amount - b.row.amount)[0]?.row;
  const topMerchant = [...byMerchant].sort((a, b) => b[1] - a[1])[0];
  const peak = [...byMonth].sort((a, b) => b[1] - a[1])[0];
  const quiet = [...byMonth].sort((a, b) => a[1] - b[1])[0];
  const before = sums(ofYear(year - 1).filter(({ row }) => row.date.slice(5) <= (year === Number(today.slice(0, 4)) ? today.slice(5) : "12-31")));
  const lines: Line[] = [
    { label: "Einnahmen", value: income, tone: "good" },
    { label: "Ausgaben", value: -spending },
    { label: saved >= 0 ? "Übrig geblieben" : "Mehr ausgegeben als eingenommen", value: saved, tone: saved >= 0 ? "good" : "bad",
      detail: rate !== undefined ? `Sparquote ${percent(rate)}${rate >= 20 ? " · stark" : rate >= 10 ? " · solide" : rate >= 0 ? " · ausbaufähig" : ""}` : undefined },
    ...topCategories.map(([category, item], index) => ({ label: `${index + 1}. ${category}`, value: -round(item.total),
      detail: `${percent(Math.round(item.total / spending * 1000) / 10)} der Ausgaben · Ø ${currency(round(item.total / months))} pro Monat`,
      transactionIds: [...item.ids].sort((a, b) => a.amount - b.amount).slice(0, 50).map((row) => row.id) })),
  ];
  if (biggest) lines.push({ label: `Größte Ausgabe: ${merchantOf(biggest)}`, value: biggest.amount, detail: dateLabel(biggest.date), transactionIds: [biggest.id] });
  if (topMerchant) lines.push({ label: `Meistes Geld bei: ${topMerchant[0]}`, value: -round(topMerchant[1]) });
  if (peak && quiet && peak[0] !== quiet[0]) lines.push({ label: `Teuerster Monat: ${monthLabel(peak[0])}`, value: -round(peak[1]),
    detail: `sparsamster: ${monthLabel(quiet[0])} mit ${currency(round(quiet[1]))}` });
  if (before.spending > 0) {
    const delta = round(spending - before.spending);
    lines.push({ label: `Ausgaben ggü. ${year - 1}`, value: delta, detail: `gleicher Zeitraum ${year - 1}: ${currency(before.spending)}`, tone: delta > 0 ? "warn" : "good" });
  }
  const running = year === Number(today.slice(0, 4));
  return {
    text: `${running ? `Dein Jahr ${year} bis jetzt` : `Dein Jahr ${year}`}: ${currency(income)} rein, ${currency(spending)} raus` +
      `${rate !== undefined ? `, Sparquote ${percent(rate)}` : ""}. Am meisten ging für ${topCategories[0]?.[0] ?? "Sonstiges"} weg` +
      `${before.spending > 0 ? `, und du hast ${spending > before.spending ? "mehr" : "weniger"} ausgegeben als im gleichen Zeitraum ${year - 1}` : ""}.`,
    card: { kind: "review", title: `Jahresrückblick ${year}${running ? ` · bis ${dateLabel(today)}` : ""}`, total: saved, lines, year,
      note: "Umbuchungen zwischen deinen Konten und noch offene Prüfungen zählen nicht mit." },
    suggestions: [`Wie war ${year - 1}?`, "Ich will 200 € mehr im Monat sparen", "Bin ich sparsam?"],
  };
}
