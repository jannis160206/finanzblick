import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type FinanceRow, type Transaction } from "@/lib/types";
import { variableBudgetLines } from "@/lib/variable-budgets";
import { budgetSuggestions } from "./budget-suggestions";

let counter = 0;
const row = (date: string, amount: number, category: Transaction["category"], extra: Partial<Transaction> = {}): Transaction => ({
  id: `b${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description: `Händler ${category} ${counter}`,
  amount, category, includeInPlan: true, categoryOverride: true, manualCategory: true, ...extra,
});
const months = ["2026-06", "2026-07", "2026-08"];
const plans: Record<string, number> = { food: 250, "going-out": 250 };
const rows = (overrides: Record<string, number> = {}): FinanceRow[] => variableBudgetLines.map((line) => ({
  id: `budget-${line.id}`, label: line.label, kind: "variable",
  values: Object.fromEntries(months.map((month) => [month, overrides[line.id] ?? plans[line.id] ?? 0])),
}));
const stateWith = (transactions: Transaction[], financeRows = rows()): AppState => {
  const seed = createSeed();
  return appStateSchema.parse({
    ...seed, settings: { ...seed.settings, asOf: "2026-09-20", baselineDate: "2026-06-01" }, transactions, financeRows,
    merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [], ignoredStatementKeys: [], pocketSnapshots: [],
    accountSnapshots: [], reviewQueue: [], holidayRanges: [], plannedOneOffs: [],
  });
};
const monthly = (amounts: { restaurant: number[]; food: number[] }) => months.flatMap((month, index) => [
  row(`${month}-10`, -amounts.restaurant[index], "Restaurants"),
  row(`${month}-12`, -amounts.food[index], "Lebensmittel"),
]);

describe("budgetSuggestions", () => {
  it("moves money from a line under plan to a line over plan for three months", () => {
    const state = stateWith(monthly({ restaurant: [290, 300, 286], food: [190, 185, 195] }));
    const [suggestion, ...rest] = budgetSuggestions(state, "2026-09-20");
    expect(rest).toEqual([]);
    expect(suggestion).toMatchObject({
      id: "budget-move-going-out-food", amount: 40,
      title: "40 € von Lebensmittel & Haushalt zu Restaurants & Lieferdienste umschichten",
      over: { budgetId: "going-out", label: "Restaurants & Lieferdienste", average: 292, plan: 250 },
      under: { budgetId: "food", label: "Lebensmittel & Haushalt", average: 190, plan: 250 },
    });
    expect(suggestion.text).toBe("Restaurants & Lieferdienste lag 3 Monate über Plan (Ø +42 €), " +
      "Lebensmittel & Haushalt darunter (Ø −60 €) → 40 € umschichten?");
  });

  it("caps the move at the donor's headroom", () => {
    const state = stateWith(monthly({ restaurant: [400, 400, 400], food: [230, 228, 232] }));
    expect(budgetSuggestions(state, "2026-09-20")[0]).toMatchObject({ amount: 20, under: { budgetId: "food" } });
  });

  it("suggests raising the plan without a line under plan", () => {
    const state = stateWith(monthly({ restaurant: [290, 300, 286], food: [260, 240, 255] }));
    const suggestions = budgetSuggestions(state, "2026-09-20");
    expect(suggestions).toEqual([expect.objectContaining({
      id: "budget-raise-going-out", amount: 40,
      text: "Restaurants & Lieferdienste lag 3 Monate über Plan (Ø +42 €) → Plan um 40 € erhöhen?",
    })]);
    expect(suggestions[0].under).toBeUndefined();
  });

  it("ignores lines that were over plan only in some months", () => {
    const state = stateWith(monthly({ restaurant: [290, 200, 286], food: [190, 185, 195] }));
    expect(budgetSuggestions(state, "2026-09-20")).toEqual([]);
  });

  it("excludes ignored bookings and transfers like the dashboard", () => {
    const transactions = monthly({ restaurant: [240, 240, 240], food: [190, 185, 195] });
    transactions.push(...months.map((month) => row(`${month}-15`, -100, "Restaurants", { ignored: true })));
    expect(budgetSuggestions(stateWith(transactions), "2026-09-20")).toEqual([]);
  });

  it("only uses full months before asOf and needs data in each of them", () => {
    const transactions = monthly({ restaurant: [290, 300, 286], food: [190, 185, 195] });
    expect(budgetSuggestions(stateWith(transactions.slice(2)), "2026-09-20")).toEqual([]);
    transactions.push(row("2026-09-05", -900, "Lebensmittel"));
    expect(budgetSuggestions(stateWith(transactions), "2026-09-20")[0]).toMatchObject({ amount: 40 });
  });
});
