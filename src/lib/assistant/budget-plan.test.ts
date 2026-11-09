import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { appStateSchema, type AppState } from "@/lib/types";
import { monthlyVariableBudget } from "@/lib/variable-budgets";
import { parseBudgetPlan } from "./budget-plan";
import { applyOperations, recordChange, undoChange } from "./operations";
import { detectTool } from "./tools";

const asOf = "2026-11-08";

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.settings.baselineDate = "2026-09-11";
  return state;
}

function plan(state: AppState, text: string) {
  const result = parseBudgetPlan(state, text, asOf);
  if (!("operations" in result)) throw new Error(`no change: ${result.text}`);
  return result.operations;
}

describe("budget plan changes", () => {
  it("recognises budget changes in everyday wording", () => {
    for (const text of [
      "Plan für Lebensmittel & Haushalt um 295 € erhöhen",
      "Tankbudget auf 200 setzen",
      "Budget für Tanken senken um 30 €",
      "mach das spritbudget 220",
      "gib mir 100 mehr fürs essen gehen im monat",
      "60 € von Freizeit zu Restaurants umschichten",
    ]) expect(detectTool(text), text).toBe("budget_plan");
    expect(detectTool("Erhöhe Japan auf 4000", ["Japan"])).toBe("edit");
    expect(detectTool("Puffer immer 300 €")).not.toBe("budget_plan");
    expect(detectTool("Wie hoch ist mein Tankbudget?")).not.toBe("budget_plan");
  });

  it("raises, sets and lowers a line", () => {
    const state = fixture();
    expect(plan(state, "Plan für Lebensmittel & Haushalt um 295 € erhöhen")).toEqual([{ op: "budget_plan", line: "food", adjustment: 295 }]);
    expect(plan(state, "Tankbudget auf 200 setzen")).toEqual([{ op: "budget_plan", line: "fuel", adjustment: 20 }]);
    expect(plan(state, "Budget für Tanken senken um 30 €")).toEqual([{ op: "budget_plan", line: "fuel", adjustment: -30 }]);
  });

  it("refuses to move more than a line has and asks back when the amount is missing", () => {
    const state = fixture();
    expect("text" in parseBudgetPlan(state, "60 € von Freizeit zu Restaurants umschichten", asOf)).toBe(true);
    expect("text" in parseBudgetPlan(state, "Lebensmittelbudget erhöhen", asOf)).toBe(true);
  });

  it("applies every month from now on and undoes cleanly", () => {
    const state = fixture();
    const before = monthlyVariableBudget("2026-12").rows.find((row) => row.id === "food")!.total;
    const applied = applyOperations(state, plan(state, "Plan für Lebensmittel um 50 € erhöhen"), { asOf });
    expect(applied.state.budgetAdjustments).toEqual({ food: 50 });
    const after = monthlyVariableBudget("2026-12", undefined, applied.state.budgetAdjustments).rows.find((row) => row.id === "food")!.total;
    expect(after).toBe(before + 50);
    const logged = recordChange(state, applied, { id: "b1", at: 1, title: "x" });
    expect(appStateSchema.safeParse(logged).success).toBe(true);
    expect(undoChange(logged, "b1").budgetAdjustments?.food).toBeUndefined();
  });
});
