import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard, monthsForYear } from "@/lib/calc";
import { allocateGoals, savingsGoals } from "@/lib/goals";
import { appStateSchema, plannedOneOffSchema, savingsGoalSchema, type AppState, type Transaction } from "@/lib/types";
import { monthlyVariableBudget } from "@/lib/variable-budgets";
import { executeTool, memoryValue, parseMemory, parseRule } from "./agent";
import { answerQuestion, depotProjection, futureValue, parsePeriod, taxDeductibles } from "./answers";
import { applyOperations, OperationError, recordChange, recordCreation, undoChange } from "./operations";
import { detectTool, matchName } from "./tools";

const asOf = "2026-10-07";
const booking = (id: string, date: string, description: string, amount: number, category: Transaction["category"] = "Lebensmittel"): Transaction =>
  ({ id, date, bank: "Raiffeisen", pocket: "Raiffeisen Giro", description, amount, category, includeInPlan: true });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.settings.baselineDate = "2026-09-11";
  state.financeRows = [{ id: "salary", label: "Gehalt", kind: "income", values:
    Object.fromEntries([...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [month, monthlyVariableBudget(month).total + 1000])) }];
  state.savingsGoals = [savingsGoalSchema.parse({ id: "japan", name: "Japan", pocket: "Japan", target: 3000, date: "2027-07-31",
    openingBalance: { date: asOf, amount: 500 }, funding: { monthly: 250, extras: {} } })];
  state.plannedOneOffs = [plannedOneOffSchema.parse({ id: "pickerl", name: "Pickerl", date: "2027-03-01", amount: 400, installments: 1, pocket: "Giro" })];
  state.transactions = [
    booking("spar-1", "2026-10-02", "SPAR DANKT 1234", -42.5),
    booking("spar-2", "2026-10-05", "SPAR DANKT 1234", -17.5),
    booking("billa-1", "2026-09-20", "BILLA DANKT", -30),
    booking("hof-1", "2026-10-03", "MUSTERHOF HOFLADEN", -25, "Sonstiges"),
    booking("hof-2", "2026-09-12", "MUSTERHOF HOFLADEN", -21, "Sonstiges"),
    booking("caritas", "2026-05-02", "CARITAS SPENDE", -50, "Sonstiges"),
  ];
  return state;
}
const context = (state: AppState) => ({ state, dashboard: calculateDashboard(state), asOf });
const valid = (state: AppState) => expect(appStateSchema.safeParse(state).success).toBe(true);

describe("assistant tool detection", () => {
  it("picks the agent tool from plain German", () => {
    expect(detectTool("Mach das rückgängig")).toBe("undo");
    expect(detectTool("Wie viel hab ich im Oktober fürs Essen ausgegeben?")).toBe("query");
    expect(detectTool("Erhöhe Japan auf 4.000 €", ["Japan"])).toBe("edit");
    expect(detectTool("Lieferando ist immer Lieferdienste")).toBe("rule");
    expect(detectTool("Merk dir: Puffer immer 500 €")).toBe("remember");
    expect(detectTool("Vergiss den Puffer")).toBe("forget");
    expect(detectTool("100 € im Monat in einen ETF, was habe ich nach 10 Jahren?")).toBe("depot");
    expect(detectTool("Was kann ich bei der Arbeitnehmerveranlagung absetzen?")).toBe("tax");
    expect(detectTool("Ich will 200 € mehr im Monat sparen.")).toBe("coach");
    expect(detectTool("Ich will bis Juli 2027 3.000 € für Japan sparen")).toBe("savings_goal");
    expect(detectTool("Kann ich mir im Mai einen Fernseher um 900 € leisten?")).toBe("affordability");
  });

  it("matches the longest known name as a whole word", () => {
    expect(matchName("Schieb das Auto Service auf April", ["Auto", "Auto Service"], (name) => name)).toBe("Auto Service");
    expect(matchName("Japanreise buchen", ["Japan"], (name) => name)).toBe("Japan");
    expect(matchName("Schieb das Pickerl", ["Japan"], (name) => name)).toBeUndefined();
  });
});

