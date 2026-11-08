import { addMonths, round, type Dashboard } from "@/lib/calc";
import { detectSubscriptions, ledger } from "@/lib/insights";
import { plannedOccurrences } from "@/lib/planned-one-offs";
import type { AppState } from "@/lib/types";
import { balances } from "./accounts";
import { budgetPace, safeToSpend, salaryStatus } from "./pulse";

const DAY_MS = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// Finished numbers for a free question; the model only phrases them and never calculates.
export function assistantFacts(state: AppState, dashboard: Dashboard, today: string) {
  const firstMonth = addMonths(today.slice(0, 7), -2);
  const spending = new Map<string, number>();
  for (const { row, category } of ledger(state)) {
    if (row.amount >= 0 || row.date.slice(0, 7) < firstMonth || row.date > today) continue;
    const key = `${row.date.slice(0, 7)}|${category}`;
    spending.set(key, round((spending.get(key) ?? 0) - row.amount));
  }
  const byMonth: Record<string, Record<string, number>> = {};
  for (const [key, value] of spending) {
    const [month, category] = key.split("|");
    (byMonth[month] ??= {})[category] = value;
  }
  const row = dashboard.current;
  const known = balances(state, dashboard);
  const safe = safeToSpend(state, dashboard, today);
  const salary = salaryStatus(state, today);
  return {
    today,
    totalSavings: dashboard.totalAssets,
    totalOnAllAccounts: round(dashboard.totalAssets + known.reduce((sum, item) => sum + (item.date && item.amount !== null ? item.amount : 0), 0)),
    balances: known.filter((item) => item.amount !== null && Math.abs(item.amount) >= 0.005)
      .slice(0, 25).map((item) => ({ name: item.name, amount: item.amount, ...(item.date ? { asOf: item.date } : {}) })),
    amex: { open: dashboard.amex.outstanding, ownShare: dashboard.amex.ownOutstanding, onRepaymentPocket: dashboard.amex.reserved, stillToTransfer: dashboard.amex.shortfall },
    currentMonth: { month: dashboard.currentMonth, income: row.income, fixedCosts: row.fixed, everydayBudget: round(row.variablePlan - row.amexOpen),
      plannedOneOffs: row.plannedOneOffs, surplus: row.surplus, spentSoFar: row.actualSpending,
      budgets: budgetPace(dashboard, today).map((item) => ({ name: item.label, planned: item.total, spent: item.actual, status: item.status })),
      fixedCostsNotYetDebited: dashboard.missingFixed.slice(0, 10) },
    safeToSpendToday: safe ? { perDay: safe.perDay, freeUntilSalary: safe.free, nextSalary: safe.until } : null,
    salary: { receivedThisMonth: salary.received, ...(salary.date ? { receivedOn: salary.date } : {}), ...(salary.expected ? { expected: salary.expected } : {}) },
    goals: dashboard.goals.filter((goal) => !goal.completedAt).slice(0, 20).map((goal) => ({
      name: goal.name, target: goal.target, date: goal.date, saved: dashboard.goalStatuses[goal.id]?.amount ?? null, monthly: goal.funding?.monthly ?? 0 })),
    upcoming: plannedOccurrences(state.plannedOneOffs).filter((item) => item.date >= today && item.date <= shift(today, 90) && !item.bookingId)
      .slice(0, 20).map((item) => ({ name: item.name, date: item.date, amount: item.ownAmount })),
    spendingByMonthAndCategory: byMonth,
    subscriptions: detectSubscriptions(state, today).slice(0, 25).map((item) => ({ name: item.merchant, monthly: item.monthlyCost })),
    memory: (state.assistantMemory ?? []).slice(0, 20).map((item) => item.text),
  };
}
export type AssistantFacts = ReturnType<typeof assistantFacts>;
