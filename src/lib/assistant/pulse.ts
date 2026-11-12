import { addMonths, daysInMonth, round, type Dashboard } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { pocketKey } from "@/lib/goals";
import { detectSubscriptions, forecastMonth, ledger } from "@/lib/insights";
import type { AppState, AssistantCard } from "@/lib/types";
import { monthEndForecast } from "@/lib/month-forecast";
import { budgetLinesIn } from "./budget-plan";
import { buildForecastInput, GIRO, projectAccounts } from "./forecast";

type Line = AssistantCard["lines"][number];
type Result = { text: string; card: AssistantCard; suggestions: string[] };

const DAY_MS = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// Monats-Puls: daily safe-to-spend, salary status, budget pace and what still leaves the account this month.
export const pulseQuestion = (lower: string) =>
  /tagesbudget|safe.?to.?spend|monats-?puls|monats-?check|zwischenstand/.test(lower) ||
  /\b(?:bleibt|bleiben) (?:mir |uns )?(?:noch )?(?:pro tag|am tag|täglich|taeglich)\b|(?:pro tag|am tag|täglich|taeglich) (?:\S+ ){0,2}bis zum (?:nächsten |naechsten )?(?:gehalt|lohn)\b/.test(lower) ||
  /(?:kann|darf) ich (?:\S+ ){0,3}(?:pro tag|am tag|täglich|taeglich|heute|diese woche|bis zum gehalt|bis (?:zum )?monatsende|bis sonntag|bis (?:zum )?wochenende|bis ende der woche)\b/.test(lower) ||
  /\bkomm\w* ich\b.*\bbis (?:zum )?(?:monatsende|ende des monats|(?:nächsten |naechsten )?gehalt)\b.*\baus\b|\bgeht sich\b.*\bbis (?:zum )?(?:monatsende|ende des monats|gehalt)\b/.test(lower) ||
  /(?:pro tag|am tag|täglich|taeglich|heute) (?:\S+ ){0,2}(?:ausgeben|verbrauchen|verballern)\b/.test(lower) && /\b(?:kann|darf|noch)\b/.test(lower) ||
  /(?:reicht|komm\w*) (?:mein |das )?geld (?:\S+ ){0,2}bis zum (?:nächsten |naechsten )?(?:gehalt|lohn|monatsende)/.test(lower) ||
  /wie (?:läuft|laeuft|steht) (?:es um )?(?:mein|der|dieser|den) monat|wie (?:schaut|sieht) (?:mein|der|dieser) monat (?:bisher|bis jetzt|gerade|aktuell)/.test(lower) ||
  /(?:bin|liege|lieg) ich (?:\S+ ){0,3}(?:im|über|ueber|unter) (?:dem |meinem )?(?:rahmen|plan|budget|limit)\b/.test(lower) ||
  /(?:gehalt|lohn) (?:\S+ ){0,2}(?:schon )?(?:da|gekommen|eingegangen|drauf|überwiesen|ueberwiesen|eingelangt)\b|wann kommt (?:mein |das )?(?:gehalt|lohn)/.test(lower) ||
  /\bmonatsende\b|\bende des monats\b/.test(lower) && /bleib|übrig|uebrig|\bhab|stand|frei|ausgeben|reicht|minus|knapp/.test(lower) &&
    !/^(?:warum|wieso|weshalb)\b|\bimmer\b|\bjedes mal\b/.test(lower) ||
  /frei verfügbar|frei verfuegbar/.test(lower) ||
  /^(?:wie ?viel|was) (?:geld )?(?:ist|hab ich|habe ich) (?:diesen monat |jetzt |aktuell )?noch frei\??$/.test(lower) ||
  /\bwo (?:gebe|geb|gab|habe|hab) ich (?:\S+ ){0,3}mehr (?:geld )?(?:\S+ )?als (?:im |letzten |vorigen |im letzten |im vorigen )?(?:monat|vormonat)\b|\bwo (?:sind|waren) (?:meine |die )?ausgaben (?:\S+ )?gestiegen\b/.test(lower) ||
  /^wie ?viel (?:kann|darf) ich (?:jetzt |diesen monat )?noch ausgeben\??$/.test(lower) ||
  /wo (?:gebe|geb) ich (?:\S+ ){0,2}(?:zu viel|mehr (?:geld )?(?:aus )?als (?:sonst|üblich|ueblich|normal))/.test(lower) ||
  /was (?:kommt|geht) (?:diesen monat |bis zum gehalt |heuer )?noch (?:weg|ab|runter|vom konto)|welche (?:fixkosten|abbuchungen|zahlungen|lastschriften) (?:kommen|stehen|fehlen) (?:diesen monat )?noch/.test(lower);

