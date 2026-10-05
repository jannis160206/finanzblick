import { describe, expect, it } from "vitest";
import { actualPockets, calculateDashboard, monthsForYear, synchronizeGoals } from "@/lib/calc";
import { allocateGoals, goalBalance, initializeMotorcycleGoal, savingsGoals } from "@/lib/goals";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { appStateSchema, emptyPockets, type AppState, type Transaction } from "@/lib/types";
import { createSeed } from "@/lib/seed";
import { monthlyVariableBudget } from "@/lib/variable-budgets";

function fixture(): AppState {
  const state = createSeed();
  state.settings = { ...state.settings, asOf: "2026-10-05", bikeTarget: 8500, balances: emptyPockets() };
  state.savingsGoals = [{ id: "existing-bike", name: "Motorrad", pocket: "Motorrad", target: 8500, date: "2027-04-01" }];
  state.financeRows = [{
    id: "salary", label: "Gehalt", kind: "income",
    values: Object.fromEntries([...monthsForYear(2026), ...monthsForYear(2027)]
      .map((month) => [month, 1000 + monthlyVariableBudget(month).total])),
  }];
  return state;
}
const initialize = (state = fixture()) => initializeMotorcycleGoal(state, actualPockets(state).Motorrad);
const transfer = (amount: number, date: string): Transaction => ({
  id: `${date}-${amount}`, bank: "Revolut", pocket: "Motorrad", date, amount,
  description: "Transfer intern einzustecken", category: "Transfer intern", includeInPlan: false,
});

describe("bike-only goal migration", () => {
  it("updates the existing ID once, not the pockets, budgets, salary rows or one-offs", () => {
    const before = fixture();
    before.savingsGoals!.push({ id: "camera", name: "Kamera", pocket: "Kamera", target: 300, date: "2027-06-01" });
    before.plannedOneOffs = [{ id: "wardrobe", name: "Schrank", amount: 400, date: "2026-10-10", pocket: "Giro", installments: 1 }];
    const state = initialize(before);
    expect(state.savingsGoals).toHaveLength(2);
    expect(state.savingsGoals![0]).toEqual({
      id: "existing-bike", name: "Motorrad", pocket: "Motorrad", target: 5400, date: "2027-04-01",
      openingBalance: { date: "2026-10-05", amount: 2445 },
      funding: { monthly: 0, extras: { "2026-12": 800, "2027-01": 2576 } },
    });
    expect(state.savingsGoals![1]).toEqual(before.savingsGoals![1]);
    expect(state.settings).toEqual({ ...before.settings, bikeTarget: 5400, bikePurchaseDate: "2027-04-01" });
    expect(state.financeRows).toEqual(before.financeRows);
    expect(state.months).toEqual(before.months);
    expect(state.plannedOneOffs).toEqual(before.plannedOneOffs);
    expect(state.transactions).toEqual(before.transactions);
    expect(initialize(state)).toBe(state);
    expect(initialize({ ...state, savingsGoals: [] }).savingsGoals).toEqual([]);
    const edited = { ...state, savingsGoals: [{ ...state.savingsGoals![0], target: 5500 }] };
    expect(initialize(edited)).toBe(edited);
  });
  it("migrates the legacy goal without reviving an explicitly removed goal", () => {
    const state = fixture();
    delete state.savingsGoals;
    expect(initialize(state).savingsGoals).toMatchObject([{ id: "motorcycle", target: 5400 }]);
    expect(initialize({ ...state, savingsGoals: [] }).savingsGoals).toEqual([]);
  });
  it.each([2445, 1000, -10])("does not overwrite a nonzero motorcycle pocket (%s)", (balance) => {
    const state = fixture();
    state.pocketSnapshots = [{ bank: "Revolut", pocket: "Motorrad", date: state.settings.asOf, balance }];
    const initialized = initialize(state);
    expect(initialized.savingsGoals![0].openingBalance).toBeUndefined();
    expect(calculateDashboard(initialized).actualGoals["existing-bike"]).toBe(balance);
    expect(initialized.pocketSnapshots).toEqual(state.pocketSnapshots);
  });
  it("counts future transfers against the goal-only opening and lets later bank snapshots replace it", () => {
    const before = fixture();
    before.pocketSnapshots = [{ bank: "Revolut", pocket: "Motorrad", date: before.settings.asOf, balance: 0 }];
    let state = initialize(before);
    const goal = state.savingsGoals![0];
    expect(actualPockets(state).Motorrad).toBe(0);
    expect(goalBalance(state, goal, actualPockets(state))).toBe(2445);
    state = { ...state, settings: { ...state.settings, asOf: "2026-12-20" }, transactions: [transfer(800, "2026-12-15")] };
    expect(goalBalance(state, goal, actualPockets(state))).toBe(3245);
    state.pocketSnapshots = [{ bank: "Revolut", pocket: "Motorrad", date: "2026-12-16", balance: 3245 }];
    expect(goalBalance(state, goal, actualPockets(state))).toBe(3245);
    state.transactions.push(transfer(-100, "2026-12-18"));
    expect(goalBalance(state, goal, actualPockets(state))).toBe(3145);
    expect(calculateDashboard(state).totalAssets).toBe(3145);
  });
  it("lets a nonzero bank correction on the opening date replace the formerly empty pocket", () => {
    const state = initialize();
    state.pocketSnapshots = [{ bank: "Revolut", pocket: "Motorrad", date: "2026-10-05", balance: 3000 }];
    const d = calculateDashboard(state);
    expect(d.actualGoals["existing-bike"]).toBe(3000);
    expect(d.totalAssets).toBe(3000);
  });
  it("counts newly imported same-day movements without counting those already included in the opening", () => {
    const initial = fixture();
    initial.transactions = [transfer(100, "2026-10-05"), transfer(-100, "2026-10-05")];
    const state = initialize(initial);
    expect(calculateDashboard(state).actualGoals["existing-bike"]).toBe(2445);
    state.transactions.push(transfer(800, "2026-10-05"));
    expect(calculateDashboard(state).actualGoals["existing-bike"]).toBe(3245);
    state.settings.asOf = "2026-11-05";
    expect(calculateDashboard(state).timeline.find((row) => row.month === "2026-10")?.end.Motorrad).toBe(3245);
  });
  it("round-trips the goal, opening, earmarked extras and migration marker through Excel and JSON", async () => {
    const state = initialize();
    const json = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    const loaded = (await parseWorkbook(await exportWorkbook(json))).state;
    expect(loaded.savingsGoals).toEqual(state.savingsGoals);
    expect(loaded.bikeOnlyGoalApplied).toBe(true);
    expect(initialize(loaded)).toBe(loaded);
    expect(calculateDashboard(loaded).actualGoals["existing-bike"]).toBe(2445);
    expect(loaded.settings.balances.Motorrad).toBe(0);
  });
});

