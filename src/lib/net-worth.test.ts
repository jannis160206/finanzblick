import { describe, expect, it } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { netWorthHistory, netWorthNow } from "./net-worth";

const tx = (id: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id, date, bank: "Raiffeisen", pocket: "Testkonto", description: `Händler ${id}`, amount, category: "Shopping",
  includeInPlan: true, categoryOverride: true, manualCategory: true, ...extra,
});

function stateWith(extra: Partial<AppState>, asOf = "2026-09-15"): AppState {
  const seed = createSeed();
  return appStateSchema.parse({
    ...seed, settings: { ...seed.settings, asOf, baselineDate: "2026-07-01" }, transactions: [],
    merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [], ignoredStatementKeys: [], pocketSnapshots: [],
    accountSnapshots: [], reviewQueue: [], holidayRanges: [], assistantMemory: [], amexBalanceSnapshots: [], trBalances: [],
    ...extra,
  });
}

const core = { notgroschen: 1000, urlaub: 1312.06, sparkonto: 1782.59, motorrad: 0 };
const fixture = () => stateWith({
  transactions: [
    tx("old", "2026-05-03", -10, { bank: "Amex", pocket: null }),
    tx("a", "2026-07-05", -40, { bank: "Amex", pocket: null }),
    tx("b", "2026-08-20", -60, { bank: "Amex", pocket: null }),
  ],
  trBalances: [{ date: "2026-07-31", balance: 1000 }, { date: "2026-09-01", balance: 1200 }],
  accountSnapshots: [{ bank: "Revolut", name: "Hauptkonto", date: "2026-08-10", balance: 300 }],
  assistantMemory: [{ id: "m1", key: "note", text: "Giro hat 2.500 €", at: 1 }],
} as Partial<AppState>);

describe("netWorthHistory", () => {
  it("adds pockets, TR, other accounts and Giro and subtracts open Amex per month from the baseline", () => {
    const state = fixture();
    expect(state.settings.balances).toMatchObject({ Urlaub: 1312.06, Sparkonto: 1782.59, Motorrad: 0 });
    expect(netWorthHistory(state, calculateDashboard(state))).toEqual([
      { month: "2026-07", total: 4044.65, parts: { ...core, amex: -50 } },
      { month: "2026-08", total: 4284.65, parts: { ...core, hauptkonto: 300, amex: -110 } },
      { month: "2026-09", total: 6984.65, parts: { ...core, notgroschen: 1200, hauptkonto: 300, girokonto: 2500, amex: -110 } },
    ]);
  });

  it("uses the dashboard's Amex balance for the current month", () => {
    const state = fixture();
    const dashboard = calculateDashboard(state);
    const point = netWorthNow(state, { ...dashboard, amex: { ...dashboard.amex, outstanding: 250.5 } });
    expect(point).toMatchObject({ month: "2026-09", total: 6844.15, parts: { amex: -250.5 } });
  });

  it("follows Revolut pocket snapshots and leaves the Amex part out without card data", () => {
    const state = stateWith({
      pocketSnapshots: [{ bank: "Revolut", pocket: "Motorrad", date: "2026-08-31", balance: 500 }],
      transactions: [tx("p", "2026-09-05", 120, { bank: "Revolut", pocket: "Motorrad", category: "Transfer intern" })],
    } as Partial<AppState>);
    const history = netWorthHistory(state, calculateDashboard(state));
    expect(history.map((point) => point.month)).toEqual(["2026-08", "2026-09"]);
    expect(history[0].parts).toMatchObject({ motorrad: 500 });
    expect(history[1].parts).toMatchObject({ motorrad: 620 });
    expect(history.some((point) => "amex" in point.parts || "girokonto" in point.parts)).toBe(false);
  });

  it("is empty without any data", () => {
    const state = stateWith({});
    expect(netWorthHistory(state, calculateDashboard(state))).toEqual([]);
    expect(netWorthNow(state, calculateDashboard(state))).toBeUndefined();
  });
});