import { describe, expect, it } from "vitest";
import { calculateDashboard, monthlyInterest } from "@/lib/calc";
import { goalPlanningContext } from "@/lib/goal-planner";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";
import { isTradeRepublicInterest, trInterestRate } from "./tr-interest";

let counter = 0;
const credit = (date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id: `zins-${++counter}`, date, bank: "Trade Republic", pocket: "Verrechnungskonto", description: "Zinsgutschrift Trade Republic",
  amount, category: "Einkommen", includeInPlan: false, ...extra,
});
const stateWith = (extra: Partial<AppState> = {}, asOf = "2026-11-05"): AppState => {
  const seed = createSeed();
  return { ...seed, transactions: [], settings: { ...seed.settings, asOf }, ...extra };
};
const monthly = ["2026-09-01", "2026-10-01", "2026-11-01"];

describe("Trade Republic interest rate", () => {
  it("derives the gross rate from the net credits of the last three months and the average bank balance", () => {
    const state = stateWith({ trBalances: [{ date: "2026-08-01", balance: 10_000 }], transactions: monthly.map((date) => credit(date, 13.59)) });
    expect(trInterestRate(state)).toEqual({
      source: "credits", rate: 0.0225, credits: 3, interest: 56.23, averageBalance: 10_000, from: "2026-08-01", to: "2026-11-01",
    });
  });

  it("uses the gross amount of the CSV export and weights the balance by days", () => {
    const transactions = monthly.map((date) => credit(date, 13.59, { rawDetails: ["Brutto: 18,75 €", "Steuer: -5,16 €"] }));
    const trBalances = [{ date: "2026-08-01", balance: 8_000 }, { date: "2026-09-16", balance: 12_000 }];
    expect(trInterestRate(stateWith({ transactions, trBalances }))).toMatchObject({ source: "credits", rate: 0.0225, averageBalance: 10_000 });
  });

  it("ignores old, ignored and foreign credits", () => {
    const transactions = [
      credit("2026-08-01", 500), credit("2026-10-01", 500, { ignored: true }),
      credit("2026-10-02", 500, { bank: "Raiffeisen", description: "Habenzinsen" }), credit("2026-11-01", 13.59),
    ];
    const rate = trInterestRate(stateWith({ transactions, trBalances: [{ date: "2026-08-01", balance: 10_000 }] }));
    expect(rate).toMatchObject({ source: "credits", credits: 1, rate: 0.0225 });
    expect(isTradeRepublicInterest(transactions[2])).toBe(false);
    expect(isTradeRepublicInterest(credit("2026-11-01", -3))).toBe(false);
  });

  it("falls back to the latest stored rate without credits, balances or with an implausible result", () => {
    const seed = createSeed();
    const stored = { ...seed.settings, asOf: "2026-11-05", interestRates: [{ date: "2026-01-01", rate: 0.02 }, { date: "2026-10-01", rate: 0.023 }, { date: "2026-12-01", rate: 0.03 }] };
    expect(trInterestRate(stateWith({ settings: stored }))).toEqual({ source: "stored", rate: 0.023, date: "2026-10-01" });
    expect(trInterestRate(stateWith({ settings: stored, transactions: monthly.map((date) => credit(date, 13.59)) }))).toMatchObject({ source: "stored" });
    expect(trInterestRate(stateWith({ settings: stored, trBalances: [{ date: "2026-08-01", balance: 100 }], transactions: monthly.map((date) => credit(date, 13.59)) })))
      .toMatchObject({ source: "stored", rate: 0.023 });
    expect(trInterestRate(stateWith({}, "2026-09-11"))).toEqual({ source: "stored", rate: 0.0225 });
    expect(trInterestRate(stateWith())).toEqual({ source: "stored", rate: 0.025, date: "2026-09-17" });
  });

  it("feeds the dashboard interest and the goal planner", () => {
    const state = stateWith({ trBalances: [{ date: "2026-08-01", balance: 10_000 }], transactions: monthly.map((date) => credit(date, 13.59)) });
    const dashboard = calculateDashboard(state);
    const november = dashboard.timeline.find((month) => month.month === "2026-11")!;
    expect(november.interest).toBe(monthlyInterest(10_000, "2026-11", state.settings, 0.0225));
    expect(november.interest).not.toBe(monthlyInterest(10_000, "2026-11", state.settings));
    const tradeRepublic = goalPlanningContext(state, dashboard, state.settings.asOf).sources.find((source) => source.bank === "Trade Republic");
    expect(tradeRepublic?.rate).toBe(0.0225);
  });
});
