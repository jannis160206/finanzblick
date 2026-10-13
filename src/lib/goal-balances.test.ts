import { describe, expect, it } from "vitest";
import { actualPockets, calculateDashboard } from "@/lib/calc";
import {
  allocateGoals, bankPocketBalance, goalBalance, goalBalanceStatus, goalProjectionBalances, initializeMotorcycleGoal, physicalAssetTotal,
  physicalPocketBalance, physicalPocketBalances, physicalProjectionTotal, preserveGoalOpeningBalances,
} from "@/lib/goals";
import { createSeed } from "@/lib/seed";
import { appStateSchema, emptyPockets, type AppState, type SavingsGoal, type Transaction } from "@/lib/types";

const goal = (id = "camera", pocket = "Kamera"): SavingsGoal =>
  ({ id, name: id, pocket, target: 1000, date: "2027-04-01" });
function fixture(): AppState {
  const state = createSeed();
  state.settings = { ...state.settings, baselineDate: "2026-09-01", asOf: "2026-10-14", balances: emptyPockets() };
  state.transactions = [];
  state.accountSnapshots = [];
  state.pocketSnapshots = [];
  state.trBalances = [];
  state.financeRows = [];
  state.months = {};
  state.savingsGoals = [];
  return state;
}
const transfer = (id: string, pocket: string, amount: number, date = "2026-10-10"): Transaction =>
  ({ id, bank: "Revolut", pocket, amount, date, description: "Transfer intern", category: "Transfer intern", includeInPlan: false });
const assets = (state: AppState) => physicalAssetTotal(physicalPocketBalances(state, actualPockets(state)));

