import { actualBookings, budgetSpendingByMonth, merchantName, monthKey, round } from "@/lib/calc";
import { accountLabel } from "@/lib/accounts";
import { fixedBookingHistory, fixedCostSchedule, type FixedCostScheduleItem } from "@/lib/fixed-cost-schedule";
import { detectDuplicateFixedCosts, type DuplicateFixedCost } from "@/lib/insights";
import { personalAmount } from "@/lib/shared-holiday";
import type { AppState } from "@/lib/types";
import { variableBudgetLineId, type VariableBudgetId } from "@/lib/variable-budgets";

export type PlanBooking = { id: string; date: string; name: string; amount: number; account?: string };
export type RowMonthActual = { amount: number; bookings: PlanBooking[] };
export type MonthPlanActuals = {
  currentMonth: string;
  /** Booked amounts per plan row and month, positive for spending. */
  rows: Record<string, Record<string, RowMonthActual>>;
  /** Budget line behind each variable row, for the ledger drilldown. */
  budgets: Record<string, VariableBudgetId>;
  /** Current-month status of each fixed row. */
  status: Record<string, FixedCostScheduleItem>;
  /** Fixed rows that look like a second copy of the same contract this month. */
  duplicates: Record<string, DuplicateFixedCost>;
};

export function monthPlanActuals(state: AppState): MonthPlanActuals {
  const currentMonth = monthKey(state.settings.asOf);
  const bookings = actualBookings(state);
  const history = fixedBookingHistory(state, bookings);
  const rows: MonthPlanActuals["rows"] = {};
  for (const [rowId, rowBookings] of history) {
    const months: Record<string, RowMonthActual> = {};
    for (const booking of [...rowBookings].sort((a, b) => a.date.localeCompare(b.date))) {
      const month = monthKey(booking.date);
      const entry = months[month] ?? { amount: 0, bookings: [] };
      entry.amount = round(entry.amount - personalAmount(booking));
      entry.bookings.push({
        id: booking.id, date: booking.date, amount: round(-personalAmount(booking)),
        name: merchantName(booking.description, booking.merchantAlias),
        ...(booking.bank !== "Auszugsbeleg" ? { account: accountLabel(booking) } : {}),
      });
      months[month] = entry;
    }
    rows[rowId] = months;
  }
  const budgets: MonthPlanActuals["budgets"] = {};
  const spending = budgetSpendingByMonth(bookings, state.settings.asOf);
  for (const row of state.financeRows) {
    if (row.kind !== "variable") continue;
    const budget = variableBudgetLineId(row);
    if (!budget) continue;
    budgets[row.id] = budget;
    rows[row.id] = Object.fromEntries([...spending].map(([month, lines]) =>
      [month, { amount: round(lines.get(budget) ?? 0), bookings: [] }]));
  }
  const schedule = fixedCostSchedule(state, history);
  const status = Object.fromEntries([...schedule.booked, ...schedule.open].map((item) => [item.id, item]));
  const duplicates: MonthPlanActuals["duplicates"] = {};
  for (const duplicate of detectDuplicateFixedCosts(state, currentMonth))
    for (const id of duplicate.ids) duplicates[id] = duplicate;
  return { currentMonth, rows, budgets, status, duplicates };
}
