import { describe, expect, it } from "vitest";
import { calculateDashboard, type Dashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, assistantCardSchema, type AppState, type Transaction } from "@/lib/types";
import { budgetPace, pulseAnswer, pulseQuestion, salaryStatus } from "./pulse";
import { detectTool } from "./tools";
import { emptySeen, findAlerts } from "./watch";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"]): Transaction => ({
  id: `p${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description, amount, category, includeInPlan: true,
});
const stateWith = (transactions: Transaction[], extra: Partial<AppState> = {}): AppState => appStateSchema.parse({
  ...createSeed(), transactions, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
  ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [], ...extra,
});
const withRows = (dashboard: Dashboard, rows: Array<{ id: string; label: string; total: number; actual: number }>): Dashboard =>
  ({ ...dashboard, plan: { ...dashboard.plan, rows: rows.map((item) => ({ ...dashboard.plan.rows[0], ...item })) as Dashboard["plan"]["rows"] } });

describe("Monats-Puls", () => {
  it("routes daily budget, salary and pace questions without stealing budget or forecast", () => {
    for (const text of ["Wie viel kann ich heute noch ausgeben?", "Was darf ich pro Tag noch ausgeben", "Tagesbudget", "Ist mein Gehalt schon da?",
      "wann kommt mein gehalt", "Bin ich diesen Monat im Budget?", "wie läuft mein monat", "Wo gebe ich diesen Monat mehr aus als sonst?",
      "reicht mein geld bis zum gehalt", "welche fixkosten kommen noch"]) {
      expect(pulseQuestion(text.toLowerCase()), text).toBe(true);
      expect(detectTool(text), text).toBe("pulse");
    }
    expect(detectTool("was bleibt mir diesen monat noch")).toBe("budget");
    expect(detectTool("Wird mein Konto knapp?")).toBe("forecast");
    expect(detectTool("reicht mein geld bis jänner")).toBe("forecast");
  });

  it("rates budget pace by the share of the month that has passed", () => {
    const dashboard = withRows(calculateDashboard(stateWith([])), [
      { id: "food", label: "Lebensmittel", total: 300, actual: 320 },
      { id: "fuel", label: "Tanken", total: 100, actual: 90 },
      { id: "fun", label: "Freizeit", total: 200, actual: 60 },
    ]);
    expect(budgetPace(dashboard, "2026-09-10").map((item) => item.status)).toEqual(["over", "ahead", "ok"]);
  });

  it("knows whether this month's salary arrived and when the next one is due", () => {
    const history = [6, 7, 8].map((month) => row(`2026-0${month}-25`, "Arbeitgeber GmbH", 2400, "Gehalt"));
    expect(salaryStatus(stateWith(history), "2026-09-28")).toMatchObject({ received: 0, expected: "2026-09-25", late: true });
    const paid = salaryStatus(stateWith([...history, row("2026-09-25", "Arbeitgeber GmbH", 2400, "Gehalt")]), "2026-09-28");
    expect(paid).toMatchObject({ received: 2400, date: "2026-09-25", expected: "2026-10-25", late: false });
  });

  it("answers with a valid card", () => {
    const state = stateWith([row("2026-09-02", "Supermarkt", -45, "Lebensmittel"), row("2026-08-25", "Arbeitgeber GmbH", 2400, "Gehalt")]);
    const result = pulseAnswer(state, calculateDashboard(state), "2026-09-10");
    expect(assistantCardSchema.safeParse(result.card).success).toBe(true);
    expect(result.card.title).toBe("Monats-Puls");
    expect(result.text.length).toBeGreaterThan(10);
  });

  it("warns once in the background when a budget runs out", () => {
    const state = stateWith([]);
    const dashboard = withRows(calculateDashboard(state), [
      { id: "food", label: "Lebensmittel", total: 300, actual: 320 },
      { id: "fun", label: "Freizeit", total: 200, actual: 185 },
      { id: "fuel", label: "Tanken", total: 100, actual: 20 },
    ]);
    const budget = findAlerts(state, dashboard, "2026-09-10", emptySeen()).filter((alert) => alert.kind === "budget");
    expect(budget.map((alert) => alert.key)).toEqual(["budget:2026-09:food:over", "budget:2026-09:fun:near"]);
    expect(budget[0].tone).toBe("bad");
  });
});