describe("earmarked motorcycle funding", () => {
  it("shows a 2955 gap, zero required monthly and exactly the two full extras", () => {
    const state = initialize();
    const d = calculateDashboard(state);
    expect(d.actualGoals["existing-bike"]).toBe(2445);
    expect(d.countdown).toMatchObject({ remaining: 2955, required: 0, onTrack: true, funded: false });
    const rows = d.timeline.filter((row) => row.month >= "2026-10" && row.month <= "2027-05");
    expect(rows.map((row) => [row.month, row.bikeTransfer])).toEqual([
      ["2026-10", 0], ["2026-11", 0], ["2026-12", 800], ["2027-01", 2576],
      ["2027-02", 0], ["2027-03", 0], ["2027-04", 0], ["2027-05", 0],
    ]);
    expect(rows[3]).toMatchObject({ goalEnd: { "existing-bike": 5821 }, end: { Motorrad: 5821 } });
    expect(d.plan).toEqual(calculateDashboard(fixture()).plan);
    expect(rows.every((row) => row.rates.Sparkonto === 180 && row.rates.Urlaub === 820)).toBe(true);
    expect(rows.every((row) => row.remaining === 1000)).toBe(true);
    expect(rows[2].income).toBe(state.financeRows[0].values["2026-12"]! + 800);
    expect(rows[2].salaryPlan).toBe(state.financeRows[0].values["2026-12"]);
    expect(rows[3].income).toBe(state.financeRows[0].values["2027-01"]! + 2576);
  });
  it("never replaces the Sparkonto floor or diverts normal salary to the bike", () => {
    const goals = savingsGoals(initialize());
    expect(allocateGoals(1000, goals, { "existing-bike": 2445 }, "2026-12"))
      .toEqual({ savings: 180, vacation: 820, goals: { "existing-bike": 800 } });
    expect(allocateGoals(1000, goals, { "existing-bike": 3245 }, "2027-01"))
      .toEqual({ savings: 180, vacation: 820, goals: { "existing-bike": 2576 } });
    expect(allocateGoals(100, goals, { "existing-bike": 2445 }, "2026-12"))
      .toEqual({ savings: 100, vacation: 0, goals: { "existing-bike": 800 } });
  });
  it("accounts for imported transfers once and keeps completion after withdrawing the purchased bike", () => {
    let state = initialize();
    state.settings.asOf = "2027-01-20";
    state.transactions = [transfer(800, "2026-12-15"), transfer(2576, "2027-01-15")];
    state = synchronizeGoals(state);
    const d = calculateDashboard(state);
    expect(d.actualGoals["existing-bike"]).toBe(5821);
    expect(d.countdown).toMatchObject({ remaining: 0, required: 0, funded: true });
    expect(d.current).toMatchObject({ end: { Motorrad: 5821 }, bikeTransfer: 2576 });
    expect(d.monthlyFunding.find((item) => item.id === "existing-bike")).toMatchObject({ amount: 2576, done: true });
    expect(state.savingsGoals![0].completedAt).toBe("2027-01-20");
    state.settings.asOf = "2027-05-05";
    state.transactions.push(transfer(-5400, "2027-04-01"));
    const after = calculateDashboard(state);
    expect(after.current).toMatchObject({ bikeTransfer: 0, rates: { Sparkonto: 180, Urlaub: 820 } });
    expect(after.monthlyFunding.some((item) => item.id === "existing-bike")).toBe(false);
    expect(state.plannedOneOffs).toBeUndefined();
  });
  it("does not pretend past planned extras are already saved when no transfer arrived", () => {
    const state = initialize();
    state.settings.asOf = "2027-02-10";
    const d = calculateDashboard(state);
    expect(d.actualGoals["existing-bike"]).toBe(2445);
    expect(d.current.bikeTransfer).toBe(0);
    expect(d.countdown.onTrack).toBe(false);
  });
  it("retains the full extra salary schedule even if an existing balance reaches the target early", () => {
    const initial = fixture();
    initial.settings.balances.Motorrad = 5000;
    let state = initialize(initial);
    state.settings.asOf = "2026-12-20";
    state.transactions = [transfer(800, "2026-12-15")];
    state = synchronizeGoals(state);
    expect(state.savingsGoals![0].completedAt).toBe("2026-12-20");
    const january = calculateDashboard(state).timeline.find((row) => row.month === "2027-01")!;
    expect(january.goalExtras).toBe(2576);
    expect(january.bikeTransfer).toBe(2576);
    expect(january.salaryPlan).toBe(initial.financeRows[0].values["2027-01"]);
  });
});
