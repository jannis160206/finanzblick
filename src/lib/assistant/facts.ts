import { addMonths, latestTRBalance, round, type Dashboard } from "@/lib/calc";
import { financeInsights, ledger } from "@/lib/insights";
import { currency } from "@/lib/format";
import { plannedOccurrences } from "@/lib/planned-one-offs";
import type { AppState } from "@/lib/types";
import { balances } from "./accounts";
import { budgetPace, safeToSpend, salaryStatus, unusualCategories } from "./pulse";
import { accountLabel, accountsWithRules, ruleText } from "./funds";
import { financialCheck } from "./check";
import { accountForecast } from "./forecast";

const DAY_MS = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// Finished numbers for a free question; the model only phrases them and never calculates.
export function assistantFacts(state: AppState, dashboard: Dashboard, today: string) {
  const firstMonth = addMonths(today.slice(0, 7), -2);
  const spending = new Map<string, number>();
  const year = new Map<string, number>();
  let yearIncome = 0;
  for (const { row, category } of ledger(state)) {
    if (row.date > today || row.date.slice(0, 4) !== today.slice(0, 4) && row.date.slice(0, 7) < firstMonth) continue;
    if (row.date.slice(0, 4) === today.slice(0, 4)) {
      if (row.amount < 0) year.set(category, (year.get(category) ?? 0) - row.amount);
      else yearIncome += row.amount;
    }
    if (row.amount >= 0 || row.date.slice(0, 7) < firstMonth) continue;
    const key = `${row.date.slice(0, 7)}|${category}`;
    spending.set(key, round((spending.get(key) ?? 0) - row.amount));
  }
  // Only the largest categories per month; the model's prompt is limited.
  const byMonth: Record<string, Record<string, number>> = {};
  for (const [key, value] of [...spending].sort((a, b) => b[1] - a[1])) {
    const [month, category] = key.split("|");
    const entry = byMonth[month] ??= {};
    if (Object.keys(entry).length < 8) entry[category] = value;
  }
  const monthsSoFar = Number(today.slice(5, 7));
  const yearSpending = round([...year.values()].reduce((sum, value) => sum + value, 0));
  const insights = financeInsights(state, today);
  let giro: ReturnType<typeof accountForecast>["giro"] | undefined;
  try { giro = accountForecast(state, dashboard, today).giro; } catch { giro = undefined; }
  const interest = state.settings.interestRates?.at(-1);
  const tr = latestTRBalance(state, today);
  const row = dashboard.current;
  const known = balances(state, dashboard);
  const safe = safeToSpend(state, dashboard, today);
  const salary = salaryStatus(state, today);
  return {
    today,
    totalSavings: dashboard.totalAssets,
    totalOnAllAccounts: round(dashboard.totalAssets + known.reduce((sum, item) => sum + (item.date && item.amount !== null ? item.amount : 0), 0)),
    // Empty accounts stay listed, so "Wieso ist Revolut auf 0?" can be answered.
    balances: known.filter((item) => item.amount !== null)
      .slice(0, 25).map((item) => ({ name: item.name, ...(item.bank ? { bank: item.bank } : {}), amount: item.amount, ...(item.date ? { asOf: item.date } : {}) })),
    // Which account may pay for what; "Kann ich mir … leisten?" must only count the allowed ones.
    accountRules: accountsWithRules(state, dashboard, today).slice(0, 20).map((item) => ({ account: accountLabel(item), usableNow: item.available, rule: ruleText(item) })),
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
    yearToDate: { year: today.slice(0, 4), income: round(yearIncome), spending: yearSpending, savedSinceJanuary: round(yearIncome - yearSpending),
      summary: yearIncome >= yearSpending ? `Seit Jänner ${currency(yearIncome - yearSpending)} mehr eingenommen als ausgegeben.`
        : `Seit Jänner ${currency(yearSpending - yearIncome)} mehr ausgegeben als eingenommen (ohne Umbuchungen aufs Sparkonto).`,
      averageSpendingPerMonth: monthsSoFar ? round(yearSpending / monthsSoFar) : 0,
      topCategories: [...year].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([category, total]) => ({ category, total: round(total), perMonth: round(total / monthsSoFar) })) },
    largestThisMonth: insights.summary.largest.slice(0, 5).map((item) => ({ name: item.merchant, amount: item.amount, date: item.date, category: item.category })),
    largestLastMonth: (insights.previousSummary?.largest ?? []).slice(0, 3).map((item) => ({ name: item.merchant, amount: item.amount, date: item.date })),
    unusuallyHighThisMonth: unusualCategories(state, today).slice(0, 4),
    projectedSpendingThisMonth: insights.forecast.projectedSpending,
    possibleDuplicateCharges: insights.duplicates.slice(0, 5).map((item) => ({ name: item.merchant, amount: item.amount, dates: item.dates })),
    priceIncreases: insights.priceIncreases.slice(0, 5).map((item) => ({ name: item.merchant, from: item.priceChange!.from, to: item.priceChange!.to, since: item.priceChange!.date })),
    giroForecast12Months: giro ? { lowestBalance: giro.lowest.balance, lowestOn: giro.lowest.date, timesBelowBuffer: giro.lows.length,
      ...(giro.lows[0] ? { firstTightOn: giro.lows[0].date, firstTightBalance: giro.lows[0].balance, firstTightBecause: giro.lows[0].cause?.label ?? "Alltagsausgaben" } : {}) } : null,
    tradeRepublic: tr ? { balance: tr.balance, asOf: tr.date, ...(interest ? { interestRatePercent: round(interest.rate * 100) } : {}) } : null,
    healthCheck: financialCheck(state, dashboard, today).text,
    subscriptions: insights.subscriptions.slice(0, 20).map((item) => ({ name: item.merchant, monthly: item.monthlyCost })),
    memory: (state.assistantMemory ?? []).slice(0, 20).map((item) => item.text),
  };
}
export type AssistantFacts = ReturnType<typeof assistantFacts>;
