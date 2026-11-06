import { actualBookings, addMonths, classify, daysInMonth, round, type Dashboard } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { pocketKey } from "@/lib/goals";
import { detectSubscriptions, ledger } from "@/lib/insights";
import { personalAmount } from "@/lib/shared-holiday";
import type { AppState, AssistantCard } from "@/lib/types";
import { buildChart, shortMonth } from "./chart";
import { parseAmount } from "./intent";

type Line = AssistantCard["lines"][number];
export type ForecastKind = "salary" | "fixed" | "amex" | "subscription" | "planned" | "transfer" | "spending";
export type ForecastEvent = { date: string; account: string; amount: number; label: string; kind: ForecastKind };
export type ForecastAccount = { name: string; start: number; threshold: number };
export type ForecastInput = { today: string; end: string; accounts: ForecastAccount[]; events: ForecastEvent[] };
export type LowPoint = { account: string; date: string; balance: number; lowest: number; lowestDate: string; cause?: ForecastEvent; recovered?: string };
export type AccountProjection = { name: string; start: number; end: number; threshold: number;
  lowest: { date: string; balance: number }; months: { month: string; min: number; end: number }[]; lows: LowPoint[] };

const DAY_MS = 86_400_000;
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const dayIn = (month: string, day: number) => `${month}-${String(Math.max(1, Math.min(daysInMonth(month), Math.round(day)))).padStart(2, "0")}`;
const median = (values: number[]) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// Walks day by day; an episode starts when the balance drops below the account's threshold and ends when it is back above.
export function projectAccounts(input: ForecastInput): AccountProjection[] {
  const byDate = new Map<string, ForecastEvent[]>();
  for (const event of input.events) {
    if (event.date < input.today || event.date > input.end || !Number.isFinite(event.amount)) continue;
    byDate.set(event.date, [...(byDate.get(event.date) ?? []), event]);
  }
  return input.accounts.map((account) => {
    let balance = account.start;
    let lowest = { date: input.today, balance: round(balance) };
    const months = new Map<string, { month: string; min: number; end: number }>();
    const lows: LowPoint[] = [];
    let open: LowPoint | undefined;
    for (let date = input.today; date <= input.end; date = nextDay(date)) {
      const events = (byDate.get(date) ?? []).filter((event) => event.account === account.name);
      balance += events.reduce((sum, event) => sum + event.amount, 0);
      const value = round(balance);
      const month = months.get(date.slice(0, 7)) ?? { month: date.slice(0, 7), min: value, end: value };
      month.min = Math.min(month.min, value); month.end = value;
      months.set(month.month, month);
      if (value < lowest.balance) lowest = { date, balance: value };
      if (value < account.threshold - 0.005) {
        if (!open) {
          const outflows = events.filter((event) => event.amount < 0).sort((a, b) =>
            Number(a.kind === "spending") - Number(b.kind === "spending") || a.amount - b.amount);
          open = { account: account.name, date, balance: value, lowest: value, lowestDate: date, ...(outflows[0] ? { cause: outflows[0] } : {}) };
          lows.push(open);
        } else if (value < open.lowest) { open.lowest = value; open.lowestDate = date; }
      } else if (open) { open.recovered = date; open = undefined; }
    }
    return { name: account.name, start: round(account.start), end: round(balance), threshold: account.threshold, lowest, months: [...months.values()], lows };
  });
}

export const GIRO = "Girokonto";
export const forecastQuestion = (lower: string) =>
  /kontoprognose|cash-?flow|liquiditätsplan|liquiditaetsplan|liquiditätsprognose|wird (?:mein|das) (?:giro)?konto (?:knapp|leer|eng|negativ|ins minus)|(?:wann|wo) wird (?:es|mein (?:giro)?konto|das (?:giro)?konto) (?:knapp|eng|leer)|komm(?:e|t)? ich (?:ins|in den) minus|rutsch\w* (?:ich|mein konto|das konto) ins minus|wie entwickelt sich mein (?:konto(?:stand)?|girokonto|guthaben)|entwicklung (?:meines|des) kontostand|reicht (?:mein|das) geld bis|prognose (?:für |fuer )?(?:mein(?:e)? )?(?:giro)?kont/.test(lower);
