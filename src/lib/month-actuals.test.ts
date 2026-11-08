import { describe, expect, it } from "vitest";
import { budgetSpendingByMonth, calculateDashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { deviates, fixedCellState } from "@/components/month-plan-grid";
import { monthPlanActuals } from "./month-actuals";
import { planningEndMonth, planningEndYear, planningMonths } from "./planning-range";
import type { AppState, FinanceRow, Transaction } from "./types";

const booking = (id: string, date: string, patch: Partial<Transaction> = {}): Transaction => ({
  id, date, bank: "Raiffeisen", pocket: "Giro", description: "A1 Mobilfunk",
  amount: -20, category: "Telefon & Internet", categoryOverride: true, reviewed: true,
  includeInPlan: false, ...patch,
});
const phone: FinanceRow = {
  id: "phone", label: "Handyvertrag A1", kind: "fixed", planCategory: "Telefon & Internet",
  values: { "2026-08": 20, "2026-09": 20, "2026-10": 20 },
};
function fixture(transactions: Transaction[], financeRows: FinanceRow[] = [phone]): AppState {
  const seed = createSeed();
  return { ...seed, settings: { ...seed.settings, asOf: "2026-10-06" },
    transactions, financeRows, fixedReceipts: [], holidayRanges: [],
    savingsGoals: [], plannedOneOffs: [], plannedOneOffsSeeded: true };
}

describe("planning range", () => {
  it("rolls forward so the plan always covers the following year", () => {
    expect(planningEndYear("2026-10-06")).toBe(2027);
    expect(planningEndYear("2027-03")).toBe(2028);
    expect(planningMonths("2026-10")).toHaveLength(24);
    expect(planningMonths("2027-01-15").at(-1)).toBe("2028-12");
    expect(planningEndMonth("2026-05-01")).toBe("2027-12");
  });
});

describe("month plan actuals", () => {
  it("assigns real fixed-cost bookings to their plan row and month, with the booking list", () => {
    const state = fixture([booking("aug", "2026-08-15"), booking("sep", "2026-09-15", { amount: -73 }), booking("oct", "2026-10-02")]);
    const actuals = monthPlanActuals(state);
    expect(actuals.currentMonth).toBe("2026-10");
    expect(actuals.rows.phone["2026-08"]).toMatchObject({ amount: 20, bookings: [{ id: "aug", date: "2026-08-15", amount: 20 }] });
    expect(actuals.rows.phone["2026-09"].amount).toBe(73);
    expect(actuals.status.phone).toMatchObject({ status: "booked", bookedAmount: 20 });
    expect(actuals.duplicates).toEqual({});
  });

  it("flags plan rows that are booked twice in the fixed costs", () => {
    const twin: FinanceRow = { ...phone, id: "phone-2" };
    const actuals = monthPlanActuals(fixture([booking("oct", "2026-10-02")], [phone, twin]));
    expect(Object.keys(actuals.duplicates).length).toBeGreaterThan(0);
  });

  it("tracks fixed spending and month coverage in the timeline", () => {
    const state = fixture([booking("sep", "2026-09-15"), booking("oct", "2026-10-02"),
      booking("food", "2026-10-03", { description: "Billa", category: "Lebensmittel", amount: -50, includeInPlan: true })]);
    const timeline = calculateDashboard(state).timeline;
    const september = timeline.find((row) => row.month === "2026-09")!;
    const october = timeline.find((row) => row.month === "2026-10")!;
    expect(september.actualCoverage).toBe("spending");
    expect(october.actualCoverage).toBe("full");
    expect(october.fixedSpending).toBe(20);
    expect(october.actualSpending).toBe(70);
    expect(budgetSpendingByMonth(state.transactions, "2026-10-06").get("2026-10")?.get("food")).toBe(50);
  });
});

describe("fixed cell state", () => {
  const actual = (amount: number) => ({ amount, bookings: [] });
  it("tolerates small price differences", () => {
    expect(deviates(20, 20.5)).toBe(false);
    expect(deviates(20, 22)).toBe(true);
    expect(deviates(1000, 1015)).toBe(false);
  });
  it("classifies past, current and future months", () => {
    expect(fixedCellState(20, actual(20), "2026-09", "2026-10")).toBe("booked");
    expect(fixedCellState(20, actual(73), "2026-09", "2026-10")).toBe("different");
    expect(fixedCellState(20, undefined, "2026-09", "2026-10")).toBe("missing");
    expect(fixedCellState(0, undefined, "2026-09", "2026-10")).toBeUndefined();
    expect(fixedCellState(20, undefined, "2026-11", "2026-10")).toBeUndefined();
    expect(fixedCellState(20, undefined, "2026-10", "2026-10")).toBeUndefined();
  });
});
