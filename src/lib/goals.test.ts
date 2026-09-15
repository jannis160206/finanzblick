import { describe, expect, it } from "vitest";
import { allocateGoals, goalBalance, savingsGoals, transferMatches } from "./goals";
import { actualPockets, calculateDashboard, monthlyInterest, monthsForYear, synchronizeGoals } from "./calc";
import { createSeed } from "./seed";
import { emptyPockets, type SavingsGoal, type Transaction } from "./types";
import { exportWorkbook, parseWorkbook } from "./excel";
import { monthlyVariableBudget } from "./variable-budgets";

const goal = (id: string, target = 8500, date = "2027-03-01"): SavingsGoal => ({ id, name: id, pocket: id, target, date });
function stateFor(surplus = 1000) {
  const state = createSeed();
  state.settings = { ...state.settings, baselineDate: "2026-09-01", asOf: "2026-09-14", balances: emptyPockets() };
  state.financeRows = [{ id: "income", label: "Gehalt", kind: "income", values: Object.fromEntries([...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [month, surplus + monthlyVariableBudget(month).total])) }];
  state.transactions = [];
  state.months = {};
  state.savingsGoals = [goal("Motorrad")];
  return state;
}
const transfer = (pocket: string, amount: number, date = "2026-09-14"): Transaction => ({
  id: `${pocket}-${amount}-${date}`, pocket, amount, date, bank: "Revolut", description: "Transfer intern einzustecken",
  category: "Transfer intern", includeInPlan: false,
});

