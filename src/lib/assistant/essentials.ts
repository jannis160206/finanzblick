import { actualBookings, addMonths, classify, round, type Dashboard } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { detectDuplicateCharges, detectSubscriptions, ledger, summarizeMonth } from "@/lib/insights";
import { netWorthHistory } from "@/lib/net-worth";
import { reconcileSharedHoliday } from "@/lib/shared-holiday";
import type { AppState, AssistantCard, Transaction } from "@/lib/types";
import { buildChart, shortMonth } from "./chart";

type Line = AssistantCard["lines"][number];
type Result = { text: string; card?: AssistantCard; suggestions?: string[] };

const DAY_MS = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const merchantOf = (row: Transaction) => row.merchantAlias?.trim() || row.description.trim().slice(0, 60);
const fold = (value: string) => value.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
const merchantKey = (row: Transaction) => (row.merchantAlias ?? row.description).trim().toLocaleLowerCase("de-AT");
const merchantLabel = (row: Transaction) => (row.merchantAlias?.trim() || row.description.trim()).slice(0, 40);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : 0;
};
const shiftDate = shift;

export type WatchAlertKind = "reminder" | "duplicate" | "buffer" | "amex" | "budget" | "booking" | "price" | "renewal";
export type WatchAlert = { key: string; kind: WatchAlertKind; title: string; detail: string; tone: "info" | "warn" | "bad" };

// New spending that stands out: large, or far above what this category usually costs, and not a known recurring amount.
export function unusualBookings(state: AppState, today: string, known: Set<string>, days = 21): WatchAlert[] {
  // Bookings still waiting for review count too: new imports usually land there first.
  const rows = state.transactions.flatMap((row) => {
    try {
      const result = classify(row);
      return result.isTransfer ? [] : [{ row, category: result.category }];
    } catch { return []; }
  });
  const fresh = rows.filter(({ row }) => !known.has(row.id) && row.amount < 0 && row.date >= shiftDate(today, -days) && row.date <= today);
  const freshIds = new Set(fresh.map(({ row }) => row.id));
  const alerts: WatchAlert[] = [];
  for (const { row, category } of fresh) {
    const amount = Math.abs(row.amount);
    const since = shiftDate(row.date, -365);
    const history = rows.filter((entry) => !freshIds.has(entry.row.id) && entry.row.amount < 0 && entry.row.date >= since && entry.row.date < row.date);
    const expected = history.some((entry) => merchantKey(entry.row) === merchantKey(row) && Math.abs(Math.abs(entry.row.amount) - amount) <= amount * 0.15);
    if (expected) continue;
    const usual = median(history.filter((entry) => entry.category === category).map((entry) => Math.abs(entry.row.amount)));
    if (amount < 400 && !(amount >= 100 && usual > 0 && amount >= usual * 3)) continue;
    alerts.push({ key: `booking:${row.id}`, kind: "booking", tone: "warn",
      title: `Große Ausgabe: ${merchantLabel(row)}`,
      detail: `${currency(-amount)} am ${dateLabel(row.date)}${usual > 0 && amount >= usual * 3 ? ` · sonst ca. ${currency(-round(usual))}` : ""}` });
  }
  return alerts;
}

