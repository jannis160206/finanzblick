import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { detectDuplicateCharges, detectSubscriptions, financeInsights, summarizeMonth } from "./insights";
import { fallbackSummary, numbersBacked } from "./ai/summary";
import { summaryFacts } from "@/components/finance-insights";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"]): Transaction => ({
  id: `t${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description, amount, category, includeInPlan: true,
});

const stateWith = (transactions: Transaction[]): AppState => appStateSchema.parse({
  ...createSeed(), transactions, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
  ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
});

const monthly = (description: string, amounts: number[], startMonth = 5, day = "15") =>
  amounts.map((amount, index) => row(`2026-${String(startMonth + index).padStart(2, "0")}-${day}`, description, -amount, "Abonnements"));

describe("finance insights", () => {
  it("detects running monthly subscriptions and price increases", () => {
    const state = stateWith([...monthly("Streamflix Abo", [9.99, 9.99, 9.99, 12.99]), ...monthly("Altabo Media", [5, 5, 5], 1)]);
    const subscriptions = detectSubscriptions(state, "2026-09-01");
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({ interval: "monatlich", amount: 12.99, count: 4, nextDate: "2026-09-14" });
    expect(subscriptions[0].priceChange).toMatchObject({ from: 9.99, to: 12.99 });
  });

  it("does not treat a frequently visited shop as subscription", () => {
    const visits = ["05-02", "05-09", "05-15", "05-20", "06-15", "06-03", "06-22", "07-15", "07-08", "07-28"]
      .map((date) => row(`2026-${date}`, "Supermarkt Nord", -20, "Lebensmittel"));
    expect(detectSubscriptions(stateWith(visits), "2026-08-01")).toHaveLength(0);
  });

  it("reports isolated double charges but not habits", () => {
    const state = stateWith([
      row("2026-08-01", "Elektro Shop 1", -89.9, "Shopping"), row("2026-08-02", "Elektro Shop 1", -89.9, "Shopping"),
      ...["08-03", "08-04", "08-05"].map((date) => row(`2026-${date}`, "Parkhaus Mitte", -6, "Mobilität")),
    ]);
    const duplicates = detectDuplicateCharges(state);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ amount: -89.9, dates: ["2026-08-01", "2026-08-02"] });
  });

  it("summarises a month and forecasts the current one", () => {
    const state = stateWith([
      row("2026-08-01", "Gehalt", 2000, "Gehalt"), row("2026-08-05", "Supermarkt", -300, "Lebensmittel"),
      row("2026-08-20", "Möbelhaus", -500, "Möbel & Einrichtung"), row("2026-09-03", "Supermarkt", -60, "Lebensmittel"),
      ...monthly("Streamflix Abo", [10, 10, 10, 10], 5, "20"),
    ]);
    const august = summarizeMonth(state, "2026-08");
    expect(august).toMatchObject({ income: 2000, spending: 810, balance: 1190 });
    expect(august.topCategories[0]).toMatchObject({ category: "Möbel & Einrichtung", amount: 500 });
    const insights = financeInsights(state, "2026-09-10");
    expect(insights.forecast).toMatchObject({ month: "2026-09", spentSoFar: 60, expectedSubscriptions: 10, daysLeft: 20 });
    expect(insights.forecast.projectedSpending).toBeGreaterThan(70);
  });

  it("only accepts model summaries whose numbers are backed by facts", () => {
    const state = stateWith([row("2026-08-01", "Gehalt", 2000, "Gehalt"), row("2026-08-05", "Supermarkt", -312.4, "Lebensmittel")]);
    const facts = summaryFacts(financeInsights(state, "2026-09-10"));
    expect(numbersBacked("Im August hast du 312,40 € ausgegeben und 2.000 € verdient.", facts)).toBe(true);
    expect(numbersBacked("Du hast 2000,00 € verdient und 312,40 € ausgegeben.", facts)).toBe(true);
    expect(numbersBacked("Du hast 2312,40 € bewegt.", facts)).toBe(false);
    expect(numbersBacked("Im August hast du 999,40 € ausgegeben.", facts)).toBe(false);
    expect(fallbackSummary(facts)).toContain("312,40");
  });
});
