import { actualBookings, bookingMonth, classify } from "@/lib/calc";
import { canonicalCategory, isEverydayCategory, type Category } from "@/lib/categories";
import { brandKey } from "@/lib/ai/evidence";
import { categoryParts } from "@/lib/splits";
import type { AppState, Transaction } from "@/lib/types";
import { personalAmount, type AccountedTransaction } from "@/lib/shared-holiday";

const DAY_MS = 86_400_000;
const money = (value: number) => Math.round(value * 100) / 100;
const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export type Subscription = {
  merchant: string;
  category: Category;
  interval: "monatlich" | "jährlich";
  amount: number;
  monthlyCost: number;
  lastDate: string;
  nextDate: string;
  count: number;
  priceChange?: { from: number; to: number; percent: number; date: string };
};
export type DuplicateCharge = { merchant: string; amount: number; dates: [string, string]; ids: [string, string] };
export type DuplicateFixedCost = { label: string; amount: number; count: number; ids: string[] };
export type MonthSummary = {
  month: string;
  income: number;
  spending: number;
  balance: number;
  topCategories: { category: Category; amount: number; change?: number }[];
  largest: { date: string; merchant: string; amount: number; category: Category }[];
  previousSpending?: number;
};
export type BudgetForecast = {
  month: string;
  spentSoFar: number;
  expectedSubscriptions: number;
  expectedVariable: number;
  projectedSpending: number;
  averageSpending?: number;
  daysLeft: number;
};
export type LearningCurve = {
  imports: { id: string; name: string; at: number; rows: number; assigned: number; share: number }[];
  share?: number;
  openTotal: number;
  openMerchants: { merchant: string; count: number }[];
};
export type FinanceInsights = {
  subscriptions: Subscription[];
  priceIncreases: Subscription[];
  duplicates: DuplicateCharge[];
  duplicateFixedCosts: DuplicateFixedCost[];
  summary: MonthSummary;
  previousSummary?: MonthSummary;
  forecast: BudgetForecast;
  learning: LearningCurve;
};

// Share of each import that needed no manual review, and which merchants still wait for a person.
export function learningCurve(state: AppState, limit = 8): LearningCurve {
  const imports = (state.aiLearning ?? []).slice(-limit).map((entry) => {
    const assigned = Math.min(entry.rows, entry.automatic + entry.ai + (entry.later ?? 0));
    return { id: entry.id, name: entry.name, at: entry.at, rows: entry.rows, assigned,
      share: Math.round((assigned / entry.rows) * 100) };
  });
  const rows = imports.reduce((sum, entry) => sum + entry.rows, 0);
  const open = (state.reviewQueue ?? []).flatMap((item) => item.kind === "booking" ? [item.draft] : []);
  const merchants = new Map<string, { merchant: string; count: number }>();
  for (const draft of open) {
    const key = brandKey(draft) ?? draft.description.trim().toLowerCase();
    const entry = merchants.get(key) ?? { merchant: draft.merchantAlias?.trim() || draft.description.trim().slice(0, 40), count: 0 };
    entry.count++;
    merchants.set(key, entry);
  }
  return {
    imports,
    ...(rows ? { share: Math.round((imports.reduce((sum, entry) => sum + entry.assigned, 0) / rows) * 100) } : {}),
    openTotal: open.length,
    openMerchants: [...merchants.values()].filter((entry) => entry.count > 1)
      .sort((left, right) => right.count - left.count || left.merchant.localeCompare(right.merchant)).slice(0, 5),
  };
}

const merchantName = (row: Transaction) => row.merchantAlias?.trim() || row.description.trim().slice(0, 40);

// Rows that count as household spending or income: no transfers, nothing still under review.
export function ledger(state: AppState) {
  const open = new Set((state.reviewQueue ?? []).flatMap((item) => item.kind === "booking" ? [item.draft.id] : []));
  return state.transactions.flatMap((row) => {
    if (open.has(row.id) || !row.amount) return [];
    const result = classify(row);
    if (result.isTransfer) return [];
    return [{ row, category: canonicalCategory(result.category) }];
  });
}