const monthNames = ["jänner|januar|jaenner", "februar|feber", "märz|maerz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];

// ---------- Sicherheits-Check ----------

export const securityQuestion = (lower: string) =>
  /verdächtig|verdaechtig|betrug|\bfraud\b|gehackt|missbrauch|unbekannte (?:buchung|abbuchung|zahlung|lastschrift)|nicht von mir|kenne ich nicht|sicherheits-?check|auffällig\w* (?:buchung|abbuchung)|auffaellig\w* (?:buchung|abbuchung)|komische (?:buchung|abbuchung)|seltsame (?:buchung|abbuchung)/.test(lower) ||
  /doppelt (?:abgebucht|bezahlt|belastet|verrechnet)|zweimal (?:abgebucht|bezahlt|belastet)|doppelte (?:abbuchung|zahlung|buchung)/.test(lower) ||
  /(?:abos?|verträge|vertraege|preise?)\b.*\b(?:teurer|preiserhöhung|preiserhoehung|erhöht|erhoeht)|preiserhöhung|preiserhoehung/.test(lower) ||
  /neue (?:abos?|abonnements?|verträge|vertraege|lastschriften)\b|(?:abo|abonnement) (?:dazugekommen|abgeschlossen)/.test(lower);

export function securityCheck(state: AppState, today: string): Result {
  const lines: Line[] = [];
  const duplicates = detectDuplicateCharges(state, shift(today, -60));
  for (const item of duplicates)
    lines.push({ label: `Doppelt abgebucht? ${item.merchant}`, value: -Math.abs(item.amount), tone: "bad",
      detail: `gleicher Betrag am ${dateLabel(item.dates[0])} und ${dateLabel(item.dates[1])} – beim Händler/der Bank nachfragen`, transactionIds: [...item.ids] });
  const unusual = unusualBookings(state, today, new Set(state.transactions.filter((row) => row.date < shift(today, -30)).map((row) => row.id)), 30);
  for (const item of unusual) lines.push({ label: item.title, tone: "warn", detail: item.detail });
  // Card testing: tiny charges from merchants never seen before.
  const rows = state.transactions.filter((row) => !classify(row).isTransfer);
  const seen = new Set(rows.filter((row) => row.date < shift(today, -30)).map((row) => fold(merchantOf(row))));
  const tiny = rows.filter((row) => row.amount < 0 && row.amount > -2 && row.date >= shift(today, -30) && row.date <= today && !seen.has(fold(merchantOf(row))));
  for (const row of tiny.slice(0, 5))
    lines.push({ label: `Mini-Abbuchung: ${merchantOf(row)}`, value: row.amount, tone: "warn",
      detail: `${dateLabel(row.date)} · unbekannter Händler – Betrüger testen Karten oft mit Kleinstbeträgen`, transactionIds: [row.id] });
  const subscriptions = detectSubscriptions(state, today);
  const raised = subscriptions.filter((item) => item.priceChange && item.priceChange.date >= shift(today, -120));
  for (const item of raised)
    lines.push({ label: `${item.merchant} wurde teurer`, value: -item.priceChange!.to, tone: "warn",
      detail: `${currency(item.priceChange!.from)} → ${currency(item.priceChange!.to)} (+${item.priceChange!.percent.toLocaleString("de-AT")} %) seit ${dateLabel(item.priceChange!.date)}` });
  const fresh = subscriptions.filter((item) => item.count <= 2 && item.lastDate >= shift(today, -62));
  for (const item of fresh)
    lines.push({ label: `Neues Abo: ${item.merchant}`, value: -item.amount, tone: "info", detail: `${item.interval} · erkannt seit ${dateLabel(item.lastDate)} – gewollt?` });
  const problems = duplicates.length + unusual.length + tiny.length;
  const parts = [
    problems ? `Ich habe ${problems === 1 ? "eine auffällige Buchung" : `${problems} auffällige Buchungen`} gefunden – bitte kurz prüfen.` : "Alles in Ordnung: keine doppelten, ungewöhnlich hohen oder verdächtigen Kleinst-Abbuchungen in den letzten Wochen.",
    duplicates.length ? `Möglicherweise doppelt: ${duplicates.slice(0, 3).map((item) => `${item.merchant} (${currency(Math.abs(item.amount))})`).join(", ")}.` : "",
    tiny.length ? `${tiny.length === 1 ? "Eine Mini-Abbuchung" : `${tiny.length} Mini-Abbuchungen`} von unbekannten Händlern – wenn sie nicht von dir ist, Karte sperren lassen.` : "",
    raised.length ? `Teurer geworden: ${raised.slice(0, 3).map((item) => item.merchant).join(", ")}.` : "",
    fresh.length ? `Neu dazugekommen: ${fresh.slice(0, 3).map((item) => item.merchant).join(", ")}.` : "",
  ].filter(Boolean);
  return {
    text: parts.join(" "),
    card: { kind: "check", title: "Sicherheits-Check", lines: lines.length ? lines.slice(0, 40) : [{ label: "Keine Auffälligkeiten", tone: "good", detail: "letzte 30–60 Tage geprüft" }],
      note: "Geprüft: doppelte Abbuchungen (60 Tage), ungewöhnlich hohe Beträge und Kleinstbeträge unbekannter Händler (30 Tage), Preiserhöhungen und neue Abos. Kartensperre in Österreich: 0800 204 8800." },
    suggestions: ["Welche Abos kann ich kündigen?", "Wie war mein letzter Monat?", "Was wird diesen Monat noch abgebucht?"],
  };
}

// ---------- Monatsbericht ----------

export const monthReviewQuestion = (lower: string) =>
  /monatsbericht|monatsrückblick|monatsrueckblick|monatsabschluss|monatsbilanz|monatsauswertung/.test(lower) ||
  new RegExp(`wie (?:war|lief|ist .* gelaufen) (?:mein |der |das |im )?(?:letzte[rn]? |vorige[rn]? )?(?:monat|${monthNames.join("|")})\\b`).test(lower) ||
  /(?:fass|fasse) (?:mir )?(?:meinen|den|diesen|letzten) monat (?:\S+ )?zusammen|bilanz (?:für|fuer|vom|von) (?:letzten|diesen|den) monat/.test(lower);

export function reviewMonth(text: string, today: string): string {
  const lower = text.toLowerCase();
  const current = today.slice(0, 7);
  const index = monthNames.findIndex((names) => new RegExp(`\\b(?:${names})\\b`).test(lower));
  if (index >= 0) {
    const year = /\b(20\d{2})\b/.exec(lower)?.[1];
    const candidate = `${year ?? current.slice(0, 4)}-${String(index + 1).padStart(2, "0")}`;
    return !year && candidate > current ? addMonths(candidate, -12) : candidate;
  }
  if (/diese[nmr]? monat|aktuelle[nr]? monat|bisher/.test(lower)) return current;
  if (/letzte|vorige|vergangene|monatsbericht|monatsabschluss|monatsbilanz|monatsrückblick|monatsrueckblick/.test(lower) || Number(today.slice(8, 10)) <= 5) return addMonths(current, -1);
  return current;
}

export function monthReview(state: AppState, text: string, today: string): Result {
  const month = reviewMonth(text, today);
  const summary = summarizeMonth(state, month);
  if (!summary.income && !summary.spending) return { text: `Für ${monthLabel(month)} habe ich keine Buchungen.`, suggestions: ["Wie war mein Jahr?"] };
  const previous = summarizeMonth(state, addMonths(month, -1));
  const history = [1, 2, 3].map((back) => summarizeMonth(state, addMonths(month, -back)).spending).filter((value) => value > 0);
  const average = history.length ? round(history.reduce((sum, value) => sum + value, 0) / history.length) : 0;
  const running = month === today.slice(0, 7);
  const rate = summary.income > 0 ? Math.round(summary.balance / summary.income * 1000) / 10 : undefined;
  const lines: Line[] = [
    { label: "Einnahmen", value: summary.income, tone: "good" },
    { label: "Ausgaben", value: -summary.spending, detail: average ? `Ø der 3 Monate davor: ${currency(average)}` : undefined,
      tone: average && summary.spending > average * 1.1 ? "warn" : "info" },
    { label: summary.balance >= 0 ? "Übrig geblieben" : "Mehr ausgegeben als eingenommen", value: summary.balance, tone: summary.balance >= 0 ? "good" : "bad",
      detail: rate !== undefined ? `Sparquote ${rate.toLocaleString("de-AT")} %` : undefined },
  ];
  const before = new Map(previous.topCategories.map((item) => [item.category, item.amount]));
  for (const item of summary.topCategories) {
    const last = before.get(item.category);
    lines.push({ label: item.category, value: -item.amount,
      detail: last !== undefined ? `${item.amount >= last ? "+" : "−"}${currency(Math.abs(round(item.amount - last)))} ggü. ${monthLabel(previous.month)}` : `neu ggü. ${monthLabel(previous.month)}` });
  }
  for (const item of summary.largest) lines.push({ label: `Größte Ausgabe: ${item.merchant}`, value: item.amount, detail: `${dateLabel(item.date)} · ${item.category}` });
  const delta = previous.spending ? round(summary.spending - previous.spending) : 0;
  const top = summary.topCategories[0];
  const text_ = [
    `${monthLabel(month)}${running ? " bis jetzt" : ""}: ${currency(summary.income)} rein, ${currency(summary.spending)} raus – ${summary.balance >= 0 ? `${currency(summary.balance)} übrig` : `${currency(-summary.balance)} mehr ausgegeben als eingenommen`}.`,
    top ? `Am meisten ging für ${top.category} weg (${currency(top.amount)}).` : "",
    previous.spending && !running ? `Das sind ${currency(Math.abs(delta))} ${delta > 0 ? "mehr" : "weniger"} Ausgaben als im ${monthLabel(previous.month)}.` : "",
    average && !running && summary.spending > average * 1.1 ? "Deutlich über deinem Schnitt – schau dir die größten Posten an." : "",
  ].filter(Boolean).join(" ");
  const trend = [5, 4, 3, 2, 1, 0].map((back) => addMonths(month, -back)).map((key) => ({ label: shortMonth(key), value: summarizeMonth(state, key).spending }));
  return {
    text: text_,
    card: { kind: "review", title: `Monatsbericht ${monthLabel(month)}${running ? ` · bis ${dateLabel(today)}` : ""}`, total: summary.balance, month, lines: lines.slice(0, 40),
      chart: buildChart("bar", [{ name: "Ausgaben", points: trend.filter((point) => point.value > 0) }]),
      note: "Umbuchungen zwischen deinen Konten zählen nicht mit; geteilte Ausgaben nur mit deinem Anteil." },
    suggestions: [`Wie war ${monthLabel(addMonths(month, -1))}?`, "Wo kann ich sparen?", "Gibt es verdächtige Buchungen?"],
  };
}

// ---------- Geteilte Kosten mit Raphael ----------

export const sharedQuestion = (lower: string) => /raphael|rafael/.test(lower) &&
  /schuld|zahl|zurück|zurueck|offen|bekomm|krieg|überweis|ueberweis|ausgleich|abrechn|teil|wie ?viel|noch/.test(lower) && !/\b(?:teil|teile) (?:das|den|die|mir)\b/.test(lower);

export function sharedAnswer(state: AppState, today: string): Result {
  const { receivables } = reconcileSharedHoliday(actualBookings(state), state.settings.asOf, state.plannedOneOffs);
  const open = receivables.filter((item) => item.outstanding > 0.004).sort((a, b) => b.date.localeCompare(a.date));
  const paid = receivables.filter((item) => item.outstanding <= 0.004 && item.date >= shift(today, -90));
  const total = round(open.reduce((sum, item) => sum + item.outstanding, 0));
  const overpaid = round(receivables.reduce((sum, item) => sum + item.overpaid, 0));
  if (!receivables.length) return {
    text: "Du hast noch keine Ausgaben mit Raphael geteilt. Markiere eine Buchung unter Buchungen mit dem Personen-Symbol als geteilt, dann rechne ich mit, was er dir schuldet.",
    suggestions: ["Was hab ich diesen Monat ausgegeben?"],
  };
  const lines: Line[] = open.slice(0, 30).map((item) => ({ label: item.description.slice(0, 60), value: item.outstanding, tone: "warn",
    detail: `${dateLabel(item.date)} · gesamt ${currency(Math.abs(item.fullAmount))}${item.partnerPaid ? ` · schon bezahlt ${currency(item.partnerPaid)}` : ""}`, transactionIds: [item.bookingId] }));
  for (const item of paid.slice(0, 8)) lines.push({ label: `${item.description.slice(0, 60)} – erledigt`, value: 0, tone: "good", detail: dateLabel(item.date) });
  const oldest = open.at(-1);
  return {
    text: total > 0
      ? `Raphael schuldet dir noch ${currency(total)} aus ${open.length === 1 ? "einer geteilten Ausgabe" : `${open.length} geteilten Ausgaben`}${oldest ? `, die älteste vom ${dateLabel(oldest.date)}` : ""}.${overpaid > 0 ? ` Er hat bei anderen Posten ${currency(overpaid)} zu viel überwiesen.` : ""}`
      : `Mit Raphael ist alles ausgeglichen – nichts mehr offen.${overpaid > 0 ? ` Er hat sogar ${currency(overpaid)} zu viel überwiesen.` : ""}`,
    card: { kind: "answer", title: "Geteilte Kosten mit Raphael", total, lines: lines.slice(0, 40),
      note: "Seine Überweisungen werden automatisch zugeordnet. Offene Posten kannst du unter Buchungen → Geteilt als bezahlt markieren." },
    suggestions: ["Wie viel kann ich heute noch ausgeben?", "Wie war mein letzter Monat?"],
  };
}

// ---------- Vermögensentwicklung ----------

export const netWorthQuestion = (lower: string) =>
  /nettovermögen|nettovermoegen|reinvermögen|reinvermoegen|vermögensentwicklung|vermoegensentwicklung|wie (?:reich|vermögend|vermoegend) bin ich/.test(lower) ||
  /vermögen|vermoegen/.test(lower) && /entwickel|gewachsen|gestiegen|gesunken|verlauf|zugenommen|abgenommen|\bseit\b|vorjahr|vormonat|letzte[nm]? jahr|im jahr/.test(lower) && !/sparziel|depot|etf/.test(lower);

const partLabels: Record<string, string> = { girokonto: "Girokonto", amex: "Amex (offen)" };

export function netWorthAnswer(state: AppState, dashboard: Dashboard): Result {
  const points = netWorthHistory(state, dashboard);
  const now = points.at(-1);
  if (!now) return { text: "Ich habe noch keine Kontostände, um dein Vermögen zu berechnen. Verbinde deine Konten unter Einstellungen.", suggestions: ["Wie viel ist auf meinen Konten?"] };
  const yearAgo = points.find((point) => point.month === addMonths(now.month, -12)) ?? points[0];
  const lastMonth = points.at(-2);
  const change = round(now.total - yearAgo.total);
  const monthly = lastMonth ? round(now.total - lastMonth.total) : 0;
  const months = Math.max(1, points.length - 1 - points.indexOf(yearAgo));
  const lines: Line[] = [
    { label: "Vermögen jetzt", value: now.total, tone: now.total >= 0 ? "good" : "bad" },
    ...(lastMonth ? [{ label: `seit ${monthLabel(lastMonth.month)}`, value: monthly, tone: monthly >= 0 ? "good" as const : "warn" as const }] : []),
    ...(yearAgo !== now ? [{ label: `seit ${monthLabel(yearAgo.month)}`, value: change, tone: change >= 0 ? "good" as const : "warn" as const,
      detail: `Ø ${currency(round(change / months))} pro Monat` }] : []),
    ...Object.entries(now.parts).sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ label: partLabels[key] ?? key.charAt(0).toUpperCase() + key.slice(1), value })),
  ];
  return {
    text: `Dein Vermögen liegt bei ${currency(now.total)}.${yearAgo !== now ? ` Seit ${monthLabel(yearAgo.month)} ${change >= 0 ? "ein Plus" : "ein Minus"} von ${currency(Math.abs(change))}, im Schnitt ${currency(Math.abs(round(change / months)))} pro Monat ${change >= 0 ? "dazu" : "weniger"}.` : ""}`,
    card: { kind: "answer", title: "Vermögensentwicklung", total: now.total, lines: lines.slice(0, 40),
      chart: buildChart("line", [{ name: "Vermögen", points: points.slice(-24).map((point) => ({ label: shortMonth(point.month), value: point.total })) }]),
      note: "Alle Konten, Pockets und Trade Republic zum Monatsende, offene Amex-Abrechnung abgezogen." },
    suggestions: ["Wie viel spare ich im Monat?", "Wann erreiche ich meine Sparziele?"],
  };
}