export type SafeToSpend = { perDay: number; free: number; days: number; until: string; balance: number; lowest: number; buffer: number; asOf?: string };

// Lowest projected giro balance until payday without everyday spending; what is above the buffer may be spent.
export function safeToSpend(state: AppState, dashboard: Dashboard, today: string): SafeToSpend | undefined {
  const { input, meta } = buildForecastInput(state, dashboard, today, 2);
  if (!meta.giroKnown && Math.abs(meta.snapshots) < 0.005) return undefined;
  const salary = input.events.filter((event) => event.kind === "salary" && event.account === GIRO && event.date > today).sort((a, b) => a.date.localeCompare(b.date))[0];
  const until = salary?.date ?? `${addMonths(today.slice(0, 7), 1)}-01`;
  const end = shift(until, -1);
  const events = input.events.filter((event) => event.kind !== "spending" && event.date <= end);
  const giro = projectAccounts({ ...input, end: end < today ? today : end, events }).find((item) => item.name === GIRO);
  if (!giro) return undefined;
  const days = Math.max(1, daysBetween(today, until));
  const free = round(giro.lowest.balance - meta.buffer);
  const asOf = (state.accountSnapshots ?? []).filter((item) => item.date <= today && !dashboard.physical[pocketKey(item.name)])
    .map((item) => item.date).sort().at(-1);
  return { perDay: round(Math.max(0, free) / days), free, days, until, balance: giro.start, lowest: giro.lowest.balance, buffer: meta.buffer, ...(asOf ? { asOf } : {}) };
}

export type BudgetPace = { id: string; label: string; total: number; actual: number; expected: number; status: "over" | "ahead" | "ok" };

export function budgetPace(dashboard: Dashboard, today: string): BudgetPace[] {
  const month = today.slice(0, 7);
  const share = Number(today.slice(8, 10)) / daysInMonth(month);
  return dashboard.plan.rows.filter((row) => row.total > 0).map((row) => {
    const expected = round(row.total * share);
    const status = row.actual > row.total + 0.5 ? "over" as const
      : row.actual > expected * 1.2 && row.actual - expected > 15 ? "ahead" as const : "ok" as const;
    return { id: row.id, label: row.label, total: row.total, actual: row.actual, expected, status };
  });
}

const raiseWords = /erhöh|erhoeh|\bmehr\b|aufstock|rauf/;
const lowerWords = /senk|reduzier|kürz|kuerz|weniger|runter/;

const adviceWords = /\b(?:sollte|soll|sollen|müsste|muss)\s+ich\b|\blohnt\s+(?:es\s+)?sich\b/;
const statusWords = /\bwie (?:steht|stehen|sieht|schaut|läuft|laeuft)\b|\bwie viel (?:\S+ )?(?:ist|hab|habe|bleibt|darf|kann)\b|\bwas ist (?:noch )?(?:im|vom|beim)\b|\bstand\b|\bübrig\b|\buebrig\b|\bnoch frei\b|\bhab ich noch\b/;
/** "Wie steht mein Lebensmittelbudget?", "Wie viel Puffer hab ich?": one named budget line, without changing it. */
export const budgetLineQuestion = (lower: string) => budgetLinesIn(lower).length === 1 && statusWords.test(lower) &&
  !/erhöh|erhoeh|senk|reduzier|setz|stell|änder|aender|umschicht|\bauf\s+\d|\bum\s+\d/.test(lower) && /budget|puffer|\bplan\b|\blimit\b/.test(lower);

