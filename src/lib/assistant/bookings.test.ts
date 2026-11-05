import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard, monthsForYear } from "@/lib/calc";
import { appStateSchema, plannedOneOffSchema, savingsGoalSchema, type AppState, type AssistantOperation, type Transaction } from "@/lib/types";
import { monthlyVariableBudget } from "@/lib/variable-budgets";
import { executeTool } from "./agent";
import { bookingRequest, renameRequest } from "./bookings";
import { applyOperations, recordChange, undoChange } from "./operations";
import { detectTool, splitCommands } from "./tools";

const asOf = "2026-11-05";
const booking = (id: string, date: string, description: string, amount: number, extra: Partial<Transaction> = {}): Transaction =>
  ({ id, date, bank: "Raiffeisen", pocket: "Raiffeisen Giro", description, amount, category: "Lebensmittel", includeInPlan: true, ...extra });

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
    booking("billa-1", "2026-11-03", "BILLA DANKT 1234", -30),
    booking("billa-2", "2026-10-20", "BILLA DANKT 1234", -12.4, { merchantAlias: "Billa Alt" }),
    booking("netflix-1", "2026-10-15", "NETFLIX.COM", -13.99, { category: "Abonnements" }),
    booking("netflix-2", "2026-09-15", "NETFLIX.COM", -13.99, { category: "Abonnements" }),
  ];
  return state;
}
const context = (state: AppState) => ({ state, dashboard: calculateDashboard(state), asOf });
const names = ["Japan", "Pickerl"];

describe("booking edits", () => {
  it("routes booking commands without hijacking other tools", () => {
    expect(detectTool("Benenne BILLA DANKT in Billa um")).toBe("booking");
    expect(detectTool("Netflix ist Fixkosten")).toBe("booking");
    expect(detectTool("Nimm die Buchung vom 3.11. aus dem Plan")).toBe("booking");
    expect(detectTool("Markier alle Billa-Buchungen als geprüft")).toBe("booking");
    expect(detectTool("Wie viel Fixkosten habe ich?")).not.toBe("booking");
    expect(detectTool("Was kann ich alles bearbeiten?")).toBe("help");
    expect(detectTool("Lieferando ist immer Lieferdienste")).toBe("rule");
    expect(detectTool("Benenne Japan in Asien um", names)).toBe("edit");
    expect(bookingRequest("Nenn mir die Ausgaben in Oktober", false)).toBe(false);
    expect(renameRequest("Netflix soll Streaming heißen")).toEqual({ target: "Netflix", alias: "Streaming" });
  });

  it("renames bookings and undoes back to the old alias or none", () => {
    const state = fixture();
    const result = executeTool("booking", "Benenne BILLA DANKT in Billa um", context(state));
    expect(result.change?.operations).toEqual([{ op: "transaction_update", ids: ["billa-1", "billa-2"], alias: "Billa" }]);
    const applied = applyOperations(state, result.change!.operations, { asOf });
    expect(applied.state.transactions.filter((row) => row.id.startsWith("billa")).every((row) => row.merchantAlias === "Billa")).toBe(true);
    const logged = recordChange(state, applied, { id: "c1", at: 1, title: "x" });
    expect(appStateSchema.safeParse(logged).success).toBe(true);
    const undone = undoChange(logged, "c1");
    expect(undone.transactions.find((row) => row.id === "billa-1")?.merchantAlias).toBeUndefined();
    expect(undone.transactions.find((row) => row.id === "billa-1")?.merchantNameConfirmed).toBeUndefined();
    expect(undone.transactions.find((row) => row.id === "billa-2")?.merchantAlias).toBe("Billa Alt");
  });

  it("filters by date, toggles plan, fixed costs and reviewed", () => {
    const state = fixture();
    const plan = executeTool("booking", "Nimm die Buchung vom 3.11. aus dem Plan", context(state));
    expect(plan.change?.operations).toEqual([{ op: "transaction_update", ids: ["billa-1"], includeInPlan: false }]);
    const fixed = executeTool("booking", "Netflix ist Fixkosten", context(state));
    expect(fixed.change?.operations).toEqual([{ op: "transaction_update", ids: ["netflix-1", "netflix-2"], fixedCost: true }]);
    expect(fixed.card).toMatchObject({ kind: "answer", total: -27.98 });
    const reviewed = executeTool("booking", "Markier alle Billa-Buchungen als geprüft", context(state));
    expect(reviewed.change?.operations[0]).toMatchObject({ reviewed: true, ids: ["billa-1", "billa-2"] });
    const applied = applyOperations(state, [...plan.change!.operations, ...fixed.change!.operations], { asOf });
    const undone = undoChange(recordChange(state, applied, { id: "c2", at: 1, title: "x" }), "c2");
    expect(undone.transactions.map((row) => [row.includeInPlan, row.fixedCost])).toEqual(state.transactions.map((row) => [row.includeInPlan, row.fixedCost]));
    expect(executeTool("booking", "Nimm die Buchung vom 4.11. aus dem Plan", context(state)).text).toContain("keine Buchung");
  });
});

describe("planned pocket and sharing", () => {
  it("pays a planned expense from the savings account and shares it", () => {
    const state = fixture();
    expect(detectTool("Zahl das Pickerl vom Sparkonto", names)).toBe("edit");
    const pocket = executeTool("edit", "Zahl das Pickerl vom Sparkonto", context(state));
    expect(pocket.change?.operations).toEqual([{ op: "planned_update", plannedId: "pickerl", pocket: "Sparkonto" }]);
    const shared = executeTool("edit", "Teil das Pickerl mit Raphael", context(state));
    expect(shared.change?.operations).toEqual([{ op: "planned_update", plannedId: "pickerl", shared: true }]);
    const applied = applyOperations(state, [...pocket.change!.operations, ...shared.change!.operations], { asOf });
    expect(applied.state.plannedOneOffs?.[0]).toMatchObject({ pocket: "Sparkonto", sharedWithRaphael: true });
    expect(undoChange(recordChange(state, applied, { id: "c3", at: 1, title: "x" }), "c3").plannedOneOffs?.[0]).toEqual(state.plannedOneOffs?.[0]);
  });
});

describe("several commands at once", () => {
  it("splits and carries the name over", () => {
    expect(splitCommands("Erhöhe Japan auf 4.000 € und schieb es auf August 2027", names)).toEqual(["Erhöhe Japan auf 4.000 €", "schieb es auf August 2027 Japan"]);
    expect(splitCommands("Ich will bis Dezember 2027 2.000 € für ein Auto sparen, die ersten 2 Monate je 60 € vom Sparkonto", names)).toBeUndefined();
    expect(splitCommands("Lieferando und Foodora sind immer Lieferdienste", names)).toBeUndefined();
    expect(splitCommands("Nimm die Buchung vom 3.11. aus dem Plan", names)).toBeUndefined();
    expect(detectTool("Erhöhe Japan auf 4.000 € und schieb das Pickerl auf April 2027", names)).toBe("batch");
  });

  it("combines all changes into one preview", () => {
    const state = fixture();
    const result = executeTool("batch", "Erhöhe Japan auf 4.000 € und schieb das Pickerl auf April 2027. Netflix ist Fixkosten", context(state));
    const ops = result.change?.operations.map((operation: AssistantOperation) => operation.op);
    expect(ops).toEqual(["goal_update", "planned_update", "transaction_update"]);
    expect(result.change?.title).toMatch(/^3 Änderungen/);
    const failing = executeTool("batch", "Erhöhe Japan auf 4.000 € und benenne Gibtsnicht in Foo um", context(state));
    expect(failing.change).toBeUndefined();
  });
});
