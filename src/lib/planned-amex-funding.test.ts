import { describe, expect, it } from "vitest";
import { calculateDashboard, calculateMonthTotals } from "@/lib/calc";
import { commitStatementImport } from "@/lib/import/review";
import { monthlyVariableBudget } from "@/lib/variable-budgets";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";

const purchase = (shared: boolean, date = "2026-10-10"): Transaction => ({
  id: "purchase", date, amount: -400, description: "Furniture shop", bank: "Amex", pocket: "Amex",
  category: "Shopping", categoryOverride: true, includeInPlan: false, sharedWithRaphael: shared,
});
function fixture(shared: boolean, transactions: Transaction[] = [], reserved = 0): AppState {
  const seed = createSeed();
  return { ...seed, settings: { ...seed.settings, asOf: "2026-10-25" }, transactions,
    financeRows: [{ id: "salary", kind: "income", label: "Gehalt", values: { "2026-10": 3000, "2026-11": 3000 } }],
    savingsGoals: [], fixedReceipts: [], plannedOneOffsSeeded: true,
    plannedOneOffs: [{ id: "plan", name: "Furniture", date: "2026-10-10", amount: 400, pocket: "Giro", installments: 1, sharedWithRaphael: shared }],
    accountSnapshots: [{ bank: "Revolut", name: "Amex", balance: reserved, date: "2026-10-01" }] };
}

describe("planned Amex purchase versus settlement funding", () => {
  it.each([false, true])("counts a planned own purchase once before and after booking (shared=%s)", (shared) => {
    const state = fixture(shared);
    const before = calculateDashboard(state);
    const booked = calculateDashboard({ ...state, transactions: [purchase(shared)] });
    const own = shared ? 200 : 400;
    expect(booked.current.surplus).toBe(before.current.surplus);
    expect(booked.current.plannedOneOffs).toBe(own);
    expect(booked.current.actualSpending).toBe(own);
    expect(booked.amex).toMatchObject({ outstanding: 400, ownOutstanding: own, plannedCoverage: own, additional: 0 });
    expect(booked.ninetyDays.map((row) => row.surplus)).toEqual(before.ninetyDays.map((row) => row.surplus));
    expect(booked.plan).toEqual(before.plan);
  });

  it.each([false, true])("keeps purchase cost unchanged through partial/full card settlement (shared=%s)", (shared) => {
    const own = shared ? 200 : 400;
    for (const amount of [100, 400]) {
      const state = fixture(shared, [purchase(shared), { ...purchase(false), id: "settlement", amount: -amount,
        bank: "Raiffeisen", pocket: "Giro", description: "Amex Abrechnung", category: "Transfer intern", date: "2026-10-11" }]);
      const dashboard = calculateDashboard(state);
      expect(dashboard.current.surplus).toBe(3000 - monthlyVariableBudget("2026-10").total - own);
      expect(dashboard.amex).toMatchObject({ outstanding: 400 - amount, ownOutstanding: (400 - amount) * (shared ? 0.5 : 1), additional: 0 });
      expect(dashboard.current.actualSpending).toBe(own);
    }
  });

  it.each([0, 100, 500])("does not use reserve money twice or hide the real liability (reserve=%s)", (reserved) => {
    const dashboard = calculateDashboard(fixture(true, [purchase(true)], reserved));
    expect(dashboard.current.surplus).toBe(3000 - monthlyVariableBudget("2026-10").total - 200);
    expect(dashboard.amex).toMatchObject({ outstanding: 400, ownOutstanding: 200, reserved, additional: 0 });
    expect(dashboard.amex.plannedCoverage).toBe(Math.max(0, 200 - reserved));
  });

  it("projects unplanned purchases as current funding needs without inventing a plan", () => {
    const state = { ...fixture(true, [purchase(true)]), plannedOneOffs: [] };
    const dashboard = calculateDashboard(state);
    expect(dashboard.current.plannedOneOffs).toBe(0);
    expect(dashboard.current.amexOpen).toBe(200);
    expect(dashboard.current.actualSpending).toBe(200);
    expect(dashboard.current.surplus).toBe(3000 - monthlyVariableBudget("2026-10").total - 200);
    expect(dashboard.ninetyDays[1].amexOpen).toBe(0);
  });

  it("keeps historical spending and a rollover funding need distinct", () => {
    const state = fixture(true, [purchase(true, "2026-09-30")]);
    state.plannedOneOffs![0].date = "2026-09-30";
    const dashboard = calculateDashboard(state);
    const september = dashboard.timeline.find((row) => row.month === "2026-09")!;
    expect(september.actualSpending).toBe(200);
    expect(september.plannedOneOffs).toBe(200);
    expect(dashboard.current.actualSpending).toBe(0);
    expect(dashboard.current.plannedOneOffs).toBe(0);
    expect(dashboard.current.amexOpen).toBe(200);
    expect(dashboard.amex.outstanding).toBe(400);
    expect(dashboard.ninetyDays[1].amexOpen).toBe(0);
  });

  it("counts a reimport once and agrees across totals, timeline and three-month projection", () => {
    let state = fixture(true);
    state = commitStatementImport(state, [purchase(true)]).state;
    state = commitStatementImport(state, [purchase(true)]).state;
    expect(state.transactions).toHaveLength(1);
    const dashboard = calculateDashboard(state);
    expect(calculateMonthTotals(state, "2026-10", dashboard.plan).surplus).toBe(dashboard.current.surplus);
    expect(dashboard.timeline.find((row) => row.month === "2026-10")!.surplus).toBe(dashboard.current.surplus);
    expect(dashboard.ninetyDays[0].surplus).toBe(dashboard.current.surplus);
  });

  it("uses actual cents rather than the tolerance-matched plan amount", () => {
    const row = { ...purchase(true), amount: -398.01 };
    const dashboard = calculateDashboard(fixture(true, [row]));
    expect(dashboard.current.plannedOneOffs).toBe(199.01);
    expect(dashboard.current.actualSpending).toBe(199.01);
    expect(dashboard.amex).toMatchObject({ ownOutstanding: 199.01, additional: 0 });
  });

  it("reverses a refunded planned purchase without a second credit or a fake debt", () => {
    const row = purchase(true);
    const state = fixture(true, [row, { ...row, id: "refund", amount: 400, date: "2026-10-11", sharedWithRaphael: false }]);
    const dashboard = calculateDashboard(state);
    expect(dashboard.current).toMatchObject({ plannedOneOffs: 0, actualSpending: 0, amexOpen: 0 });
    expect(dashboard.amex).toMatchObject({ outstanding: 0, ownOutstanding: 0, plannedCoverage: 0 });
    expect(dashboard.current.surplus).toBe(3000 - monthlyVariableBudget("2026-10").total);
  });
});
