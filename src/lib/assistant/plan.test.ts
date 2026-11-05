import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard, monthsForYear } from "@/lib/calc";
import { plannedOneOffSchema, savingsGoalSchema } from "@/lib/types";
import { monthlyVariableBudget } from "@/lib/variable-budgets";
import { buildPlannedOneOff, buildSavingsGoal, checkAffordability, goalExtraOperation, planSavingsGoal } from "./plan";

function fixture(surplus = 1081.4) {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-09-11";
  state.financeRows = [{ id: "salary", label: "Gehalt", kind: "income", values:
    Object.fromEntries([...monthsForYear(2026), ...monthsForYear(2027)].map((month) =>
      [month, monthlyVariableBudget(month).total + surplus])) }];
  return state;
}

describe("assistant savings goal plan", () => {
  it("computes the monthly rate from target, start capital and date", () => {
    const state = fixture();
    const plan = planSavingsGoal(state, calculateDashboard(state),
      { action: "savings_goal", name: "Japan", amount: 3000, date: "2027-07-31", startCapital: 500, fromAccount: "Sparkonto" });
    expect(plan).toMatchObject({ ok: true, months: 10, monthly: 250, conflicts: [] });
  });

  it("computes the reachable date from a monthly amount", () => {
    const state = fixture();
    const plan = planSavingsGoal(state, calculateDashboard(state), { action: "savings_goal", name: "Auto", amount: 2400, monthly: 200 });
    expect(plan).toMatchObject({ ok: true, months: 12, monthly: 200, date: "2027-09-30" });
  });

  it("rejects duplicate names and covered targets", () => {
    const state = fixture();
    state.savingsGoals = [savingsGoalSchema.parse({ id: "car", name: "Auto", pocket: "Auto", target: 5000, date: "2027-12-31" })];
    const dashboard = calculateDashboard(state);
    expect(planSavingsGoal(state, dashboard, { action: "savings_goal", name: "auto", amount: 900, monthly: 100 }).error).toContain("gibt es schon");
    expect(planSavingsGoal(state, dashboard, { action: "savings_goal", name: "Rad", amount: 300, startCapital: 300, monthly: 10 }).error).toContain("deckt");
  });

  it("warns when a new goal takes money from an existing goal", () => {
    const state = fixture(600);
    state.savingsGoals = [savingsGoalSchema.parse({ id: "car", name: "Auto", pocket: "Auto", target: 4000, date: "2027-03-31",
      openingBalance: { date: "2026-10-07", amount: 0 }, funding: { monthly: 400, extras: {} } })];
    const dashboard = calculateDashboard(state);
    const plan = planSavingsGoal(state, dashboard, { action: "savings_goal", name: "Japan", amount: 3000, date: "2027-01-31" });
    expect(plan.ok).toBe(true);
    expect(plan.conflicts.map((item) => item.name)).toEqual(["Auto"]);
  });

  it("lowers the monthly rate by extra start amounts", () => {
    const state = fixture();
    const plan = planSavingsGoal(state, calculateDashboard(state),
      { action: "savings_goal", name: "Japan", amount: 3000, date: "2027-07-31", startCapital: 500, fromAccount: "Sparkonto", extra: { amount: 60, months: 2, from: "Sparkonto" } });
    expect(plan).toMatchObject({ ok: true, months: 10, monthly: 238, extra: { amount: 60, months: 2, total: 120, from: "Sparkonto" } });
    const goal = buildSavingsGoal(state, { action: "savings_goal", name: "Japan", amount: 3000, date: "2027-07-31", extra: { amount: 60, months: 2 } }, 238, "japan");
    expect(goal.funding?.extras).toEqual({});
    const operation = goalExtraOperation(goal, { action: "savings_goal", name: "Japan", amount: 3000, extra: { amount: 60, months: 2, from: "Sparkonto" } }, "2026-11");
    expect(operation).toEqual({ op: "goal_extras", goalId: "japan", start: "2026-11", months: 2, amount: 60, from: "Sparkonto" });
  });

  it("builds valid goals and planned expenses", () => {
    const state = fixture();
    const goal = buildSavingsGoal(state, { action: "savings_goal", name: "Japan", amount: 3000, date: "2027-07-31", startCapital: 500 }, 250, "japan");
    expect(goal).toMatchObject({ pocket: "Japan", openingBalance: { date: "2026-10-07", amount: 500 }, funding: { monthly: 250, extras: {} } });
    const laptop = buildPlannedOneOff({ action: "expense", name: "Laptop", amount: 1000, installments: 3, date: "2027-01-01" }, "laptop");
    expect(plannedOneOffSchema.parse(laptop)).toMatchObject({ amount: 333.33, installments: 3, total: 1000, pocket: "Giro" });
  });
});

describe("assistant affordability", () => {
  it("is green when the month has room", () => {
    const state = fixture();
    const result = checkAffordability(state, calculateDashboard(state), { action: "affordability", amount: 400, date: "2027-03-01" });
    expect(result.light).toBe("green");
    expect(result.tightest?.after).toBeGreaterThanOrEqual(0);
  });

  it("is yellow when pausing a goal rate covers it", () => {
    const state = fixture(800);
    state.savingsGoals = [savingsGoalSchema.parse({ id: "car", name: "Auto", pocket: "Auto", target: 6000, date: "2027-12-31",
      openingBalance: { date: "2026-10-07", amount: 0 }, funding: { monthly: 400, extras: {} } })];
    const dashboard = calculateDashboard(state);
    const result = checkAffordability(state, dashboard, { action: "affordability", amount: 500, date: "2027-03-01" });
    expect(result.light).toBe("yellow");
    expect(result.pause[0]).toMatchObject({ name: "Auto", month: "2027-03" });
  });

  it("is red with alternatives when the money is missing", () => {
    const state = fixture(500);
    const result = checkAffordability(state, calculateDashboard(state), { action: "affordability", amount: 1200, date: "2027-03-01" });
    expect(result.light).toBe("red");
    expect(result.shortfall).toBeGreaterThan(0);
    expect(result.alternatives.find((item) => item.kind === "installments")).toMatchObject({ installments: 4 });
  });

  it("refuses months beyond the plan", () => {
    const state = fixture();
    expect(checkAffordability(state, calculateDashboard(state), { action: "affordability", amount: 100, date: "2029-01-01" }).error).toContain("reicht nur bis");
  });
});