describe("physical balances are not goal earmarks", () => {
  it.each(["Sparkonto", "Sparen", "Urlaub", "Notgroschen", "Motorradkonto"])("respects a 1000 euro core balance for %s", (pocket) => {
    const state = fixture();
    state.settings.balances = { Notgroschen: 1000, Motorrad: 1000, Sparkonto: 1000, Urlaub: 1000 };
    state.savingsGoals = [goal("trip", pocket)];
    expect(goalBalance(state, state.savingsGoals[0], actualPockets(state))).toBe(1000);
    expect(assets(state)).toBe(4000);
  });

  it("does not turn core1000 + a goal over the same imported1000 into assets2000", () => {
    const state = fixture();
    state.settings.balances.Sparkonto = 1000;
    state.accountSnapshots = [{ bank: "Revolut", name: "Sparen", date: state.settings.asOf, balance: 1000 }];
    expect(assets(state)).toBe(1000);
    state.savingsGoals = [goal("camera", "Sparkonto")];
    expect(goalBalance(state, state.savingsGoals[0], actualPockets(state))).toBe(1000);
    expect(assets(state)).toBe(1000);
    const dashboard = calculateDashboard(state);
    expect(dashboard.totalAssets).toBe(1000);
    expect(dashboard.timeline.find((row) => row.month === "2026-10")?.total).toBe(1000);
    state.savingsGoals = [];
    expect(assets(state)).toBe(1000);
  });

  it("counts one extra1000 pocket once, independent of zero, one or multiple goals", () => {
    const state = fixture();
    state.accountSnapshots = [{ bank: "Revolut", name: "Extra", date: state.settings.asOf, balance: 1000 }];
    expect(assets(state)).toBe(1000);
    state.savingsGoals = [goal("camera", "Extra")];
    expect(assets(state)).toBe(1000);
    state.savingsGoals.push(goal("trip", " extra "));
    expect(assets(state)).toBe(1000);
    expect(state.savingsGoals.map((item) => goalBalanceStatus(state, item, actualPockets(state))))
      .toEqual([{ status: "conflict", amount: null }, { status: "conflict", amount: null }]);
    const dashboard = calculateDashboard(state);
    expect(dashboard.totalAssets).toBe(1000);
    expect(dashboard.actualGoals).toEqual({ camera: null, trip: null });
    expect(dashboard.timeline.find((row) => row.month === "2026-10"))
      .toMatchObject({ total: 1000, goalEnd: { camera: null, trip: null } });
  });

  it("counts a native physical pocket snapshot even without an associated goal", () => {
    const state = fixture();
    state.pocketSnapshots = [{ bank: "Revolut", pocket: "Sparkonto", date: state.settings.asOf, balance: 1000 }];
    expect(assets(appStateSchema.parse(state))).toBe(1000);
  });

  it("does not use an unrelated physical pocket snapshot to infer a goal balance", () => {
    const state = fixture();
    state.accountSnapshots = [{ bank: "Revolut", name: "Kamera Zubehör", date: state.settings.asOf, balance: 1000 }];
    state.savingsGoals = [goal()];
    const loaded = appStateSchema.parse(state);
    expect(goalBalance(loaded, loaded.savingsGoals![0], actualPockets(loaded))).toBeNull();
    expect(assets(loaded)).toBe(1000);
  });

  it("counts every physical pocket once, including everyday cash, without adding independent openings to bank cash", () => {
    const state = fixture();
    state.settings.balances.Sparkonto = 1000;
    state.savingsGoals = [{ ...goal("motorcycle", "Motorrad"), openingBalance: { date: "2026-10-01", amount: 2445 } }];
    state.accountSnapshots = [
      { bank: "Revolut", name: "Mittagessen", date: state.settings.asOf, balance: 10 },
      { bank: "Revolut", name: "Lebensmittel (EUR)", date: state.settings.asOf, balance: 20 },
      { bank: "Revolut", name: "Entertainment & Haushalt", date: state.settings.asOf, balance: 30 },
      { bank: "Revolut", name: "Tanken", date: state.settings.asOf, balance: 40 },
    ];
    const loaded = appStateSchema.parse(state);
    const physical = physicalPocketBalances(loaded, actualPockets(loaded));
    expect(physical.lebensmittel.amount).toBe(20);
    expect(bankPocketBalance(loaded, "Motorrad", actualPockets(loaded))).toBe(0);
    expect(physicalAssetTotal(physical)).toBe(3545);
    const dashboard = calculateDashboard(loaded);
    expect(dashboard.totalAssets).toBe(3545);
    expect(dashboard.timeline.find((row) => row.month === "2026-10")?.total).toBe(3545);
    loaded.savingsGoals!.push(goal("groceries", "Lebensmittel"));
    expect(goalBalance(loaded, loaded.savingsGoals![1], actualPockets(loaded))).toBe(20);
    expect(assets(loaded)).toBe(3545);
    expect(calculateDashboard(loaded).timeline.find((row) => row.month === "2026-10")?.total).toBe(3545);
    loaded.savingsGoals!.push(goal("second-purpose", "Lebensmittel (EUR)"));
    expect(assets(loaded)).toBe(3545);
    const withoutGoals = { ...preserveGoalOpeningBalances(loaded), savingsGoals: [] };
    expect(assets(withoutGoals)).toBe(3545);
  });

  it("does not identify a physical pocket from the goal display name", () => {
    const state = fixture();
    state.settings.balances.Sparkonto = 1000;
    state.savingsGoals = [goal("Sparkonto", "Camera")];
    expect(goalBalance(state, state.savingsGoals[0], actualPockets(state))).toBeNull();
    expect(assets(state)).toBe(1000);
  });

  it("uses the latest absolute extra pocket snapshot plus subsequent Revolut movements", () => {
    const state = fixture();
    state.savingsGoals = [goal()];
    state.accountSnapshots = [
      { bank: "Revolut", name: "Kamera", date: "2026-09-10", balance: 200 },
      { bank: "Revolut", name: "Kamera", date: "2026-10-10", balance: 1000 },
    ];
    state.transactions = [
      transfer("included", "Kamera", 1000), transfer("new", "Kamera", 50, "2026-10-11"),
      { ...transfer("other-bank", "Kamera", 999, "2026-10-11"), bank: "Raiffeisen" },
      transfer("future", "Kamera", 999, "2026-10-15"),
    ];
    expect(goalBalance(state, state.savingsGoals[0], actualPockets(state))).toBe(1050);
  });

  it("does not replace a core baseline with an older statement", () => {
    const state = fixture();
    state.settings.balances.Sparkonto = 1000;
    state.accountSnapshots = [{ bank: "Revolut", name: "Sparen", date: "2026-08-31", balance: 100 }];
    expect(physicalPocketBalance(state, "Sparen", actualPockets(state)).amount).toBe(1000);
  });

  it("uses the same newer authoritative core account snapshot for bank cards and reserve totals", () => {
    const state = fixture();
    state.settings.balances.Sparkonto = 1000;
    state.accountSnapshots = [{ bank: "Revolut", name: "Sparen", date: state.settings.asOf, balance: 2000 }];
    expect(bankPocketBalance(state, "Sparkonto", actualPockets(state))).toBe(2000);
    expect(assets(state)).toBe(2000);
  });

  it("keeps an unbased movement unknown, but an observed zero is known zero", () => {
    const state = fixture();
    state.savingsGoals = [goal()];
    state.transactions = [transfer("only-movement", "Kamera", 100)];
    expect(goalBalanceStatus(state, state.savingsGoals[0], actualPockets(state))).toEqual({ status: "unknown", amount: null });
    state.accountSnapshots = [{ bank: "Revolut", name: "Kamera", date: state.settings.asOf, balance: 0 }];
    expect(goalBalanceStatus(state, state.savingsGoals[0], actualPockets(state))).toEqual({ status: "known", source: "snapshot", amount: 0 });
  });

  it("does not treat an explicitly unknown core baseline as a known zero goal balance", () => {
    const state = fixture();
    state.settings.unknownBalances = ["Sparkonto"];
    state.savingsGoals = [goal("camera", "Sparkonto")];
    expect(goalBalance(state, state.savingsGoals[0], actualPockets(state))).toBeNull();
    state.accountSnapshots = [{ bank: "Revolut", name: "Sparen", date: state.settings.asOf, balance: 0 }];
    expect(goalBalanceStatus(state, state.savingsGoals[0], actualPockets(state)))
      .toEqual({ status: "known", source: "snapshot", amount: 0 });
  });

  it("does not inject the personal motorcycle opening when missing baseline data merely uses zero as a placeholder", () => {
    const state = fixture();
    state.settings.unknownBalances = ["Motorrad"];
    state.savingsGoals = [goal("motorcycle", "Motorrad")];
    const initialized = initializeMotorcycleGoal(state, 0);
    expect(initialized.savingsGoals?.[0].openingBalance).toBeUndefined();
    expect(goalBalance(initialized, initialized.savingsGoals![0], actualPockets(initialized))).toBeNull();
  });

  it("reports conflicting authoritative snapshots without inventing a zero balance", () => {
    const state = fixture();
    state.accountSnapshots = [
      { bank: "Revolut", name: "Kamera", date: state.settings.asOf, balance: 1000 },
      { bank: "Revolut", name: "Kamera", date: state.settings.asOf, balance: 500 },
    ];
    expect(physicalPocketBalance(state, "Kamera", actualPockets(state))).toEqual({ status: "conflict", amount: null });
  });

  it("treats EUR account suffixes as the same physical pocket, not extra assets", () => {
    const state = fixture();
    state.savingsGoals = [goal()];
    state.accountSnapshots = [
      { bank: "Revolut", name: "Kamera (EUR)", date: state.settings.asOf, balance: 1000 },
      { bank: "Revolut", name: "Kamera", date: state.settings.asOf, balance: 1000 },
    ];
    expect(goalBalance(state, state.savingsGoals[0], actualPockets(state))).toBe(1000);
    expect(assets(state)).toBe(1000);
  });

  it("does not count personal accounts, foreign currency or main-account transfer legs as pocket assets", () => {
    const state = fixture();
    state.accountSnapshots = [
      { bank: "Revolut", name: "Persönliches Konto", date: state.settings.asOf, balance: 1000 },
      { bank: "Revolut", name: "Persönliches Konto (USD)", date: state.settings.asOf, balance: 1000 },
      { bank: "Revolut", name: "Kamera (USD)", date: state.settings.asOf, balance: 1000 },
    ];
    expect(assets(state)).toBe(0);
  });
});

