import { describe, expect, it } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { detectContracts } from "@/lib/contracts";
import { queueLedgerReview } from "@/lib/import/review";
import { monthEndForecast } from "@/lib/month-forecast";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { buildCopilotInsights, dismissInsight, importantInsights } from "./copilot-insights";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"], extra: Partial<Transaction> = {}): Transaction => ({
  id: `c${++counter}`, date, bank: "Raiffeisen", pocket: "Girokonto", description, amount, category, includeInPlan: true, ...extra,
});
const today = "2026-09-20";
function stateWith(transactions: Transaction[], extra: Partial<AppState> = {}): AppState {
  const seed = createSeed();
  return appStateSchema.parse({
    ...seed, settings: { ...seed.settings, asOf: today, baselineDate: "2026-09-01" }, transactions,
    merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [], ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [],
    reviewQueue: [], holidayRanges: [], ...extra,
  });
}
const build = (state: AppState) => {
  const dashboard = calculateDashboard(state);
  const contracts = detectContracts(state, today);
  return buildCopilotInsights(state, dashboard, today, { contracts, forecast: monthEndForecast(state, dashboard, today, contracts) });
};
const kinds = (state: AppState) => build(state).map((item) => item.kind);

describe("copilot insights", () => {
  it("flags an overrun budget with a concrete reallocation prompt", () => {
    const insights = build(stateWith([row("2026-09-05", "Supermarkt Nord", -180, "Lebensmittel"), row("2026-09-12", "Supermarkt Süd", -120, "Lebensmittel")]));
    const budget = insights.find((item) => item.kind === "budget");
    expect(budget).toMatchObject({ id: "budget:2026-09:food:over", severity: "high", href: "/umsaetze?month=2026-09" });
    expect(budget?.text).toMatch(/Vorschlag/);
    expect(budget?.prompt).toMatch(/(umschichten|erhöhen)$/);
  });

  it("warns about cancellation deadlines and price increases from the contract folder", () => {
    const charges = ["05", "06", "07", "08", "09"].map((month, index) => row(`2026-${month}-03`, "Streamflix Abo", index < 4 ? -9.99 : -12.99, "Abonnements"));
    const state = stateWith(charges, { contracts: [{ id: "streamflix", status: "confirmed", notice: { value: 2, unit: "weeks" }, updatedAt: 1 }] });
    const insights = build(state);
    expect(insights.find((item) => item.kind === "deadline")).toMatchObject({ id: "deadline:streamflix:2026-10-20", prompt: "Kündige Streamflix Abo", href: "/vertraege" });
    expect(insights.find((item) => item.kind === "price")).toMatchObject({ id: "price:streamflix:2026-09-03", prompt: "Was kostet mich Streamflix Abo im Jahr?", amount: 36 });
  });

  it("reports goals at risk, possible double charges, unusual spending and open reviews", () => {
    const usual = ["06", "07", "08"].map((month) => row(`2026-${month}-10`, "Restaurant Am Markt", -20, "Restaurants"));
    const state = stateWith([
      ...usual,
      row("2026-09-08", "Restaurant Am Markt", -160, "Restaurants"),
      row("2026-09-10", "Elektro Shop", -89.9, "Shopping"),
      row("2026-09-11", "Elektro Shop", -89.9, "Shopping"),
      row("2026-09-15", "Unbekannter Händler 4711", -25, "Prüfen", { includeInPlan: false }),
    ]);
    const result = kinds(queueLedgerReview(state));
    expect(result).toEqual(expect.arrayContaining(["goal", "duplicate", "unusual", "unclear"]));
    const insights = build(queueLedgerReview(state));
    expect(insights.find((item) => item.kind === "goal")).toMatchObject({ id: "goal:motorcycle:2026-09", href: "/sparen", prompt: "Wie weit bin ich bei Motorrad?" });
    expect(insights.find((item) => item.kind === "unclear")).toMatchObject({ prompt: "Ordne alle offenen Buchungen zu", href: "/umsaetze?pruefen=1" });
  });

  it("warns first when the month will end below zero", () => {
    const state = stateWith([], { accountSnapshots: [{ bank: "Raiffeisen", name: "Girokonto", date: today, balance: -300 }] });
    const insights = build(state);
    expect(insights[0]).toMatchObject({ kind: "forecast", severity: "high", id: "forecast:2026-09" });
  });

  it("orders by severity and keeps dismissed hints away", () => {
    const state = stateWith([row("2026-09-05", "Supermarkt Nord", -180, "Lebensmittel"), row("2026-09-12", "Supermarkt Süd", -120, "Lebensmittel")],
      { accountSnapshots: [{ bank: "Raiffeisen", name: "Girokonto", date: today, balance: -300 }] });
    const insights = build(state);
    expect(insights.map((item) => item.severity)).toEqual([...insights.map((item) => item.severity)].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)));
    const dismissed = appStateSchema.parse({ ...state, dismissedInsights: dismissInsight(state.dismissedInsights, insights[0].id, 1_000) });
    expect(build(dismissed).map((item) => item.id)).not.toContain(insights[0].id);
    expect(importantInsights(insights).every((item) => item.severity !== "low")).toBe(true);
  });

  it("forgets dismissals after half a year and never duplicates them", () => {
    const day = 86_400_000;
    const list = dismissInsight([{ id: "old", at: 0 }, { id: "keep", at: 200 * day }], "keep", 300 * day);
    expect(list).toEqual([{ id: "keep", at: 300 * day }]);
  });

  it("stays quiet without data and without goals", () => {
    expect(build(stateWith([], { savingsGoals: [] }))).toEqual([]);
  });
});
