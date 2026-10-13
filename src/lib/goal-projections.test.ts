import { describe, expect, it } from "vitest";
import { calculateDashboard, synchronizeGoals } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { emptyPockets, type AppState, type SavingsGoal, type Transaction } from "@/lib/types";
import { monthlyVariableBudget } from "@/lib/variable-budgets";

const goal = (id: string, pocket: string, target = 1000): SavingsGoal => ({
  id, name: id, pocket, target, date: "2027-04-01",
});
function fixture(): AppState {
  const seed = createSeed();
  return { ...seed, settings: { ...seed.settings, baselineDate: "2026-09-01", asOf: "2026-10-14", balances: emptyPockets() },
    transactions: [], financeRows: [], months: {}, savingsGoals: [], accountSnapshots: [], pocketSnapshots: [], trBalances: [],
    plannedOneOffs: [], plannedOneOffsSeeded: true, fixedReceipts: [] };
}
const transfer = (pocket: string, amount: number): Transaction => ({
  id: "transfer", bank: "Revolut", pocket, amount, date: "2026-10-10",
  description: "Transfer intern", category: "Transfer intern", includeInPlan: false,
});

describe("calculator physical-pocket integration", () => {
  it.each(["Sparkonto", "Urlaub", "Notgroschen", "Motorrad"] as const)("does not add a %s goal as a second asset", (pocket) => {
    const state = fixture();
    state.settings.balances[pocket] = 1000;
    const before = calculateDashboard(state);
    state.savingsGoals = [goal("purpose", pocket)];
    const after = calculateDashboard(state);
    expect(after.actualGoals.purpose).toBe(1000);
    expect(after.totalAssets).toBe(before.totalAssets);
    expect(after.timeline.map((row) => row.total)).toEqual(before.timeline.map((row) => row.total));
  });

  it("counts an extra physical pocket without a goal, and never multiplies it for overlapping goals", () => {
    const state = fixture();
    state.accountSnapshots = [{ bank: "Revolut", name: "Extra", date: "2026-10-01", balance: 1000 }];
    const before = calculateDashboard(state);
    expect(before.totalAssets).toBe(1000);
    state.savingsGoals = [goal("first", "Extra"), goal("second", " extra ")];
    const after = calculateDashboard(state);
    const current = after.timeline.find((row) => row.month === after.currentMonth)!;
    expect(after.totalAssets).toBe(1000);
    expect(after.actualGoals).toEqual({ first: null, second: null });
    expect(current.goalRates).toEqual({ first: 0, second: 0 });
    expect(current.goalEnd).toEqual({ first: null, second: null });
    expect(current.allocationBlocked).toBe(true);
    expect(after.timeline.map((row) => row.total)).toEqual(before.timeline.map((row) => row.total));
    expect(synchronizeGoals(state).savingsGoals!.map((item) => item.completedAt)).toEqual([undefined, undefined]);
  });

  it("keeps an unknown pocket unknown and exposes the blocked recommendation rather than reallocating its claim", () => {
    const state = fixture();
    state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: { "2026-10": 3000 } }];
    state.savingsGoals = [goal("unknown", "Missing")];
    const dashboard = calculateDashboard(state);
    const current = dashboard.timeline.find((row) => row.month === dashboard.currentMonth)!;
    expect(dashboard.actualGoals.unknown).toBeNull();
    expect(current.goalEnd.unknown).toBeNull();
    expect(current.goalRates.unknown).toBe(0);
    expect(current.allocationBlocked).toBe(true);
    expect(current.rates.Sparkonto).toBe(0);
    expect(dashboard.monthlyFunding).toEqual([]);
  });

  it.each(["Missing", "Sparkonto"])("preserves explicit400 funding for an unknown %s without inventing its absolute forecast", (pocket) => {
    const state = fixture();
    state.settings.unknownBalances = ["Sparkonto"];
    state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
      "2026-10": monthlyVariableBudget("2026-10").total + 620,
      "2026-11": monthlyVariableBudget("2026-11").total + 620,
    } }];
    state.savingsGoals = [{ ...goal("purpose", pocket), funding: { monthly: 400, extras: {} } }];
    const dashboard = calculateDashboard(state);
    expect(dashboard.actualGoals.purpose).toBeNull();
    for (const month of ["2026-10", "2026-11"]) {
      const row = dashboard.timeline.find((item) => item.month === month)!;
      expect(row.goalRates.purpose).toBe(400);
      expect(row.goalEnd.purpose).toBeNull();
      expect(row.physicalEnd[pocket.toLocaleLowerCase("de-AT")]).toBeNull();
    }
    expect(dashboard.monthlyFunding).toEqual([
      expect.objectContaining({ id: "purpose", amount: 400, transferred: 0, done: false }),
    ]);
  });

  it.each(["Extra", "Sparkonto"])("never projects a past unexecuted instruction into a known %s balance", (pocket) => {
    const state = fixture();
    state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
      "2026-09": monthlyVariableBudget("2026-09").total + 620,
      "2026-10": monthlyVariableBudget("2026-10").total + 620,
    } }];
    state.savingsGoals = [{ ...goal("purpose", pocket, 10000), funding: { monthly: 400, extras: {} } }];
    if (pocket === "Extra") state.pocketOpeningBalances = [{ pocket, date: "2026-09-01", amount: 0 }];
    const dashboard = calculateDashboard(state);
    const past = dashboard.timeline.find((row) => row.month === "2026-09")!;
    expect(past.physicalEnd[pocket.toLocaleLowerCase("de-AT")]).toBe(0);
    expect(past.goalEnd.purpose).toBe(0);
  });

  it.each(["Extra", "Sparkonto"])("counts past/current/future %s transfers and withdrawals only once", (pocket) => {
    const state = fixture();
    state.settings.asOf = "2026-10-14";
    state.settings.baselineDate = "2026-09-01";
    state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
      "2026-10": monthlyVariableBudget("2026-10").total + 620,
      "2026-11": monthlyVariableBudget("2026-11").total + 620,
    } }];
    state.savingsGoals = [{ ...goal("purpose", pocket, 10000), funding: { monthly: 400, extras: {} } }];
    if (pocket === "Extra") state.pocketOpeningBalances = [{ pocket, date: "2026-09-01", amount: 1000 }];
    else state.settings.balances.Sparkonto = 1000;
    state.transactions = [
      { ...transfer(pocket, 400), id: "past-in", date: "2026-09-10" },
      { ...transfer(pocket, -100), id: "past-out", date: "2026-09-11" },
      { ...transfer(pocket, 400), id: "current-in", date: "2026-10-10" },
      { ...transfer(pocket, -100), id: "current-out", date: "2026-10-11" },
      { ...transfer(pocket, 400), id: "future-in", date: "2026-11-10" },
      { ...transfer(pocket, -100), id: "future-out", date: "2026-11-11" },
    ];
    const dashboard = calculateDashboard(state);
    const rows = ["2026-09", "2026-10", "2026-11"].map((month) => dashboard.timeline.find((row) => row.month === month)!);
    expect(dashboard.actualGoals.purpose).toBe(1600);
    expect(rows[0].physicalEnd[pocket.toLocaleLowerCase("de-AT")]).toBe(1300);
    expect(rows[1].physicalEnd[pocket.toLocaleLowerCase("de-AT")]).toBe(pocket === "Extra" ? 1600 : 1820);
    expect(rows[2].physicalEnd[pocket.toLocaleLowerCase("de-AT")]).toBe(pocket === "Extra" ? 1900 : 2340);
  });

  it.each(["Extra", "Sparkonto"])("includes later current-month %s withdrawals in the forecast, not in observed cash", (pocket) => {
    const state = fixture();
    if (pocket === "Extra") state.pocketOpeningBalances = [{ pocket, date: "2026-09-01", amount: 1000 }];
    else state.settings.balances.Sparkonto = 1000;
    state.transactions = [
      { ...transfer(pocket, -100), id: "pending-withdrawal", date: "2026-10-20" },
      { ...transfer(pocket, -200), id: "next-withdrawal", date: "2026-11-20" },
    ];
    const dashboard = calculateDashboard(state);
    expect(dashboard.totalAssets).toBe(1000);
    const current = dashboard.timeline.find((row) => row.month === "2026-10")!;
    const next = dashboard.timeline.find((row) => row.month === "2026-11")!;
    expect(current.physicalEnd[pocket.toLocaleLowerCase("de-AT")]).toBe(900);
    expect(next.physicalEnd[pocket.toLocaleLowerCase("de-AT")]).toBe(700);
  });

  it("does not use another bank's same-named transfer as proof of Revolut goal funding", () => {
    const state = fixture();
    state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
      "2026-10": monthlyVariableBudget("2026-10").total + 620,
    } }];
    state.savingsGoals = [{ ...goal("purpose", "Extra", 10000), funding: { monthly: 400, extras: {} } }];
    state.pocketOpeningBalances = [{ pocket: "Extra", date: "2026-09-01", amount: 1000 }];
    state.transactions = [{ ...transfer("Extra", 400), bank: "Raiffeisen" }];
    const dashboard = calculateDashboard(state);
    expect(dashboard.actualGoals.purpose).toBe(1000);
    expect(dashboard.monthlyFunding.find((row) => row.id === "purpose"))
      .toMatchObject({ amount: 400, transferred: 0, done: false });
  });

  it.each(["Extra", "Sparkonto"])("subtracts a current imported transfer exactly once in the %s goal projection", (pocket) => {
    const state = fixture();
    state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: { "2026-10": 3000 } }];
    state.savingsGoals = [goal("purpose", pocket)];
    if (pocket === "Extra") state.accountSnapshots = [{ bank: "Revolut", name: pocket, date: "2026-10-01", balance: 0 }];
    state.transactions = [transfer(pocket, 500)];
    const dashboard = calculateDashboard(state);
    const current = dashboard.timeline.find((row) => row.month === dashboard.currentMonth)!;
    expect(dashboard.actualGoals.purpose).toBe(500);
    expect(current.goalRates.purpose).toBe(1000);
    expect(current.goalEnd.purpose).toBe(pocket === "Sparkonto" ? current.end.Sparkonto : 1000);
    const expected = 500 + dashboard.current.surplus - 500;
    expect(current.total).toBe(expected);
  });

  it("does not mark a goal complete merely because its display name matches another funded pocket", () => {
    const state = fixture();
    state.accountSnapshots = [{ bank: "Revolut", name: "Sparkonto", date: "2026-10-01", balance: 2000 }];
    state.savingsGoals = [{ ...goal("camera", "Missing"), name: "Sparkonto" }];
    expect(synchronizeGoals(state).savingsGoals![0].completedAt).toBeUndefined();
    expect(calculateDashboard(state).actualGoals.camera).toBeNull();
  });

  it("checks a shared core-pocket instruction once instead of reusing its transfer for the floor and goal", () => {
    const state = fixture();
    state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: { "2026-10": 1911.5 } }];
    state.savingsGoals = [goal("purpose", "Sparkonto", 10000)];
    state.transactions = [transfer("Sparkonto", 500)];
    const half = calculateDashboard(state);
    expect(half.monthlyFunding).toHaveLength(1);
    expect(half.monthlyFunding[0]).toMatchObject({
      memberIds: ["savings", "purpose"], combined: true, amount: 1000, transferred: 500, done: false,
    });
    state.transactions = [transfer("Sparkonto", 1000)];
    expect(calculateDashboard(state).monthlyFunding[0]).toMatchObject({ amount: 1000, transferred: 1000, done: true });
  });
});