describe("automatic savings floor and goals", () => {
  it.each([-100, 0, 0.01, 175, 180, 200, 1000, 10000])("always protects Sparkonto for surplus %s", (surplus) => {
    const split = allocateGoals(surplus, [goal("Motorrad")], {}, "2026-09");
    expect(split.savings).toBe(Math.min(180, Math.max(0, surplus)));
    expect(split.savings + split.goals.Motorrad + split.vacation).toBeCloseTo(Math.max(0, surplus), 2);
    if (surplus <= 180) expect(split.goals.Motorrad).toBe(0);
  });
  it("fills in deadline order, caps targets and sends the remainder to Urlaub", () => {
    const goals = [goal("Later", 500, "2027-05-01"), goal("Sooner", 300, "2026-10-01")];
    expect(allocateGoals(1000, goals, { Later: 100 }, "2026-09")).toEqual({ savings: 180, goals: { Sooner: 300, Later: 400 }, vacation: 120 });
    expect(allocateGoals(400, goals, {}, "2026-09")).toEqual({ savings: 180, goals: { Sooner: 220, Later: 0 }, vacation: 0 });
  });
  it("does not revive a removed legacy goal or require an open goal", () => {
    const state = stateFor(); delete state.savingsGoals;
    expect(savingsGoals(state)[0]).toMatchObject({ name: "Motorrad", target: state.settings.bikeTarget });
    state.savingsGoals = [];
    expect(calculateDashboard(state).monthlyFunding).toEqual([
      { id: "savings", name: "Sparkonto", pocket: "Sparkonto", amount: 180, done: false },
      { id: "vacation", name: "Urlaub", pocket: "Urlaub", amount: 820, done: false },
    ]);
  });
  it("ignores old percentage, bike and pocket allocation overrides when protecting the floor", () => {
    const state = stateFor(150);
    state.settings.bikeShare = 1;
    state.months["2026-09"] = { variableOverride: null, bikeOverride: 150, pocketIn: { ...emptyPockets(), Motorrad: 150 }, pocketOut: emptyPockets() };
    expect(calculateDashboard(state).current).toMatchObject({ rates: { Sparkonto: 150, Motorrad: 0 } });
  });
  it("deducts fixed costs and Alltagsbudget before any goal", () => {
    const state = stateFor(2000);
    state.financeRows[0].values["2026-09"] = 2000;
    state.financeRows.push({ id: "fixed", label: "Leasing", kind: "fixed", values: { "2026-09": 600 } });
    state.months["2026-09"] = { variableOverride: 500, bikeOverride: null, pocketIn: emptyPockets(), pocketOut: emptyPockets() };
    expect(calculateDashboard(state).current).toMatchObject({ surplus: 483, rates: { Sparkonto: 180, Motorrad: 0, Urlaub: 303 } });
  });
  it("uses imported balances for additional goal pockets and never funds a reached goal again", () => {
    let state = stateFor(); state.savingsGoals = [goal("Kamera", 820, "2026-09-30")];
    state.accountSnapshots = [{ bank: "Revolut", name: "Kamera", date: "2026-09-14", balance: 820 }];
    state.transactions = [transfer("Kamera", 820)];
    state = synchronizeGoals(state);
    expect(goalBalance(state, state.savingsGoals![0], actualPockets(state))).toBe(820);
    const dashboard = calculateDashboard(state);
    expect(dashboard.monthlyFunding.find((item) => item.name === "Kamera")).toMatchObject({ amount: 820, done: true });
    expect(dashboard.timeline.find((row) => row.month === "2026-10")?.goalRates.Kamera).toBe(0);
    state.settings.asOf = "2026-10-15";
    state.transactions.push(transfer("Kamera", -820, "2026-10-01"));
    expect(calculateDashboard(state).monthlyFunding.map((item) => item.name)).toEqual(["Sparkonto", "Urlaub"]);
  });
  it("does not double-count an executed rate in the forecast", () => {
    const state = stateFor();
    state.settings.asOf = "2026-10-14";
    state.transactions = [transfer("Sparen", 180, "2026-10-14"), transfer("Motorrad", 820, "2026-10-14")];
    const d = calculateDashboard(state);
    expect(d.monthlyFunding.every((item) => item.done)).toBe(true);
    expect(d.current).toMatchObject({ end: { Sparkonto: 180, Motorrad: 820 } });
  });
  it.each([["2026-09", 0], ["2026-10", 820], ["2027-04", 820], ["2027-05", 0]] as const)("limits motorcycle funding in %s without changing the floor", (month, amount) => {
    const bike = goal("Motorrad", 100000, "2027-04-01");
    expect(allocateGoals(1000, [bike], {}, month)).toEqual({ savings: 180, goals: { Motorrad: amount }, vacation: 820 - amount });
  });
  it("uses the saved goal deadline and shows only positive funding instructions", () => {
    const state = stateFor();
    state.savingsGoals = [goal("Motorrad", 100000, "2027-04-01")];
    state.settings.bikeShare = 1;
    state.settings.afterBikeSavingsShare = 1;
    const before = calculateDashboard(state);
    expect(before.monthlyFunding.map((row) => row.pocket)).toEqual(["Sparkonto", "Urlaub"]);
    expect(before.timeline.find((row) => row.month === "2026-10")?.bikeTransfer).toBe(820);
    state.settings.asOf = "2027-05-15";
    expect(calculateDashboard(state).current).toMatchObject({ rates: { Sparkonto: 180, Motorrad: 0, Urlaub: 820 } });
    expect(calculateDashboard(state).monthlyFunding.map((row) => row.pocket)).toEqual(["Sparkonto", "Urlaub"]);
    state.savingsGoals[0].date = "2027-06-01";
    expect(calculateDashboard(state).current).toMatchObject({ rates: { Motorrad: 820 } });
  });
  it("hardcodes tax even when an old backup has a different tax field", () => {
    const settings = { ...createSeed().settings, interestStart: "2026-01-01", interestRates: [{ date: "2026-01-01", rate: 0.024 }] };
    expect(monthlyInterest(10000, "2026-09", { ...settings, taxRate: 0 })).toBe(14.5);
    expect(monthlyInterest(10000, "2026-09", { ...settings, taxRate: 1 })).toBe(14.5);
  });
  it("round-trips goals, clock, motion and accent through Excel", async () => {
    const state = stateFor();
    state.savingsGoals!.push(goal("Kamera", 500, "2026-11-01"));
    state.seasonalTheme = { accentColor: "#a78bfa", reduceMotion: true };
    state.transactions = [{ ...transfer("Sparen", 180), time: "12:15:00" }];
    const restored = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(restored.savingsGoals).toEqual(state.savingsGoals);
    expect(restored.seasonalTheme).toEqual(state.seasonalTheme);
    expect(restored.transactions).toEqual(state.transactions);
  });
});

describe("import-only transfer checkmarks", () => {
  it.each([[180, 176, true], [180, 174.6, true], [180, 174.59, false], [180, 185.4, true], [180, 185.41, false], [100, 95, true], [100, 94.99, false], [1000, 970, true], [1000, 1030, true], [1000, 969.99, false], [1000, 1030.01, false], [0, 0, false], [180, 0, false]] as const)("compares %s to %s", (planned, incoming, done) => expect(transferMatches(planned, incoming)).toBe(done));
  it("only counts matching incoming transfers in this month, not balances or income", () => {
    const state = stateFor();
    state.settings.balances.Sparkonto = 10000;
    state.transactions = [transfer("Sparen", 180, "2026-08-31"), transfer("Sparen", 180, "2026-09-15"), { ...transfer("Sparen", 180), description: "Gehalt", category: "Gehalt" }, transfer("Urlaub", 180), transfer("Sparen", -180)];
    expect(calculateDashboard(state).monthlyFunding[0].done).toBe(false);
    state.transactions.push(transfer("Sparen", 100), transfer("Sparen", 76));
    expect(calculateDashboard(state).monthlyFunding[0].done).toBe(true);
  });
});