export const SAVINGS = "Sparkonto";
const isAmexBank = (bank: string) => /^(?:amex|american express)$/i.test(bank.trim());
const amexRepayment = (text: string) => /zahlung\s*\/\s*überweisung\s+erhalten/i.test(text);

// Giro balance the user told the assistant ("Merk dir: Girokonto 1.200 €").
export function giroNote(state: AppState): number | undefined {
  const note = (state.assistantMemory ?? []).findLast((entry) => entry.key === "note" && /giro|raiffeisen|hauptkonto/i.test(entry.text) &&
    /\d/.test(entry.text));
  const match = note && /(-?\d[\d.\s]*(?:,\d{1,2})?)\s*(k\b|tsd|tausend)?/i.exec(note.text.replace(/\b20\d{2}-\d{2}-\d{2}\b/g, ""));
  const value = match ? parseAmount(match[1].trim()) : undefined;
  return value === undefined ? undefined : (match![2] ? value * 1000 : value) * (match![1].startsWith("-") ? -1 : 1);
}

export function buildForecastInput(state: AppState, dashboard: Dashboard, today: string, months = 12) {
  const current = today.slice(0, 7);
  const end = dayIn(addMonths(current, months), Number(today.slice(8)));
  const range = Array.from({ length: months + 1 }, (_, index) => addMonths(current, index));
  const rowFor = (month: string) => dashboard.timeline.find((row) => row.month === month) ?? dashboard.timeline.at(-1)!;
  const events: ForecastEvent[] = [];
  const add = (date: string, account: string, amount: number, label: string, kind: ForecastKind) => {
    if (date >= today && date <= end && Math.abs(amount) >= 0.005) events.push({ date, account, amount: round(amount), label, kind });
  };
  const entries = ledger(state);
  const salaryRows = entries.filter(({ row, category }) => row.amount > 0 && category === "Gehalt" && row.date <= today)
    .sort((a, b) => b.row.date.localeCompare(a.row.date)).slice(0, 6);
  const memoryDay = (state.assistantMemory ?? []).findLast((entry) => entry.key === "salaryDay")?.value;
  const salaryDay = Math.round(memoryDay ?? median(salaryRows.map(({ row }) => Number(row.date.slice(8)))) ?? 1);
  const salaryBooked = salaryRows.some(({ row }) => row.date.startsWith(current));

  const bookings = actualBookings(state).filter((row) => row.date <= today);
  const repayments = bookings.filter((row) => isAmexBank(row.bank) && row.amount > 0 && amexRepayment([row.description, row.rawDescription].join(" ")))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const amexDay = median(repayments.map((row) => Number(row.date.slice(8)))) ?? 15;
  const amexMonths = [1, 2, 3].map((offset) => addMonths(current, -offset));
  const amexSpent = bookings.filter((row) => isAmexBank(row.bank) && row.amount < 0 && amexMonths.includes(row.date.slice(0, 7)) &&
    !classify(row).isTransfer && !classify(row).isFixedCost).reduce((sum, row) => sum - personalAmount(row), 0);
  const planOf = (month: string) => { const row = rowFor(month); return Math.max(0, row.variablePlan - row.amexOpen); };
  const referencePlan = planOf(addMonths(current, 1));
  // Card share of the everyday budget; capped so card + direct spending never exceed the monthly plan.
  const amexShare = referencePlan > 0 ? Math.min(1, amexSpent / 3 / referencePlan) : 0;
  const amexMonthly = round(amexShare * referencePlan);

  const fixedRows = state.financeRows.filter((row) => row.kind === "fixed");
  const subscriptions = detectSubscriptions(state, today).filter((item) => {
    const name = item.merchant.toLowerCase();
    const covered = fixedRows.some((row) => {
      const label = row.label.toLowerCase();
      return label.length >= 3 && (name.includes(label) || label.includes(name)) ||
        Object.values(row.values).some((value) => Math.abs((value ?? 0) - item.amount) < 0.01);
    });
    const last = state.transactions.find((row) => row.date === item.lastDate && Math.abs(Math.abs(row.amount) - item.amount) < 0.01);
    return !covered && !(last && isAmexBank(last.bank));
  });
  const subscriptionMonthly = round(subscriptions.reduce((sum, item) => sum + item.monthlyCost, 0));

  const giroKnown = giroNote(state);
  const latest = new Map<string, { date: string; balance: number }>();
  for (const item of state.accountSnapshots ?? []) {
    if (item.date > today || dashboard.physical[pocketKey(item.name)]) continue;
    const previous = latest.get(item.name);
    if (!previous || item.date > previous.date) latest.set(item.name, item);
  }
  const snapshots = round([...latest.values()].reduce((sum, item) => sum + item.balance, 0));
  const giroStart = round((giroKnown ?? 0) + snapshots + dashboard.amex.reserved);
  const savingsStart = dashboard.physical.sparkonto?.amount ?? 0;
  const buffer = (state.assistantMemory ?? []).findLast((entry) => entry.key === "buffer")?.value ?? 0;

  const schedule = fixedScheduleDays(state, today);
  for (const month of range) {
    const row = rowFor(month);
    const isCurrent = month === current;
    const salaryDate = dayIn(month, salaryDay);
    if (!isCurrent || (!salaryBooked && salaryDate >= today)) add(salaryDate, GIRO, row.income, "Gehalt", "salary");
    if (isCurrent) {
      for (const item of schedule.open) add(item.date < today ? today : item.date, GIRO, -item.amount, item.name, "fixed");
      const missing = dashboard.monthlyFunding.filter((item) => !item.done).map((item) => ({ item, open: round(Math.max(0, item.amount - item.transferred)) }));
      const transferDate = salaryDate < today ? today : salaryDate;
      for (const { item, open } of missing) {
        add(transferDate, GIRO, -open, `Sparrate ${item.name}`, "transfer");
        if (pocketKey(item.pocket) === "sparkonto") add(transferDate, SAVINGS, open, `Sparrate ${item.name}`, "transfer");
      }
    } else {
      const scale = schedule.total > 0 ? row.fixed / schedule.total : 0;
      if (!schedule.items.length) add(dayIn(month, 1), GIRO, -row.fixed, "Fixkosten", "fixed");
      for (const item of schedule.items) add(dayIn(month, item.day), GIRO, -item.planned * scale, item.name, "fixed");
      const rates = Object.values(row.rates).reduce((sum, value) => sum + value, 0);
      add(salaryDate, GIRO, -rates, "Sparraten", "transfer");
      add(salaryDate, SAVINGS, row.rates.Sparkonto ?? 0, "Sparrate", "transfer");
    }
    const amexDate = dayIn(month, amexDay);
    const debitPassed = dayIn(current, amexDay) < today;
    const amount = isCurrent ? (debitPassed ? 0 : dashboard.amex.ownOutstanding)
      : month === addMonths(current, 1) && debitPassed ? Math.max(dashboard.amex.ownOutstanding, amexShare * planOf(current))
        : amexShare * planOf(addMonths(month, -1));
    add(amexDate, GIRO, -amount, "Amex-Abbuchung", "amex");
    for (const item of subscriptions) {
      if (item.interval === "jährlich" ? item.nextDate.slice(0, 7) !== month && addMonths(item.nextDate.slice(0, 7), 12) !== month : false) continue;
      add(dayIn(month, Number(item.nextDate.slice(8))), GIRO, -item.amount, item.merchant, "subscription");
    }
    const plan = planOf(month);
    const direct = (isCurrent ? Math.max(0, plan - row.actualSpending) : plan) * (1 - amexShare);
    const variable = Math.max(0, direct - (isCurrent ? 0 : subscriptionMonthly));
    const first = isCurrent ? Number(today.slice(8)) + 1 : 1;
    const days = daysInMonth(month) - first + 1;
    for (let day = first; days > 0 && day <= daysInMonth(month); day++) add(dayIn(month, day), GIRO, -variable / days, "Alltagsausgaben", "spending");
  }
  for (const item of dashboard.plannedOneOffs) {
    if (item.bookingId || item.date < today) continue;
    add(item.date, item.pocket === "Sparkonto" ? SAVINGS : GIRO, -item.ownAmount, item.name, "planned");
  }
  return {
    input: { today, end, accounts: [{ name: GIRO, start: giroStart, threshold: buffer }, { name: SAVINGS, start: savingsStart, threshold: 0 }], events } satisfies ForecastInput,
    meta: { salaryDay, amexDay, amexMonthly, giroKnown: giroKnown !== undefined, buffer, reserved: dashboard.amex.reserved, snapshots },
  };
}

