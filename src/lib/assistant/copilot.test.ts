import { describe, expect, it } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, assistantCardSchema, type AppState, type Transaction } from "@/lib/types";
import { executeTool } from "./agent";
import { detectTool } from "./tools";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"], extra: Partial<Transaction> = {}): Transaction => ({
  id: `k${++counter}`, date, bank: "Raiffeisen", pocket: "Girokonto", description, amount, category, includeInPlan: true, ...extra,
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
const flix = ["05", "06", "07", "08", "09"].map((month, index) => row(`2026-${month}-03`, "Streamflix Abo", index < 4 ? -9.99 : -12.99, "Abonnements"));
const run = (state: AppState, question: string, extra: Record<string, unknown> = {}) => {
  const tool = detectTool(question);
  if (!tool) throw new Error(`no tool for ${question}`);
  const result = executeTool(tool, question, { state, dashboard: calculateDashboard(state), asOf: today, ...extra });
  if (result.card) expect(assistantCardSchema.safeParse(result.card).success).toBe(true);
  return { tool, ...result };
};

describe("copilot routing", () => {
  it("routes contract, context, insight, month-end and trend questions", () => {
    const cases: [string, string][] = [
      ["Welche Abos habe ich?", "contracts"], ["Zeig mir meine Verträge", "contracts"], ["Wann läuft Netflix aus?", "contracts"],
      ["Was kostet mich Spotify im Jahr?", "contracts"], ["Wann ist die Kündigungsfrist für die Kfz-Versicherung?", "contracts"],
      ["Welche Abos laufen bald aus?", "contracts"], ["Was sind meine Abos?", "contracts"],
      ["Was ist mit den angezeigten Buchungen?", "context"], ["Fass die ausgewählten Buchungen zusammen", "context"],
      ["Wie viel ist das in Summe bei diesen Buchungen?", "context"], ["Was siehst du auf dieser Seite?", "context"],
      ["Was fällt dir auf?", "insights"], ["Gibt es Auffälligkeiten?", "insights"], ["Worauf sollte ich achten?", "insights"],
      ["Wie viel kann ich noch ausgeben?", "pulse"], ["Wie viel bleibt am Monatsende?", "pulse"], ["Wie viel ist frei verfügbar?", "pulse"],
      ["Wo gebe ich mehr aus als letzten Monat?", "pulse"],
    ];
    for (const [question, tool] of cases) expect(detectTool(question), question).toBe(tool);
  });

  it("leaves cancelling, past spending, price checks and changes with their tools", () => {
    const cases: [string, string | undefined][] = [
      ["Kündige Netflix", "cancel"], ["Welche Verträge kann ich kündigen?", "cancel"], ["was kosten mich meine abos", "query"],
      ["Wie viel hab ich für Abos ausgegeben?", "query"], ["Welche Abos sind teurer geworden?", "security"],
      ["Markiere die ausgewählten Buchungen als geprüft", "booking"], ["was bleibt mir diesen monat noch", "budget"],
      ["wie viel kann ich im dezember noch ausgeben", "budget"], ["wann kommt mein gehalt", "pulse"],
    ];
    for (const [question, tool] of cases) expect(detectTool(question), question).toBe(tool);
    expect(detectTool("warum hab ich am monatsende immer so wenig geld")).not.toBe("pulse");
  });
});

describe("contracts tool", () => {
  it("lists running subscriptions with monthly and yearly totals and links to the folder", () => {
    const result = run(stateWith(flix), "Welche Abos habe ich?");
    expect(result.text).toMatch(/1 Abo, zusammen 12,99\s€ im Monat \(155,88\s€ im Jahr\)/);
    expect(result.card).toMatchObject({ kind: "contracts", page: { href: "/vertraege" } });
    expect(result.card?.lines[0]).toMatchObject({ label: "Streamflix Abo", value: -12.99 });
  });

  it("answers about one contract: yearly cost, notice deadline or the missing notice", () => {
    const yearly = run(stateWith(flix), "Was kostet mich Streamflix im Jahr?");
    expect(yearly.text).toMatch(/^Streamflix Abo kostet dich 155,88\s€ im Jahr/);
    expect(yearly.text).toMatch(/3,00\s€ teurer/);
    const missing = run(stateWith(flix), "Wann läuft Streamflix aus?");
    expect(missing.text).toMatch(/keine Kündigungsfrist hinterlegt – dazu habe ich keine ausreichenden Daten/);
    const known = run(stateWith(flix, { contracts: [{ id: "streamflix", status: "confirmed", notice: { value: 2, unit: "weeks" }, updatedAt: 1 }] }), "Wann läuft Streamflix aus?");
    expect(known.text).toMatch(/Kündigen bis 20\.10\.2026 \(noch 30 Tage\), dann endet der Vertrag am 3\.11\.2026/);
  });

  it("uses the contract opened in the folder for 'der Vertrag'", () => {
    const result = run(stateWith(flix), "Wann läuft der Vertrag aus?", { page: { route: "/vertraege", title: "Verträge", contractId: "streamflix" } });
    expect(result.card?.title).toBe("Streamflix Abo");
  });

  it("says when there is not enough data and falls back to spending for other names", () => {
    expect(run(stateWith([]), "Welche Abos habe ich?").text).toMatch(/keine ausreichenden Daten/);
    const essen = run(stateWith([row("2026-09-02", "Supermarkt", -40, "Lebensmittel")]), "Was kostet mich Lebensmittel im Jahr?");
    expect(essen.tool).toBe("contracts");
    expect(essen.card?.kind).toBe("answer");
  });
});