/** One budget line: its status this month, or for "Sollte ich das Lebensmittelbudget erhöhen?" a clear recommendation. */
export function budgetLineAnswer(dashboard: Dashboard, today: string, text: string): Result | undefined {
  const lower = text.toLowerCase();
  const advice = adviceWords.test(lower) && (raiseWords.test(lower) || lowerWords.test(lower));
  if (!advice && !budgetLineQuestion(lower)) return undefined;
  const ids = budgetLinesIn(lower).map((line) => line.id);
  const row = ids.length === 1 ? budgetPace(dashboard, today).find((item) => item.id === ids[0]) : undefined;
  if (!row) return undefined;
  if (!advice) {
    const share = Number(today.slice(8, 10)) / daysInMonth(today.slice(0, 7));
    const left = round(row.total - row.actual);
    const projected = round(row.actual / Math.max(share, 0.01));
    const days = daysInMonth(today.slice(0, 7)) - Number(today.slice(8, 10)) + 1;
    return {
      text: `Für ${row.label} sind ${currency(row.total)} im Monat geplant, bisher sind ${currency(row.actual)} weg – ` +
        (left >= 0 ? `noch ${currency(left)} für ${days === 1 ? "heute" : `die restlichen ${days} Tage`}.` : `${currency(-left)} mehr als geplant.`) +
        (row.status === "ahead" ? ` Du bist schneller als geplant; bei diesem Tempo landest du bei etwa ${currency(projected)}.` : left >= 0 ? " Das liegt im Plan." : ""),
      card: { kind: "answer", title: `Budget · ${row.label}`, total: left, lines: [
        { label: "Geplant", value: row.total }, { label: "Bisher ausgegeben", value: row.actual, detail: `bis heute üblich ${currency(row.expected)}` },
        { label: "Noch übrig", value: left, tone: left >= 0 ? "good" : "bad" },
      ] },
      suggestions: ["Wie viel kann ich heute noch ausgeben?", "Bin ich im Budget?"],
    };
  }
  const share = Number(today.slice(8, 10)) / daysInMonth(today.slice(0, 7));
  const projected = round(row.actual / share);
  const target = Math.ceil(Math.max(projected, row.actual) / 10) * 10;
  const ahead = row.actual > row.total + 0.5 || projected > row.total * 1.1;
  const lowering = lowerWords.test(lower) && !raiseWords.test(lower);
  const base = `Für ${row.label} sind ${currency(row.total)} im Monat geplant, bisher hast du ${currency(row.actual)} ausgegeben`;
  let answer: string;
  if (share < 0.25 && !ahead) answer = `Dafür ist es noch zu früh im Monat. ${base}; schau Mitte des Monats noch einmal drauf.`;
  else if (lowering) answer = ahead ? `Nein, eher nicht. ${base} – du brauchst eher mehr als geplant.`
    : projected < row.total * 0.8 ? `Ja, das geht wohl. ${base} – bei diesem Tempo reichen etwa ${currency(target)}.`
      : `Eher nicht. ${base} – bei diesem Tempo brauchst du das Budget ziemlich genau.`;
  else answer = ahead ? `Ja, eher schon. ${base} – bei diesem Tempo landest du bei etwa ${currency(Math.max(projected, row.actual))}, ` +
    `realistischer wären rund ${currency(target)}.` : `Nein, eher nicht. ${base} – bei diesem Tempo kommst du mit etwa ${currency(projected)} gut aus.`;
  const change = target !== row.total && (lowering ? !ahead && projected < row.total * 0.8 && share >= 0.25 : ahead);
  return {
    text: answer,
    card: { kind: "answer", title: `Budget · ${row.label}`, lines: [
      { label: "Geplant", value: row.total },
      { label: "Bisher ausgegeben", value: row.actual, detail: `bis heute üblich ${currency(row.expected)}` },
      { label: "Hochgerechnet aufs Monatsende", value: projected, tone: ahead ? "warn" : "good" },
    ] },
    suggestions: change ? [`Budget ${row.label} auf ${target} € setzen`, "Wie viel kann ich heute noch ausgeben?"] : ["Wie viel kann ich heute noch ausgeben?", "Wo kann ich sparen?"],
  };
}