export function detectSubscriptions(state: AppState, today = new Date().toISOString().slice(0, 10)): Subscription[] {
  const groups = new Map<string, { row: Transaction; category: Category }[]>();
  for (const entry of ledger(state)) {
    if (entry.row.amount >= 0 || isEverydayCategory(entry.category)) continue;
    const brand = brandKey(entry.row);
    if (!brand) continue;
    groups.set(brand, [...(groups.get(brand) ?? []), entry]);
  }
  const subscriptions: Subscription[] = [];
  for (const entries of groups.values()) {
    const sorted = [...entries].sort((a, b) => a.row.date.localeCompare(b.row.date));
    for (const interval of ["monatlich", "jährlich"] as const) {
      const [low, high] = interval === "monatlich" ? [25, 35] : [350, 380];
      // The longest recent run of charges at this rhythm with stable amounts.
      const run: typeof sorted = [];
      for (let index = sorted.length - 1; index >= 0; index--) {
        const entry = sorted[index];
        if (!run.length) { run.unshift(entry); continue; }
        const gap = (time(run[0].row.date) - time(entry.row.date)) / DAY_MS;
        if (gap < low) continue;
        if (gap > high) break;
        const reference = Math.abs(run[0].row.amount);
        if (Math.abs(Math.abs(entry.row.amount) - reference) > reference * 0.25) break;
        run.unshift(entry);
      }
      const minimum = interval === "monatlich" ? 3 : 2;
      if (run.length < minimum) continue;
      const span = sorted.filter((entry) => entry.row.date >= run[0].row.date).length;
      // A shop visited weekly has a "monthly" charge somewhere too; subscriptions stand alone.
      if (span > run.length + Math.floor(run.length / 3)) continue;
      const last = run[run.length - 1];
      const step = interval === "monatlich" ? 30.44 : 365.25;
      const nextMs = time(last.row.date) + Math.round(step) * DAY_MS;
      // Stopped subscriptions are history, not a cost.
      if (time(today) - nextMs > (interval === "monatlich" ? 20 : 60) * DAY_MS) continue;
      const amounts = run.map((entry) => Math.abs(entry.row.amount));
      const usual = median(amounts.slice(0, -1));
      const current = amounts[amounts.length - 1];
      const percent = usual ? (current - usual) / usual * 100 : 0;
      subscriptions.push({
        merchant: merchantName(last.row), category: last.category, interval,
        amount: money(current), monthlyCost: money(interval === "monatlich" ? current : current / 12),
        lastDate: last.row.date, nextDate: isoDate(nextMs), count: run.length,
        ...(percent > 2 && current - usual >= 0.5
          ? { priceChange: { from: money(usual), to: money(current), percent: Math.round(percent * 10) / 10, date: last.row.date } } : {}),
      });
      break;
    }
  }
  return subscriptions.sort((a, b) => b.monthlyCost - a.monthlyCost);
}