describe("context tool", () => {
  const rows = [
    row("2026-09-02", "Pizzeria Roma", -24, "Restaurants"), row("2026-09-03", "Pizzeria Roma", -24, "Restaurants"),
    row("2026-09-05", "Supermarkt", -60, "Lebensmittel"), row("2026-09-06", "Unbekannt 77", -9, "Sonstiges"), row("2026-09-01", "Gehalt", 2500, "Gehalt"),
  ];
  const page = { route: "/umsaetze", title: "Umsätze", month: "2026-09", filters: ["Monat: September 2026"], visibleIds: rows.map((item) => item.id), selectedIds: [rows[2].id] };

  it("summarizes the bookings shown on the page with categories, merchants, duplicates and unclear ones", () => {
    const result = run(stateWith(rows), "Was ist mit den angezeigten Buchungen?", { page });
    expect(result.text).toMatch(/Bei den 5 angezeigten Buchungen \(Monat: September 2026\) sind es 117,00\s€ Ausgaben und 2\.500,00\s€ Eingänge/);
    expect(result.text).toMatch(/Doppelbuchung/);
    expect(result.card?.lines.map((line) => line.label)).toEqual(expect.arrayContaining(["Restaurants", "Möglicherweise doppelt: Pizzeria", "Unklare Kategorie"]));
  });

  it("uses the selection when asked for it", () => {
    const result = run(stateWith(rows), "Fass die ausgewählten Buchungen zusammen", { page });
    expect(result.text).toMatch(/Bei den 1 ausgewählten Buchungen .* 60,00\s€ Ausgaben/);
  });

  it("explains what is missing without a page context", () => {
    expect(run(stateWith(rows), "Fass die ausgewählten Buchungen zusammen").text).toMatch(/keine ausreichenden Daten/);
    expect(run(stateWith(rows), "Was siehst du auf dieser Seite?", { page: { route: "/budget", title: "Budget" } }).text).toMatch(/Auf Budget sehe ich keine Buchungsliste/);
  });
});

describe("insights, trend and month-end answers", () => {
  it("lists the proactive hints with prepared follow-up questions", () => {
    const state = stateWith([...flix, row("2026-09-05", "Supermarkt Nord", -180, "Lebensmittel"), row("2026-09-12", "Supermarkt Süd", -120, "Lebensmittel")]);
    const result = run(state, "Was fällt dir auf?");
    expect(result.text).toMatch(/Punkte? fall/);
    expect(result.card?.lines.some((line) => /Budget überschritten/.test(line.label))).toBe(true);
    expect(result.suggestions?.length).toBeGreaterThan(0);
  });

  it("stays calm when nothing stands out", () => {
    expect(run(stateWith([], { savingsGoals: [] }), "Was fällt dir auf?").text).toMatch(/nichts Dringendes/);
  });

  it("compares categories with the previous month at the same day", () => {
    const state = stateWith([
      row("2026-08-05", "Pizzeria Roma", -20, "Restaurants"), row("2026-08-25", "Pizzeria Roma", -200, "Restaurants"),
      row("2026-09-05", "Pizzeria Roma", -90, "Restaurants"),
    ]);
    const result = run(state, "Wo gebe ich mehr aus als letzten Monat?");
    expect(result.text).toMatch(/Bis zum 20\. gibst du vor allem hier mehr aus als im August 2026 zum gleichen Zeitpunkt: Restaurants \(\+70,00\s€\)/);
  });

  it("answers month-end questions with the forecast or names the missing balance", () => {
    const known = run(stateWith([], { accountSnapshots: [{ bank: "Raiffeisen", name: "Girokonto", date: today, balance: 1200 }] }), "Wie viel bleibt am Monatsende?");
    expect(known.text).toMatch(/^Bis Monatsende sind .+ frei verfügbar/);
    expect(known.card?.lines.some((line) => line.label === "Frei bis Monatsende")).toBe(true);
    expect(known.card?.page?.href).toBe("/");
    expect(run(stateWith([]), "Wie viel bleibt am Monatsende?").text).toMatch(/keine ausreichenden Daten/);
  });
});