describe("assistant answers", () => {
  it("reads past periods", () => {
    expect(parsePeriod("im Oktober", asOf)).toMatchObject({ from: "2026-10-01", to: "2026-10-07" });
    expect(parsePeriod("im November", asOf)).toMatchObject({ from: "2025-11-01", to: "2025-11-30" });
    expect(parsePeriod("letzten Monat", asOf)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("answers from bookings and shows where the number comes from", () => {
    const result = answerQuestion(fixture(), "Wie viel hab ich im Oktober für Lebensmittel ausgegeben?", asOf);
    expect(result.card.total).toBe(60);
    expect(result.card.transactionIds).toEqual(expect.arrayContaining(["spar-1", "spar-2"]));
    expect(result.card.transactionIds).not.toContain("billa-1");
  });

  it("projects a depot in three scenarios without advice", () => {
    expect(futureValue(100, 10, 0, 0)).toBe(12_000);
    const { card } = depotProjection(100, 10);
    expect(card.lines.map((line) => line.value)).toEqual([...card.lines.map((line) => line.value)].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(card.note).toMatch(/keine Anlageberatung/i);
  });

  it("collects Austrian deductibles for the year", () => {
    const { card } = taxDeductibles(fixture(), 2026);
    expect(card.lines.some((line) => line.transactionIds?.includes("caritas"))).toBe(true);
  });
});

describe("assistant changes", () => {
  it("previews, applies and undoes a goal change exactly", () => {
    const state = fixture();
    const preview = executeTool("edit", "Erhöhe Japan auf 4.000 €", { ...context(state), hints: { goal: "Japan" } });
    expect(preview.change?.diffs).toEqual(expect.arrayContaining([expect.objectContaining({ after: expect.stringContaining("4.000") })]));
    const applied = applyOperations(state, preview.change!.operations, { asOf });
    const logged = recordChange(applied.state, applied, { id: "log-1", at: 1, title: preview.change!.title });
    valid(logged);
    expect(savingsGoals(logged)[0].target).toBe(4000);
    const reverted = undoChange(logged, "log-1", 2);
    valid(reverted);
    expect(savingsGoals(reverted)[0].target).toBe(3000);
    expect(reverted.assistantChanges?.[0].undoneAt).toBe(2);
    expect(() => undoChange(reverted, "log-1")).toThrow(OperationError);
  });

  it("moves a planned purchase and refuses changes without effect", () => {
    const state = fixture();
    const preview = executeTool("edit", "Schieb das Pickerl auf April", { ...context(state), hints: { planned: "Pickerl" } });
    const applied = applyOperations(state, preview.change!.operations, { asOf });
    expect(applied.state.plannedOneOffs?.[0].date.slice(0, 7)).toBe("2027-04");
    expect(() => applyOperations(state, [{ op: "goal_update", goalId: "japan", target: 3000 }], { asOf })).toThrow(OperationError);
  });

  it("pauses a goal rate for a month", () => {
    const state = fixture();
    const applied = applyOperations(state, [{ op: "goal_pause", goalId: "japan", month: "2026-11" }], { asOf });
    valid(applied.state);
    const goal = savingsGoals(applied.state)[0];
    expect(goal.funding?.paused).toEqual(["2026-11"]);
    expect(allocateGoals(2000, [goal], { japan: 500 }, "2026-11").goals.japan).toBe(0);
    expect(allocateGoals(2000, [goal], { japan: 500 }, "2026-12").goals.japan).toBe(250);
  });

  it("turns a chat rule into a categorize change with learning", () => {
    const state = fixture();
    expect(parseRule("Lieferando ist immer Lieferdienste")).toEqual({ merchant: "Lieferando", category: "Lieferdienste" });
    const result = executeTool("rule", "Musterhof ist immer Lebensmittel", context(state));
    if (!result.change) throw new Error(result.text);
    expect(result.change?.operations[0]).toMatchObject({ op: "categorize", ids: ["hof-1", "hof-2"], learn: true });
    const applied = applyOperations(state, result.change!.operations, { asOf });
    const logged = recordChange(applied.state, applied, { id: "rule", at: 1, title: "Regel" });
    valid(logged);
    const reverted = undoChange(logged, "rule", 2);
    expect(reverted.transactions.find((row) => row.id === "hof-1")?.category).toBe("Sonstiges");
  });

  it("remembers a buffer and a salary day, and forgets them again", () => {
    expect(parseMemory("Merk dir: Puffer immer 500 €")).toMatchObject({ key: "buffer", value: 500 });
    expect(parseMemory("Mein Gehalt kommt am 25.")).toMatchObject({ key: "salaryDay", value: 25 });
    const state = fixture();
    const applied = applyOperations(state, [parseMemory("Merk dir: Puffer immer 500 €")!], { asOf, now: 5 });
    const logged = recordChange(applied.state, applied, { id: "mem", at: 5, title: "Merken" });
    valid(logged);
    expect(memoryValue(logged, "buffer")).toBe(500);
    const forget = executeTool("forget", "Vergiss den Puffer", context(logged));
    expect(applyOperations(logged, forget.change!.operations, { asOf }).state.assistantMemory).toEqual([]);
  });

  it("logs chat-created goals so they can be undone", () => {
    const state = fixture();
    const goal = savingsGoalSchema.parse({ id: "auto", name: "Auto", pocket: "Auto", target: 2000, date: "2027-12-31" });
    const after = recordCreation(state, { ...state, savingsGoals: [...savingsGoals(state), goal] }, { kind: "goal", itemId: "auto", summary: "Auto" },
      { id: "create", at: 1, title: "Sparziel „Auto“ angelegt" });
    valid(after);
    expect(savingsGoals(undoChange(after, "create")).map((item) => item.id)).toEqual(["japan"]);
  });

  it("offers to undo the last change", () => {
    const state = fixture();
    const applied = applyOperations(state, [{ op: "setting", key: "emergencyTarget", value: 9000 }], { asOf });
    const logged = recordChange(applied.state, applied, { id: "set", at: 1, title: "Notgroschen" });
    expect(executeTool("undo", "Mach das rückgängig", context(logged)).undoId).toBe("set");
  });
});