// Categories clearly above the average of the last three months at the same day of the month.
export function unusualCategories(state: AppState, today: string) {
  const month = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const previous = [1, 2, 3].map((offset) => addMonths(month, -offset));
  const totals = new Map<string, { now: number; before: number[] }>();
  for (const { row, category } of ledger(state)) {
    if (row.amount >= 0 || row.date > today) continue;
    const rowMonth = row.date.slice(0, 7);
    const index = previous.indexOf(rowMonth);
    if (rowMonth !== month && (index < 0 || Number(row.date.slice(8, 10)) > day)) continue;
    const entry = totals.get(category) ?? { now: 0, before: [0, 0, 0] };
    if (rowMonth === month) entry.now -= row.amount; else entry.before[index] -= row.amount;
    totals.set(category, entry);
  }
  const months = previous.filter((prior) => ledger(state).some(({ row }) => row.date.startsWith(prior))).length;
  if (!months) return [];
  return [...totals].map(([category, entry]) => ({ category, now: round(entry.now), usual: round(entry.before.reduce((sum, value) => sum + value, 0) / months) }))
    .filter((item) => item.now >= 50 && item.now > item.usual * 1.5 && item.now - item.usual >= 40)
    .sort((a, b) => (b.now - b.usual) - (a.now - a.usual)).slice(0, 4);
}

export function salaryStatus(state: AppState, today: string) {
  const month = today.slice(0, 7);
  const rows = ledger(state).filter(({ row, category }) => row.amount > 0 && category === "Gehalt" && row.date <= today)
    .map(({ row }) => row).sort((a, b) => b.date.localeCompare(a.date));
  const received = rows.filter((row) => row.date.startsWith(month));
  const days = rows.slice(0, 6).map((row) => Number(row.date.slice(8, 10))).sort((a, b) => a - b);
  const memoryDay = (state.assistantMemory ?? []).findLast((entry) => entry.key === "salaryDay")?.value;
  const day = Math.round(memoryDay ?? days[Math.floor(days.length / 2)] ?? 0) || undefined;
  const clamp = (target: string) => `${target}-${String(Math.min(day ?? 1, daysInMonth(target))).padStart(2, "0")}`;
  const expected = day ? received.length ? clamp(addMonths(month, 1)) : clamp(month) : undefined;
  return { received: round(received.reduce((sum, row) => sum + row.amount, 0)), date: received[0]?.date, ids: received.map((row) => row.id),
    expected, late: !received.length && !!expected && expected < shift(today, -2), last: rows[0] };
}

const fixedAmount = (state: AppState, label: string, month: string) =>
  state.financeRows.find((row) => row.kind === "fixed" && row.label === label)?.values[month] ?? 0;