// ---------- Rückerstattungen ----------

export const refundQuestion = (lower: string) =>
  /rückerstattung|rueckerstattung|erstattung|erstattet|gutschrift|gutgeschrieben|retoure|zurückgeschickt|zurueckgeschickt|zurückgesendet|refund|geld zurück|geld zurueck|zurückbekommen|zurueckbekommen|zurück überwiesen|zurückgekommen|zurueckgekommen|zurück gekommen/.test(lower) &&
  !/steuer|finanzamt|arbeitnehmerveranlagung|homeoffice|home-office|raphael|gehalt|lohn/.test(lower);

const stopWords = new Set(["von", "der", "die", "das", "den", "dem", "und", "ist", "sind", "schon", "noch", "geld", "mein", "meine", "meinen", "wann", "wie", "hab", "habe",
  "fuer", "zurueck", "rueckerstattung", "erstattung", "gutschrift", "retoure", "kommt", "bekommen", "da", "eingegangen", "welche", "alle", "letzte", "bei", "vom"]);

export function refundAnswer(state: AppState, text: string, today: string): Result {
  const lower = fold(text);
  const refunds = ledger(state).filter(({ row, category }) => row.amount > 0 && !isIncomeCategory(category) && !classify(row).isTransfer &&
    row.date >= shift(today, -120) && row.date <= today).map(({ row }) => row);
  const words = new Set(lower.split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !stopWords.has(word)));
  const named = [...new Set(state.transactions.map((row) => merchantOf(row).split(/\s+/)[0]))].find((word) => words.has(fold(word).replace(/[^a-z0-9]/g, "")));
  const matches = named ? refunds.filter((row) => fold(merchantOf(row)).includes(fold(named))) : refunds;
  const total = round(matches.reduce((sum, row) => sum + row.amount, 0));
  const lines: Line[] = matches.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30)
    .map((row) => ({ label: merchantOf(row), value: row.amount, tone: "good", detail: dateLabel(row.date), transactionIds: [row.id] }));
  if (named && !matches.length) {
    const lastBuy = state.transactions.filter((row) => row.amount < 0 && fold(merchantOf(row)).includes(fold(named))).sort((a, b) => b.date.localeCompare(a.date))[0];
    return {
      text: `Von ${named} ist in den letzten 4 Monaten noch keine Rückerstattung eingegangen.${lastBuy ? ` Letzte Zahlung dort: ${currency(-lastBuy.amount)} am ${dateLabel(lastBuy.date)}.` : ""} Rückerstattungen dauern meist 3–14 Tage nach Eingang der Retoure; bei Kreditkarte bis zur nächsten Abrechnung.`,
      suggestions: ["Welche Bestellungen sind noch offen?", "Gibt es verdächtige Buchungen?"],
    };
  }
  return {
    text: matches.length
      ? `${named ? `Von ${named} sind` : "In den letzten 4 Monaten sind"} ${matches.length === 1 ? "eine Rückerstattung" : `${matches.length} Rückerstattungen`} über ${currency(total)} eingegangen${matches[0] ? `, zuletzt ${currency(matches[0].amount)} am ${dateLabel(matches[0].date)}` : ""}.`
      : "In den letzten 4 Monaten ist keine Rückerstattung von einem Händler eingegangen.",
    card: { kind: "answer", title: named ? `Rückerstattungen von ${named}` : "Rückerstattungen", total, lines,
      note: "Gutschriften von Händlern der letzten 4 Monate – ohne Gehalt, Umbuchungen und Raphaels Anteile." },
    suggestions: ["Welche Bestellungen sind noch offen?", "Was hab ich diesen Monat ausgegeben?"],
  };
}