function fixedScheduleDays(state: AppState, today: string) {
  const current = today.slice(0, 7);
  const rows = state.financeRows.filter((row) => row.kind === "fixed" && (row.values[current] ?? 0) > 0);
  const history = new Map<string, number[]>();
  const amexPaid = new Set<string>();
  for (const { row } of [...ledger(state)].sort((a, b) => a.row.date.localeCompare(b.row.date))) {
    if (row.amount >= 0 || row.date > today) continue;
    const text = [row.merchantAlias, row.description].filter(Boolean).join(" ").toLowerCase();
    for (const plan of rows) {
      if (plan.label.length < 3 || !text.includes(plan.label.toLowerCase())) continue;
      history.set(plan.id, [...(history.get(plan.id) ?? []), Number(row.date.slice(8))]);
      if (isAmexBank(row.bank)) amexPaid.add(plan.id);
    }
  }
  const items = rows.map((row) => ({ id: row.id, name: row.label, planned: row.values[current] ?? 0, amex: amexPaid.has(row.id),
    day: median(history.get(row.id)?.slice(-3) ?? []) ?? 1 }));
  const open = items.filter((item) => !item.amex && item.day >= Number(today.slice(8)) &&
    !(state.transactions.some((row) => row.date.startsWith(current) && row.date <= today && row.amount < 0 &&
      [row.merchantAlias, row.description].filter(Boolean).join(" ").toLowerCase().includes(item.name.toLowerCase()))))
    .map((item) => ({ name: item.name, amount: item.planned, date: dayIn(current, item.day) }));
  return { items, open, total: items.reduce((sum, item) => sum + item.planned, 0) };
}

