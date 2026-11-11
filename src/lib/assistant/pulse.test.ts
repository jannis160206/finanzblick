import { describe, expect, it } from "vitest";
import { calculateDashboard, type Dashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, assistantCardSchema, type AppState, type Transaction } from "@/lib/types";
import { conversationRoute } from "./conversation";
import { budgetLineAnswer, budgetPace, pulseAnswer, pulseQuestion, salaryStatus } from "./pulse";
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
      "reicht mein geld bis zum gehalt", "welche fixkosten kommen noch", "Was kann ich bis Sonntag noch ausgeben?",
      "Komm ich bis zum Monatsende mit meinem Geld aus?", "Wie viel bleibt mir pro Tag bis zum Gehalt?"]) {
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

  it("answers whether to raise or lower one budget line from its pace instead of opening an edit", () => {
    const question = "Sollte ich das Lebensmittelbudget erhöhen?";
    expect(conversationRoute({ text: question, tool: "budget_plan", ruleTool: "budget_plan", numbers: [], pending: false }))
      .toEqual({ tool: "budget", converse: false, skipDraft: false });
    const dashboard = (food: number) => withRows(calculateDashboard(stateWith([])), [{ id: "food", label: "Lebensmittel & Haushalt", total: 300, actual: food }]);
    const fast = budgetLineAnswer(dashboard(240), "2026-09-15", question);
    expect(fast?.text).toMatch(/^Ja, eher schon\. Für Lebensmittel & Haushalt sind 300,00\s€ im Monat geplant, bisher hast du 240,00\s€ ausgegeben – bei diesem Tempo landest du bei etwa 480,00\s€/);
    expect(fast?.suggestions?.[0]).toBe("Budget Lebensmittel & Haushalt auf 480 € setzen");
    expect(budgetLineAnswer(dashboard(100), "2026-09-15", question)?.text).toMatch(/^Nein, eher nicht\. .* gut aus\.$/);
    expect(budgetLineAnswer(dashboard(60), "2026-09-15", "Sollte ich das Lebensmittelbudget senken?")?.text).toMatch(/^Ja, das geht wohl\./);
    expect(budgetLineAnswer(dashboard(20), "2026-09-03", question)?.text).toMatch(/^Dafür ist es noch zu früh im Monat\./);
    expect(budgetLineAnswer(dashboard(240), "2026-09-15", "Wie hoch ist mein Lebensmittelbudget?")).toBeUndefined();
  });

  it("knows whether this month's salary arrived and when the next one is due", () => {
    const history = [6, 7, 8].map((month) => row(`2026-0${month}-25`, "Arbeitgeber GmbH", 2400, "Gehalt"));
    expect(salaryStatus(stateWith(history), "2026-09-28")).toMatchObject({ received: 0, expected: "2026-09-25", late: true });
    const paid = salaryStatus(stateWith([...history, row("2026-09-25", "Arbeitgeber GmbH", 2400, "Gehalt")]), "2026-09-28");
    expect(paid).toMatchObject({ received: 2400, date: "2026-09-25", expected: "2026-10-25", late: false });
  });

  it("leads with what was asked: salary, week, enough until payday, budget status, fixed costs", () => {
    const state = stateWith([...[6, 7, 8].map((month) => row(`2026-0${month}-25`, "Arbeitgeber GmbH", 2400, "Gehalt")), row("2026-09-02", "Supermarkt", -45, "Lebensmittel")]);
    const dashboard = calculateDashboard(state);
    const ask = (question: string) => pulseAnswer(state, dashboard, "2026-09-10", question).text;
    expect(ask("Wann kommt mein Gehalt?")).toMatch(/^Gehalt kommt voraussichtlich am 25\.9\.2026 – noch 15 Tage\./);
    expect(ask("Wie viel darf ich diese Woche noch ausgeben?")).toMatch(/^Diese Woche kannst du noch rund .+ pro Tag für 4 Tage bis Sonntag\./);
    expect(ask("Reicht mein Geld bis zum nächsten Gehalt?")).toMatch(/^(?:Ja, das reicht|Knapp)/);
    expect(ask("Bin ich im Budget?")).toMatch(/^(?:Ja, alle Budgets liegen im Plan|Noch ja|Nicht ganz)/);
    expect(ask("Welche Fixkosten kommen noch?")).toMatch(/^(?:Diesen Monat sind keine Fixkosten mehr offen|Noch abgebucht werden)/);
  });

  it("answers about one budget line without changing it", () => {
    const dashboard = withRows(calculateDashboard(stateWith([])), [{ id: "food", label: "Lebensmittel & Haushalt", total: 300, actual: 100 }]);
    expect(budgetLineAnswer(dashboard, "2026-09-15", "Wie steht mein Lebensmittelbudget?")?.text)
      .toBe("Für Lebensmittel & Haushalt sind 300,00\u00a0€ im Monat geplant, bisher sind 100,00\u00a0€ weg – noch 200,00\u00a0€ für die restlichen 16 Tage. Das liegt im Plan.");
    expect(detectTool("Wie steht mein Lebensmittelbudget?")).toBe("budget");
    expect(detectTool("Wie viel Puffer hab ich?")).toBe("budget");
    expect(detectTool("Lebensmittelbudget auf 300")).toBe("budget_plan");
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