export function pulseAnswer(state: AppState, dashboard: Dashboard, today: string, question = ""): Result {
  const month = today.slice(0, 7);
  const daysLeft = daysInMonth(month) - Number(today.slice(8, 10)) + 1;
  const pace = budgetPace(dashboard, today);
  const budgetTotal = round(pace.reduce((sum, row) => sum + row.total, 0));
  const budgetLeft = round(budgetTotal - pace.reduce((sum, row) => sum + row.actual, 0));
  const budgetPerDay = round(Math.max(0, budgetLeft) / daysLeft);
  const safe = safeToSpend(state, dashboard, today);
  const monthEnd = monthEndForecast(state, dashboard, today);
  const salary = salaryStatus(state, today);
  const missing = dashboard.missingFixed.map((label) => ({ label, amount: fixedAmount(state, label, month) })).filter((item) => item.amount > 0);
  const savingsDue = dashboard.monthlyFunding.filter((item) => !item.done).map((item) => ({ name: item.name, open: round(Math.max(0, item.amount - item.transferred)) }))
    .filter((item) => item.open > 0.5);
  const unusual = unusualCategories(state, today);
  const projection = forecastMonth(state, detectSubscriptions(state, today), today);

  const perDay = safe ? Math.min(safe.perDay, budgetPerDay) : budgetPerDay;
  const lines: Line[] = [
    { label: "Heute frei ausgebbar", value: perDay, tone: perDay > 0 ? "good" : "bad",
      detail: safe && safe.perDay < budgetPerDay ? `pro Tag bis ${dateLabel(safe.until)} – dein Konto begrenzt, nicht das Budget` : `pro Tag, ${daysLeft} Tage bis Monatsende` },
    { label: "Alltagsbudget übrig", value: budgetLeft, tone: budgetLeft >= 0 ? "info" : "bad", detail: `${currency(budgetTotal)} geplant für Essen, Tanken, Freizeit & Co.` },
  ];
  if (monthEnd.status === "ok") lines.push({ label: "Frei bis Monatsende", value: monthEnd.free, tone: monthEnd.free >= 0 ? "info" : "bad",
    detail: `≈ ${currency(monthEnd.perDay)} pro Tag · am ${dateLabel(monthEnd.monthEnd)} voraussichtlich ${currency(monthEnd.endBalance)} inkl. geplanter Alltagsausgaben` });
  if (safe) lines.push({ label: "Frei auf dem Konto bis zum Gehalt", value: safe.free, tone: safe.free >= 0 ? "info" : "bad",
    detail: `tiefster Stand ${currency(safe.lowest)} nach Fixkosten, Amex und Sparraten${safe.buffer ? `, minus Puffer ${currency(safe.buffer)}` : ""}${safe.asOf ? ` · Kontostand vom ${dateLabel(safe.asOf)}` : ""}` });
  for (const row of pace.filter((item) => item.status !== "ok"))
    lines.push({ label: row.label, value: -row.actual, tone: row.status === "over" ? "bad" : "warn",
      detail: row.status === "over" ? `Budget ${currency(row.total)} überschritten` : `schneller als geplant: üblich wären bis heute ${currency(row.expected)} von ${currency(row.total)}` });
  for (const item of unusual)
    lines.push({ label: `${item.category} ungewöhnlich hoch`, value: -item.now, tone: "warn", detail: `sonst bis zu diesem Tag ca. ${currency(item.usual)}` });
  lines.push(salary.received > 0
    ? { label: "Gehalt eingegangen", value: salary.received, tone: "good", detail: `am ${dateLabel(salary.date!)}${salary.expected ? ` · nächstes ca. ${dateLabel(salary.expected)}` : ""}`, transactionIds: salary.ids.slice(0, 50) }
    : salary.expected
      ? { label: salary.late ? "Gehalt noch nicht da" : "Gehalt erwartet", tone: salary.late ? "warn" : "info", detail: `${salary.late ? "üblich wäre" : "voraussichtlich"} ${dateLabel(salary.expected)}` }
      : { label: "Gehalt", detail: "noch kein Gehaltseingang erkannt", tone: "info" });
  for (const item of missing.slice(0, 8)) lines.push({ label: `Noch offen: ${item.label}`, value: -item.amount, detail: "Fixkosten diesen Monat noch nicht abgebucht" });
  for (const item of savingsDue.slice(0, 5)) lines.push({ label: `Sparrate ${item.name}`, value: -item.open, detail: "noch nicht überwiesen", tone: "info" });
  if (projection.averageSpending) lines.push({ label: "Hochrechnung Monatsausgaben", value: -projection.projectedSpending,
    detail: `sonst im Schnitt ${currency(projection.averageSpending)}`, tone: projection.projectedSpending > projection.averageSpending * 1.1 ? "warn" : "info" });

  const over = pace.filter((item) => item.status === "over").map((item) => item.label);
  const ahead = pace.filter((item) => item.status === "ahead").map((item) => item.label);
  const parts = [
    perDay > 0 ? `Du kannst heute rund ${currency(perDay)} ausgeben${safe && safe.perDay < budgetPerDay ? ` – pro Tag bis zum Gehalt am ${dateLabel(safe.until)}, mehr gibt dein Konto nicht her` : `, ohne deinen Plan zu sprengen`}.`
      : safe && safe.free < 0 ? `Achtung: Bis zum Gehalt am ${dateLabel(safe.until)} fehlen auf dem Konto rund ${currency(-safe.free)} – ab jetzt nur noch das Nötigste.`
        : `Dein Alltagsbudget für diesen Monat ist aufgebraucht (${currency(budgetLeft)}).`,
    over.length ? `Über dem Budget: ${over.join(", ")}.` : ahead.length ? `Schneller als geplant: ${ahead.join(", ")}.` : "Alle Budgets liegen im Plan.",
    unusual.length ? `Auffällig mehr als sonst: ${unusual.map((item) => item.category).join(", ")}.` : "",
    salary.received > 0 ? `Gehalt ist am ${dateLabel(salary.date!)} eingegangen (${currency(salary.received)}).`
      : salary.late ? `Dein Gehalt ist noch nicht da, üblich wäre der ${dateLabel(salary.expected!)}.` : salary.expected ? `Gehalt kommt voraussichtlich am ${dateLabel(salary.expected)}.` : "",
    missing.length ? `Noch abgebucht werden ${missing.length === 1 ? missing[0].label : `${missing.length} Fixkosten`} (${currency(round(missing.reduce((sum, item) => sum + item.amount, 0)))}).` : "",
  ].filter(Boolean);
  const asked = question.toLowerCase();
  const salaryText = salary.received > 0 ? `Gehalt ist am ${dateLabel(salary.date!)} eingegangen (${currency(salary.received)}).`
    : salary.late ? `Dein Gehalt ist noch nicht da, üblich wäre der ${dateLabel(salary.expected!)}.` : salary.expected ? `Gehalt kommt voraussichtlich am ${dateLabel(salary.expected)}.` : "";
  const budgetsText = over.length ? `Über dem Budget: ${over.join(", ")}.` : ahead.length ? `Schneller als geplant: ${ahead.join(", ")}.` : "Alle Budgets liegen im Plan.";
  const days = daysInMonth(month) - Number(today.slice(8, 10)) + 1;
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const weekDays = Math.min(days, weekday === 0 ? 1 : 8 - weekday);
  // "Wann kommt mein Gehalt?" gets the salary first; "Was kann ich heute ausgeben?" a clear amount first.
  if (/gehalt|lohn/.test(asked) && !/ausgeben|reicht|kann ich|darf ich|komm\w* ich/.test(asked) && salaryText) {
    const wait = salary.expected && salary.received <= 0 && !salary.late ? daysBetween(today, salary.expected) : 0;
    const notYet = salary.received <= 0 && /schon|gekommen|eingegangen|\bda\b|drauf/.test(asked) ? "Noch nicht. " : "";
    parts.splice(0, parts.length, `${notYet}${wait > 0 ? `${salaryText.slice(0, -1)} – noch ${wait === 1 ? "1 Tag" : `${wait} Tage`}.` : salaryText}`, parts[0]);
  } else if (/diese woche|bis (?:zum )?(?:sonntag|wochenende)|bis ende der woche|pro woche|die woche\b/.test(asked) && /ausgeben|verbrauchen|darf|kann/.test(asked)) {
    const week = round(perDay * weekDays);
    parts.splice(0, 1, perDay > 0 ? `Diese Woche kannst du noch rund ${currency(week)} ausgeben – ${currency(perDay)} pro Tag für ${weekDays === 1 ? "heute" : `${weekDays} Tage bis Sonntag`}.`
      : "Diese Woche ist eigentlich nichts mehr frei.");
  } else if (/\breicht\b|\bkomm\w* ich\b.*\baus\b|geht sich .* aus/.test(asked) && /gehalt|lohn|monatsende|ende des monats|monat/.test(asked)) {
    const short = safe ? safe.free < 0 : budgetLeft < 0;
    parts.splice(0, 1, short
      ? `Knapp: ${safe && safe.free < 0 ? `bis zum Gehalt am ${dateLabel(safe.until)} fehlen auf dem Konto rund ${currency(-safe.free)}` : `dein Alltagsbudget ist schon um ${currency(-budgetLeft)} überzogen`} – ab jetzt nur noch das Nötigste.`
      : `Ja, das reicht: Du kannst bis zum Gehalt noch rund ${currency(perDay)} pro Tag ausgeben.`);
  } else if (/\b(?:im|über|ueber|unter) (?:dem |meinem )?(?:budget|plan|rahmen|limit)\b/.test(asked) && !/ausgeben/.test(asked)) {
    parts.splice(parts.indexOf(budgetsText), 1);
    parts.unshift(over.length ? `Nicht ganz – über dem Budget: ${over.join(", ")}.` : ahead.length ? `Noch ja, aber schneller als geplant: ${ahead.join(", ")}.` : "Ja, alle Budgets liegen im Plan.");
  } else if (/fixkosten|abbuchung|zahlungen|lastschrift/.test(asked) && !missing.length) {
    parts.unshift("Diesen Monat sind keine Fixkosten mehr offen.");
  } else if (/fixkosten|abbuchung|zahlungen|lastschrift/.test(asked) && missing.length) {
    const due = parts.findIndex((part) => part.startsWith("Noch abgebucht"));
    const grouped = new Map<string, number>();
    for (const item of missing) grouped.set(item.label, round((grouped.get(item.label) ?? 0) + item.amount));
    const largest = [...grouped].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, amount]) => `${label} ${currency(amount)}`).join(", ");
    parts.splice(due, 1);
    parts.unshift(`Noch abgebucht werden diesen Monat ${missing.length === 1 ? missing[0].label : `${missing.length} Fixkosten`} (${currency(round(missing.reduce((sum, item) => sum + item.amount, 0)))})${missing.length > 1 ? `, die größten: ${largest}` : ""}.`);
  } else if (/monatsende|ende des monats|frei verfügbar|frei verfuegbar|noch frei\??$/.test(asked) || /noch ausgeben/.test(asked) && !/heute|pro tag|am tag|täglich|gehalt/.test(asked)) {
    // The month-end view replaces the opening sentence, so a shortfall is not stated twice.
    parts.splice(0, 1, monthEnd.status !== "ok"
      ? "Für eine Monatsende-Prognose fehlt mir ein aktueller Girokonto-Stand – dazu habe ich keine ausreichenden Daten. Importiere einen Kontoauszug oder sag mir z. B. „Merk dir: Girokonto 1.500 €“."
      : monthEnd.free < 0
        ? `Bis zum ${dateLabel(monthEnd.monthEnd)} fehlen voraussichtlich ${currency(-monthEnd.free)} – der tiefste Stand ist am ${dateLabel(monthEnd.lowestCommitted.date)}.`
        : `Bis Monatsende sind ${currency(monthEnd.free)} frei verfügbar – rund ${currency(monthEnd.perDay)} pro Tag. Am ${dateLabel(monthEnd.monthEnd)} stehst du voraussichtlich bei ${currency(monthEnd.endBalance)}, wenn das Alltagsbudget wie geplant ausgegeben wird.`);
  } else if (perDay <= 0 && /heute|pro tag|am tag|täglich|ausgeben/.test(asked)) parts.unshift("Heute ist eigentlich nichts mehr frei.");
  return {
    text: parts.join(" "),
    card: { kind: "answer", title: "Monats-Puls", total: perDay, month, lines: lines.slice(0, 40), page: { label: "Prognose in der Übersicht", href: "/" },
      note: (safe ? "„Heute frei“ = kleinerer Wert aus Alltagsbudget pro Resttag und Kontostand bis zum Gehalt (nach Fixkosten, Amex-Abbuchung, Sparraten und geplanten Ausgaben)."
        : "„Heute frei“ = Alltagsbudget pro Resttag. Mit verbundenem Girokonto rechne ich zusätzlich mit dem echten Kontostand.").slice(0, 400) },
    suggestions: ["Wird mein Konto knapp?", "Wo kann ich sparen?", "Was bleibt mir diesen Monat?"],
  };
}