const dayText = (date: string, today: string) =>
  `${Number(date.slice(8))}. ${monthLabel(date.slice(0, 7)).replace(/\s\d{4}$/, "")}${date.slice(0, 4) !== today.slice(0, 4) ? ` ${date.slice(0, 4)}` : ""}`;
const because = (event?: ForecastEvent) => !event ? "" : event.kind === "amex" ? ", weil die Amex abgebucht wird"
  : event.kind === "fixed" ? `, weil ${event.label} fällig ist` : event.kind === "subscription" ? `, weil ${event.label} abgebucht wird`
    : event.kind === "planned" ? `, weil ${event.label} geplant ist` : event.kind === "transfer" ? ", weil die Sparraten überwiesen werden"
      : " wegen der laufenden Alltagsausgaben";

export function accountForecast(state: AppState, dashboard: Dashboard, today: string) {
  const { input, meta } = buildForecastInput(state, dashboard, today);
  const projections = projectAccounts(input);
  return { projections, meta, events: input.events, giro: projections.find((item) => item.name === GIRO)! };
}

export function forecastAnswer(state: AppState, dashboard: Dashboard, today: string): { text: string; card: AssistantCard; suggestions: string[] } {
  const { projections, meta, events, giro } = accountForecast(state, dashboard, today);
  const savings = projections.find((item) => item.name === SAVINGS)!;
  const first = giro.lows[0];
  const limit = meta.buffer > 0 ? ` (unter deinem Puffer von ${currency(meta.buffer)})` : "";
  const text = first
    ? `Am ${dayText(first.date, today)} wird dein Girokonto knapp (${currency(first.balance)})${because(first.cause)}${limit}.` +
      (first.recovered ? ` Ab ${dayText(first.recovered, today)} bist du wieder drüber.` : " Bis zum Ende der Prognose erholt es sich nicht.") +
      (giro.lows.length > 1 ? ` In den nächsten 12 Monaten passiert das ${giro.lows.length}-mal.` : "")
    : `Dein Girokonto bleibt in den nächsten 12 Monaten${meta.buffer > 0 ? ` über deinem Puffer von ${currency(meta.buffer)}` : " im Plus"}. ` +
      `Am knappsten wird es am ${dayText(giro.lowest.date, today)} mit ${currency(giro.lowest.balance)}.`;
  const lines: Line[] = giro.lows.slice(0, 6).map((low) => ({ label: `${dateLabel(low.date)} · ${low.cause?.label ?? "Alltagsausgaben"}`, value: low.balance, tone: "bad",
    detail: `Girokonto${meta.buffer > 0 ? ` unter ${currency(meta.buffer)}` : " im Minus"} · tiefster Stand ${currency(low.lowest)} am ${dateLabel(low.lowestDate)}` +
      (low.recovered ? ` · wieder drüber ab ${dateLabel(low.recovered)}` : "") }));
  const nextAmex = events.find((event) => event.kind === "amex");
  if (nextAmex) lines.push({ label: `Nächste Amex-Abbuchung · ${dateLabel(nextAmex.date)}`, value: nextAmex.amount, tone: "info",
    detail: `danach Ø ${currency(meta.amexMonthly)} pro Monat` });
  const nextSalary = events.find((event) => event.kind === "salary");
  if (nextSalary) lines.push({ label: `Nächstes Gehalt · ${dateLabel(nextSalary.date)}`, value: nextSalary.amount, tone: "good" });
  lines.push({ label: "Tiefster Stand Girokonto", value: giro.lowest.balance, detail: dateLabel(giro.lowest.date), tone: giro.lowest.balance < giro.threshold ? "warn" : "info" });
  lines.push({ label: "Girokonto heute", value: giro.start,
    detail: meta.giroKnown ? `inkl. Amex-Rückzahlung (${currency(meta.reserved)})` : `nur Amex-Rückzahlung (${currency(meta.reserved)}), Raiffeisen-Stand unbekannt` });
  lines.push({ label: `Sparkonto in 12 Monaten`, value: savings.end, detail: `heute ${currency(savings.start)}`, tone: "good" });
  const chart = buildChart("line", projections.map((item) => ({ name: item.name, points: item.months.map((month) => ({ label: shortMonth(month.month), value: month.min })) })),
    { label: meta.buffer > 0 ? "Puffer" : "0 €", value: meta.buffer });
  const note = `Schätzung: Gehalt am ${meta.salaryDay}., Amex-Abbuchung um den ${meta.amexDay}., Fixkosten, Monatsplan, Sparraten und geplante Ausgaben. Diagramm = tiefster Stand pro Monat.` +
    (meta.giroKnown ? "" : " Sag mir deinen Girokonto-Stand („Merk dir: Girokonto 1.500 €“), dann wird es genauer.");
  return { text, card: { kind: "forecast", title: "Kontoprognose · 12 Monate", total: giro.lowest.balance, lines: lines.slice(0, 40), ...(chart ? { chart } : {}), note: note.slice(0, 400) },
    suggestions: meta.giroKnown ? ["Was bleibt mir diesen Monat?", "Wie viel muss ich auf Amex Rückzahlung überweisen?"]
      : ["Merk dir: Girokonto 1.500 €", "Wie viel muss ich auf Amex Rückzahlung überweisen?"] };
}