describe("independent opening balances survive goal changes", () => {
  it("preserves an independent opening through validated JSON after removing its goal", () => {
    const state = fixture();
    state.savingsGoals = [{ ...goal(), openingBalance: { date: "2026-10-01", amount: 1000 } }];
    const migrated = { ...preserveGoalOpeningBalances(state), savingsGoals: [] };
    const loaded = appStateSchema.parse(JSON.parse(JSON.stringify(migrated)));
    expect(loaded).toHaveProperty("pocketOpeningBalances");
    expect(assets(loaded)).toBe(1000);
  });

  it("retains explicit unknown baseline metadata through validated JSON", () => {
    const state = fixture();
    state.settings.unknownBalances = ["Sparkonto"];
    state.savingsGoals = [goal("camera", "Sparkonto")];
    const loaded = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(loaded.settings).toHaveProperty("unknownBalances", ["Sparkonto"]);
    expect(goalBalance(loaded, loaded.savingsGoals![0], actualPockets(loaded))).toBeNull();
  });

  it("losslessly copies a legacy opening once and preserves it when its goal is removed", () => {
    const before = fixture();
    before.savingsGoals = [{ ...goal(), openingBalance: { date: "2026-10-10", amount: 1000, includedTransactionIds: ["old"] }, completedAt: "2026-10-10" }];
    before.transactions = [transfer("old", "Kamera", 1000), transfer("new", "Kamera", 50, "2026-10-11")];
    const migrated = preserveGoalOpeningBalances(before);
    expect(migrated.savingsGoals).toEqual(before.savingsGoals);
    expect(before).not.toHaveProperty("pocketOpeningBalances");
    expect(preserveGoalOpeningBalances(migrated)).toBe(migrated);
    expect(assets(migrated)).toBe(1050);
    expect(assets({ ...migrated, savingsGoals: [] })).toBe(1050);
  });

  it("retains historical motorcycle opening and lets later authoritative zero replace it", () => {
    const state = fixture();
    state.savingsGoals = [{ ...goal("motorcycle", "Motorrad"), openingBalance: { date: "2026-10-05", amount: 2445 } }];
    state.pocketSnapshots = [{ bank: "Revolut", pocket: "Motorrad", date: "2026-10-05", balance: 0 }];
    expect(assets(state)).toBe(2445);
    const migrated = preserveGoalOpeningBalances(state);
    expect(assets({ ...migrated, savingsGoals: [] })).toBe(2445);
    state.pocketSnapshots.push({ bank: "Revolut", pocket: "Motorrad", date: "2026-10-12", balance: 0 });
    expect(assets(state)).toBe(0);
  });

  it("does not add a core earmark opening to an already known core balance", () => {
    const state = fixture();
    state.settings.balances.Sparkonto = 1000;
    state.savingsGoals = [{ ...goal("camera", "Sparkonto"), openingBalance: { date: "2026-10-01", amount: 1000 } }];
    expect(assets(state)).toBe(1000);
    expect(goalBalance(state, state.savingsGoals[0], actualPockets(state))).toBe(1000);
  });

  it("unions included movements for identical physical openings rather than counting another goal's included transfer again", () => {
    const state = fixture();
    state.savingsGoals = [
      { ...goal("first"), openingBalance: { date: "2026-10-10", amount: 1000, includedTransactionIds: ["old-a"] } },
      { ...goal("second"), openingBalance: { date: "2026-10-10", amount: 1000, includedTransactionIds: ["old-b"] } },
    ];
    state.transactions = [transfer("old-a", "Kamera", 500), transfer("old-b", "Kamera", 500)];
    expect(assets(state)).toBe(1000);
  });
});

