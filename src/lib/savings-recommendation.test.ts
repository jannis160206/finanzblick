import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "./account-state";
import { calculateDashboard, monthsForYear } from "./calc";
import { initializeMotorcycleGoal } from "./goals";
import { plannedOneOffSchema } from "./types";
import { monthlyVariableBudget } from "./variable-budgets";

function fixture(surplus = 1081.4, month = "2026-10") {
  const state = createEmptyAccountState();
  state.settings.asOf = `${month}-07`;
  state.settings.baselineDate = "2026-09-11";
  state.financeRows = [{ id: "salary", label: "Gehalt", kind: "income", values:
    Object.fromEntries([...monthsForYear(2026), ...monthsForYear(2027)].map((month) =>
      [month, monthlyVariableBudget(month).total + surplus])) }];
  return state;
}
const licence = (pocket: "Giro" | "Sparkonto" = "Sparkonto") =>
  plannedOneOffSchema.parse({ id: "licence", name: "Führerschein", date: "2026-10-20", amount: 780, pocket });

describe("savings recommendation from real surplus", () => {
  it.each(["Giro", "Sparkonto"] as const)("sends the entire positive October surplus after the %s purchase to savings", (pocket) => {
    const state = fixture();
    const original = calculateDashboard(state);
    state.plannedOneOffs = [licence(pocket)];
    const snapshot = JSON.stringify(state);
    const dashboard = calculateDashboard(state);
    expect(dashboard.current.surplus).toBe(301.4);
    expect(dashboard.monthlyFunding).toEqual([
      { id: "savings", name: "Sparkonto", pocket: "Sparkonto", amount: 301.4, transferred: 0, done: false },
    ]);
    expect(dashboard.current).toMatchObject({ rates: { Sparkonto: 301.4, Urlaub: 0 } });
    expect(dashboard.plan).toEqual(original.plan);
    expect(dashboard.actual).toEqual(original.actual);
    expect(dashboard.timeline.map((row) => row.goalRates)).toEqual(original.timeline.map((row) => row.goalRates));
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it.each([0, 0.01, -478.6])("never recommends more than the actual %s surplus", (surplus) => {
    const state = fixture(780 + surplus);
    state.plannedOneOffs = [licence()];
    const dashboard = calculateDashboard(state);
    expect(dashboard.current.surplus).toBe(surplus);
    expect(dashboard.current).toMatchObject({ rates: { Sparkonto: Math.max(0, surplus), Urlaub: 0 } });
    expect(dashboard.monthlyFunding.find((row) => row.id === "savings")?.amount ?? 0).toBe(Math.max(0, surplus));
  });

  it("deducts personal halves and only this month's installment, not future purchases", () => {
    const state = fixture(1000);
    state.plannedOneOffs = [
      plannedOneOffSchema.parse({ id: "cabinet", name: "Schrank", date: "2026-10-10", amount: 400, sharedWithRaphael: true }),
      plannedOneOffSchema.parse({ id: "monitor", name: "Monitor", date: "2026-10-06", amount: 55, installments: 12, total: 664 }),
      plannedOneOffSchema.parse({ id: "office", name: "Büro", date: "2026-11-01", amount: 191.48 }),
    ];
    const dashboard = calculateDashboard(state);
    expect(dashboard.current).toMatchObject({ surplus: 745, plannedOneOffs: 255, rates: { Sparkonto: 745 } });
    expect(dashboard.timeline.find((row) => row.month === "2026-11")).toMatchObject({
      surplus: 753.52, rates: { Sparkonto: 753.52, Urlaub: 0 },
    });
  });

  it.each([["2026-12", 800], ["2027-01", 2576]] as const)("does not recommend the reserved motorcycle extra twice in %s", (month, extra) => {
    const before = fixture(1000, month);
    before.savingsGoals = [{ id: "bike", name: "Motorrad", pocket: "Motorrad", target: 5400, date: "2027-04-01" }];
    before.bikeOnlyGoalApplied = false;
    const state = initializeMotorcycleGoal(before, 0);
    const original = calculateDashboard(state);
    state.plannedOneOffs = [{ ...licence(), date: `${month}-20` }];
    const dashboard = calculateDashboard(state);
    expect(dashboard.current.surplus).toBe(220 + extra);
    expect(dashboard.current).toMatchObject({ rates: { Sparkonto: 220, Motorrad: extra, Urlaub: 0 } });
    expect(dashboard.timeline.map((row) => row.goalRates)).toEqual(original.timeline.map((row) => row.goalRates));
  });

  it("retains other goal instructions without recommending unavailable money", () => {
    const state = fixture(1000);
    state.savingsGoals = [{ id: "camera", name: "Kamera", pocket: "Kamera", target: 10000, date: "2027-04-01" }];
    const original = calculateDashboard(state);
    state.plannedOneOffs = [licence()];
    const dashboard = calculateDashboard(state);
    expect(dashboard.timeline.map((row) => row.goalRates)).toEqual(original.timeline.map((row) => row.goalRates));
    expect(dashboard.current.surplus).toBe(220);
    expect(dashboard.current).toMatchObject({ rates: { Sparkonto: 0, Urlaub: 0 } });
  });

  it("keeps the normal savings floor and vacation split outside the pause, limited to real surplus", () => {
    const state = fixture(1000, "2027-03");
    state.plannedOneOffs = [{ ...licence(), date: "2027-03-20" }];
    expect(calculateDashboard(state).current).toMatchObject({
      surplus: 220, rates: { Sparkonto: 180, Urlaub: 40 },
    });
    state.financeRows[0].values["2027-03"] = monthlyVariableBudget("2027-03").total + 880;
    expect(calculateDashboard(state).current).toMatchObject({
      surplus: 100, rates: { Sparkonto: 100, Urlaub: 0 },
    });
  });
});