// Same account, same text and amount on the same day (or the next day for larger sums, which
// banks sometimes post with a delay) and no other such charge nearby: likely billed twice.
// Different cards, round trips (tolls) or a coffee on two days are separate purchases.
export function detectDuplicateCharges(state: AppState, since?: string): DuplicateCharge[] {
  const rows = state.transactions.filter((row) => row.amount <= -5 && (!since || row.date >= since))
    .sort((a, b) => a.date.localeCompare(b.date));
  const buckets = new Map<string, Transaction[]>();
  for (const row of rows) {
    if (classify(row).isTransfer) continue;
    const key = `${row.bank}|${row.pocket ?? ""}|${(row.merchantAlias ?? row.description).trim().toLocaleLowerCase("de-AT")}|${row.amount.toFixed(2)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  const duplicates: DuplicateCharge[] = [];
  for (const bucket of buckets.values()) {
    for (let index = 1; index < bucket.length; index++) {
      const [first, second] = [bucket[index - 1], bucket[index]];
      const gap = Math.round((time(second.date) - time(first.date)) / DAY_MS);
      if (gap > (first.amount <= -20 ? 1 : 0) || first.id === second.id) continue;
      // Three or more in a short window is a habit (coffee, parking), not a double charge.
      const neighbours = bucket.filter((row) => Math.abs(time(row.date) - time(first.date)) <= 14 * DAY_MS);
      if (neighbours.length !== 2) continue;
      duplicates.push({ merchant: merchantName(first), amount: money(first.amount), dates: [first.date, second.date], ids: [first.id, second.id] });
    }
  }
  return duplicates.sort((a, b) => b.dates[1].localeCompare(a.dates[1]));
}

type AccountedEntry = { row: AccountedTransaction; category: Category; amount: number; month: string; income: boolean };
const incomeCategories = new Set(["Einkommen", "Gehalt", "Rufbereitschaft"]);
// Same accounting as the dashboard KPIs: own share of shared bookings, statement receipts,
// payroll month and refunds – so "Einblicke" and "Ausgaben · Ist" never disagree.
function accountedLedger(state: AppState): AccountedEntry[] {
  return actualBookings(state).flatMap((row) => {
    const result = classify(row);
    const amount = personalAmount(row);
    if (result.isTransfer || !amount) return [];
    return [{ row, category: canonicalCategory(result.category), amount, month: bookingMonth(row), income: incomeCategories.has(result.category) }];
  });
}

export function summarizeMonth(state: AppState, month: string, entries = accountedLedger(state)): MonthSummary {
  const totals = new Map<Category, number>();
  let income = 0;
  const spendingRows: AccountedEntry[] = [];
  for (const entry of entries) {
    if (entry.month !== month) continue;
    if (entry.income) { income += entry.amount; continue; }
    for (const part of categoryParts(entry.row, entry.category))
      totals.set(part.category, (totals.get(part.category) ?? 0) - entry.amount * part.share);
    if (entry.amount < 0) spendingRows.push(entry);
  }
  const spending = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return {
    month, income: money(income), spending: money(spending), balance: money(income - spending),
    topCategories: [...totals].filter(([, amount]) => amount > 0.004).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([category, amount]) => ({ category, amount: money(amount) })),
    largest: spendingRows.sort((a, b) => a.amount - b.amount).slice(0, 3).map(({ row, category, amount }) =>
      ({ date: row.date, merchant: merchantName(row), amount: money(amount), category })),
  };
}

const shiftMonth = (month: string, delta: number) => {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
};

export function forecastMonth(state: AppState, subscriptions: Subscription[], today: string, entries = accountedLedger(state)): BudgetForecast {
  const month = today.slice(0, 7);
  const current = summarizeMonth(state, month, entries);
  const recurring = new Set(subscriptions.map((item) => item.merchant));
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const day = Number(today.slice(8, 10));
  const daysLeft = daysInMonth - day;
  const expectedSubscriptions = subscriptions
    .filter((item) => item.interval === "monatlich" ? item.nextDate > today && item.nextDate.startsWith(month)
      : item.nextDate.startsWith(month) && item.nextDate > today)
    .reduce((sum, item) => sum + item.amount, 0);
  // Daily variable spending (own share) of the last three complete months. The median keeps a
  // single month with a large one-off purchase from inflating the rest of this month.
  const previous = [1, 2, 3].map((offset) => shiftMonth(month, -offset));
  const variable = previous.map((prior) => {
    const [y, m] = prior.split("-").map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const spent = entries.filter((entry) => entry.month === prior && !entry.income && entry.amount < 0 && !recurring.has(merchantName(entry.row)))
      .reduce((sum, entry) => sum - entry.amount, 0);
    return spent / days;
  }).filter((value) => value > 0);
  const perDay = variable.length ? median(variable) : 0;
  const totals = previous.map((prior) => summarizeMonth(state, prior, entries).spending).filter((value) => value > 0);
  return {
    month, spentSoFar: current.spending, expectedSubscriptions: money(expectedSubscriptions),
    expectedVariable: money(perDay * daysLeft),
    projectedSpending: money(current.spending + expectedSubscriptions + perDay * daysLeft),
    ...(totals.length ? { averageSpending: money(totals.reduce((sum, value) => sum + value, 0) / totals.length) } : {}),
    daysLeft,
  };
}

// Plausibility check on the plan: the same fixed cost counted twice in one month.
export function detectDuplicateFixedCosts(state: AppState, month: string): DuplicateFixedCost[] {
  const groups = new Map<string, { label: string; amount: number; ids: string[] }>();
  for (const row of state.financeRows) {
    const amount = row.values[month];
    if (row.kind !== "fixed" || !amount) continue;
    const key = `${row.label.trim().toLocaleLowerCase("de")}|${Math.round(Math.abs(amount) * 10)}`;
    const entry = groups.get(key) ?? { label: row.label.trim(), amount: money(Math.abs(amount)), ids: [] };
    entry.ids.push(row.id);
    groups.set(key, entry);
  }
  return [...groups.values()].filter((entry) => entry.ids.length > 1).map((entry) => ({ ...entry, count: entry.ids.length }));
}

export function financeInsights(state: AppState, today = new Date().toISOString().slice(0, 10)): FinanceInsights {
  const subscriptions = detectSubscriptions(state, today);
  const entries = accountedLedger(state);
  const month = today.slice(0, 7);
  const lastMonth = shiftMonth(month, -1);
  const previousSummary = summarizeMonth(state, lastMonth, entries);
  const before = summarizeMonth(state, shiftMonth(month, -2), entries);
  const beforeTotals = new Map(before.topCategories.map((item) => [item.category, item.amount]));
  const sixtyDaysAgo = isoDate(time(today) - 60 * DAY_MS);
  return {
    subscriptions,
    priceIncreases: subscriptions.filter((item) => item.priceChange && item.priceChange.date >= isoDate(time(today) - 120 * DAY_MS)),
    duplicates: detectDuplicateCharges(state, sixtyDaysAgo),
    duplicateFixedCosts: detectDuplicateFixedCosts(state, month),
    summary: summarizeMonth(state, month, entries),
    previousSummary: {
      ...previousSummary,
      ...(before.spending ? { previousSpending: before.spending } : {}),
      topCategories: previousSummary.topCategories.map((item) => {
        const prior = beforeTotals.get(item.category);
        return prior ? { ...item, change: money(item.amount - prior) } : item;
      }),
    },
    forecast: forecastMonth(state, subscriptions, today, entries),
    learning: learningCurve(state),
  };
}