describe("unique physical goal projections", () => {
  it("honors explicit instructions without assuming an unknown absolute goal balance is zero", () => {
    const trip = { ...goal("trip", "Trip"), funding: { monthly: 400, extras: { "2026-12": 800 } } };
    expect(allocateGoals(620, [trip], { trip: null }, "2026-10"))
      .toEqual({ savings: 220, vacation: 0, goals: { trip: 400 } });
    expect(allocateGoals(620, [trip], { trip: null }, "2026-12"))
      .toEqual({ savings: 220, vacation: 0, goals: { trip: 1200 } });
    expect(goalProjectionBalances([trip], { trip: null })).toEqual({ trip: null });
  });

  it("does not derive an automatic target-gap instruction from an unknown balance", () => {
    expect(allocateGoals(620, [goal("trip", "Trip")], { trip: null }, "2026-10"))
      .toEqual({ savings: 620, vacation: 0, goals: { trip: 0 } });
    expect(allocateGoals(620, [goal("trip", "Trip")], {}, "2026-10"))
      .toEqual({ savings: 620, vacation: 0, goals: { trip: 0 } });
  });

  it("does not pick a deadline or ratio split for overlapping goals, even with declared instructions", () => {
    const first = { ...goal("first", "Extra"), funding: { monthly: 400, extras: {} } };
    const second = { ...goal("second", " extra "), funding: { monthly: 200, extras: {} } };
    expect(allocateGoals(620, [first, second], { first: 1000, second: 1000 }, "2026-10"))
      .toEqual({ savings: 620, vacation: 0, goals: { first: 0, second: 0 } });
  });

  it("derives shared-pocket goal projections as unresolved, not two fully financed targets", () => {
    const goals = [goal("camera", "Extra"), goal("trip", "Extra")];
    const physical = { extra: 1000, sparkonto: 1000, missing: null };
    expect(goalProjectionBalances(goals, physical)).toEqual({ camera: null, trip: null });
    expect(physicalProjectionTotal({ ...emptyPockets(), Sparkonto: 1000 }, physical)).toBe(2000);
  });
  it("keeps unknown absolute forecasts unknown instead of silently assuming zero", () => {
    expect(goalProjectionBalances([goal()], { kamera: null })).toEqual({ camera: null });
    expect(goalProjectionBalances([goal()], { kamera: 0 })).toEqual({ camera: 0 });
    expect(physicalProjectionTotal({ ...emptyPockets(), Sparkonto: 1000 }, { sparkonto: null })).toBe(0);
  });
});
