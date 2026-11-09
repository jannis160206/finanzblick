import { addMonths, classify, financeRowValue, monthKey, round, actualBookings } from "@/lib/calc";
import { canonicalCategory } from "@/lib/categories";
import { personalAmount } from "@/lib/shared-holiday";
import { categoryParts } from "@/lib/splits";
import type { AppState, FinanceRow } from "@/lib/types";
import { monthlyVariableBudget, variableBudgetId, variableBudgetLines, type VariableBudgetId } from "@/lib/variable-budgets";

export type BudgetLineStat = { label: string; budgetId: VariableBudgetId; average: number; plan: number };
/** `title` is a short call to action, `text`/`detail` (identical) the explanation. */
export type BudgetSuggestion = {
  id: string; over: BudgetLineStat; under?: BudgetLineStat; amount: number; title: string; text: string; detail: string;
};

const MONTHS = 3;
const STEP = 5;
const roundTo5 = (value: number) => Math.round(value / STEP) * STEP;
const euro = (value: number) => `${Math.round(Math.abs(value)).toLocaleString("de-AT")} €`;

// Same line matching as variable-budgets.ts (`matches`), which is not exported.
function lineRow(state: AppState, line: (typeof variableBudgetLines)[number]): FinanceRow | undefined {
  return state.financeRows.find((row) => row.kind === "variable" &&
    (row.id === `budget-${line.id}` || (line.category !== undefined && row.planCategory !== undefined &&
      canonicalCategory(row.planCategory) === line.category) || line.pattern.test(row.label)));
}

function plannedFor(state: AppState, line: (typeof variableBudgetLines)[number], month: string, currentMonth: string): number {
  const row = lineRow(state, line);
  if (row && row.values[month] !== undefined && row.values[month] !== null)
    return financeRowValue(row, month, { currentMonth }, state.holidayRanges);
  return monthlyVariableBudget(month, state.holidayRanges, month >= currentMonth ? state.budgetAdjustments : undefined).rows.find((item) => item.id === line.id)?.total ?? 0;
}

/**
 * Spending per variable budget line for one past month, with the dashboard's rules:
 * income/transfers (incl. ignored bookings) are outside, receipt splits are spread,
 * shared bookings count with the personal share.
 */
function lineSpending(bookings: ReturnType<typeof actualBookings>, month: string, asOf: string) {
  const spent = new Map<VariableBudgetId, number>();
  let any = false;
  for (const row of bookings) {
    if (monthKey(row.date) !== month || row.date > asOf) continue;
    any = true;
    const result = classify(row);
    if (result.isTransfer || ["Einkommen", "Gehalt", "Rufbereitschaft"].includes(result.category) || !result.includeInPlan) continue;
    for (const part of categoryParts(row, result.category)) {
      const id = variableBudgetId(part.category, row.fixedCost);
      if (id) spent.set(id, (spent.get(id) ?? 0) - personalAmount(row) * part.share);
    }
  }
  return { spent, any };
}

/**
 * Looks at the last three full months before `asOf`. A variable line over plan in all
 * three months is paired with a line under plan in all three months; the suggestion moves
 * min(Ø overrun, Ø headroom) rounded to 5 €. Without a donor line it suggests raising the plan.
 */
export function budgetSuggestions(state: AppState, asOf: string): BudgetSuggestion[] {
  const currentMonth = monthKey(asOf);
  const months = Array.from({ length: MONTHS }, (_, index) => addMonths(currentMonth, -(index + 1)));
  const bookings = actualBookings(state);
  const spending = months.map((month) => lineSpending(bookings, month, asOf));
  if (spending.some((month) => !month.any)) return [];
  const stats = variableBudgetLines.map((line) => {
    const plans = months.map((month) => plannedFor(state, line, month, currentMonth));
    const actuals = spending.map((month) => round(month.spent.get(line.id) ?? 0));
    const deltas = actuals.map((actual, index) => round(actual - plans[index]));
    return {
      label: line.label, budgetId: line.id,
      average: round(actuals.reduce((total, value) => total + value, 0) / MONTHS),
      plan: round(plans.reduce((total, value) => total + value, 0) / MONTHS),
      delta: round(deltas.reduce((total, value) => total + value, 0) / MONTHS),
      over: deltas.every((delta) => delta > 0),
      under: deltas.every((delta) => delta < 0),
    };
  });
  const strip = ({ label, budgetId, average, plan }: (typeof stats)[number]): BudgetLineStat => ({ label, budgetId, average, plan });
  const donors = stats.filter((line) => line.under).map((line) => ({ line, headroom: -line.delta }));
  const suggestions: Omit<BudgetSuggestion, "detail">[] = [];
  // Once the current plan already covers the usual spending (e.g. after "Plan um 295 € erhöhen"), the hint is done.
  const nowPlan = monthlyVariableBudget(currentMonth, state.holidayRanges, state.budgetAdjustments).rows;
  const covered = (id: VariableBudgetId, average: number) => (nowPlan.find((row) => row.id === id)?.total ?? 0) >= average - STEP;
  for (const over of stats.filter((line) => line.over && !covered(line.budgetId, line.average)).sort((a, b) => b.delta - a.delta)) {
    const donor = donors.filter((item) => roundTo5(Math.min(over.delta, item.headroom)) >= STEP)
      .sort((a, b) => b.headroom - a.headroom)[0];
    const head = `${over.label} lag ${MONTHS} Monate über Plan (Ø +${euro(over.delta)})`;
    if (donor) {
      const amount = roundTo5(Math.min(over.delta, donor.headroom));
      donor.headroom = round(donor.headroom - amount);
      suggestions.push({
        id: `budget-move-${over.budgetId}-${donor.line.budgetId}`, over: strip(over), under: strip(donor.line), amount,
        title: `${euro(amount)} von ${donor.line.label} zu ${over.label} umschichten`,
        text: `${head}, ${donor.line.label} darunter (Ø −${euro(-donor.line.delta)}) → ${euro(amount)} umschichten?`,
      });
    } else {
      const amount = Math.max(STEP, roundTo5(over.delta));
      suggestions.push({
        id: `budget-raise-${over.budgetId}`, over: strip(over), amount,
        title: `Plan für ${over.label} um ${euro(amount)} erhöhen`,
        text: `${head} → Plan um ${euro(amount)} erhöhen?`,
      });
    }
  }
  return suggestions.map((suggestion) => ({ ...suggestion, detail: suggestion.text }));
}
