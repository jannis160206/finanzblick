import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import type { AppState, Transaction } from "@/lib/types";
import { amexQuestion, balanceQuestion } from "./accounts";
import { executeTool } from "./agent";
import { findPeriod, queryMetric } from "./answers";
import { checkQuestion } from "./check";
import { forecastQuestion } from "./forecast";
import { detectTool } from "./tools";

const asOf = "2026-11-05";
const row = (id: string, date: string, description: string, amount: number, category: Transaction["category"]): Transaction =>
  ({ id, date, bank: "Raiffeisen", pocket: "Raiffeisen Giro", description, amount, category, includeInPlan: true });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.transactions = [
    row("b1", "2026-11-04", "BILLA", -40, "Lebensmittel"),
    row("b2", "2026-11-05", "BILLA", -25, "Lebensmittel"),
    row("m1", "2026-10-12", "MEDIAMARKT", -300, "Shopping"),
    row("r1", "2026-10-15", "PIZZERIA", -60, "Restaurants"),
  ];
  return state;
}

const ask = (state: AppState, text: string) => {
  const tool = detectTool(text);
  return { tool, ...executeTool(tool!, text, { state, dashboard: calculateDashboard(state), asOf }) };
};

describe("everyday phrasings", () => {
  it("understands heute, gestern and the last N days", () => {
    expect(findPeriod("Was hab ich heute ausgegeben?", asOf)).toMatchObject({ from: asOf, to: asOf });
    expect(findPeriod("Was hab ich gestern ausgegeben?", asOf)).toMatchObject({ from: "2026-11-04", to: "2026-11-04" });
    expect(findPeriod("Ausgaben der letzten 7 Tage", asOf)).toMatchObject({ to: asOf });
  });

  it("picks the right metric", () => {
    expect(queryMetric("Wurde etwas doppelt abgebucht?")).toBe("duplicates");
    expect(queryMetric("Wie viel geht fürs Auto im Monat weg?")).toBe("average");
    expect(queryMetric("War ich sparsamer als letzten Monat?")).toBe("compare");
    expect(queryMetric("Habe ich Preiserhöhungen bei Abos?")).toBe("subscriptions");
    expect(queryMetric("Wofür gebe ich am meisten aus?")).toBe("breakdown");
  });

  it("routes common questions", () => {
    expect(amexQuestion("wie viel muss ich bei der amex zahlen?")).toBe(true);
    expect(balanceQuestion("wie viel hab ich auf trade republic?")).toBe(true);
    expect(balanceQuestion("wie viel hab ich bei revolut ausgegeben?")).toBe(false);
    expect(checkQuestion("wie viel spare ich im monat?")).toBe(true);
    expect(forecastQuestion("wird mein konto im dezember knapp?")).toBe(true);
    expect(detectTool("Welche Zahlungen kommen diese Woche?")).toBe("briefing");
    expect(detectTool("Welche Abbuchungen kommen noch?")).toBe("pulse");
    expect(detectTool("Wie viel Geld geht für Essen drauf?")).toBe("query");
    expect(detectTool("Wie oft war ich bei Billa?")).toBe("query");
  });

  it("answers with the right data", () => {
    const state = fixture();
    expect(ask(state, "Was hab ich gestern ausgegeben?").text).toContain("40,00");
    expect(ask(state, "Wie viel für Lieferando im Oktober?").text).toContain("keine Buchungen");
    expect(ask(state, "Wofür gebe ich am meisten aus?").text).toMatch(/^Am meisten gibst du für Shopping aus/);
    expect(ask(state, "Wie oft war ich bei Billa?").text).toMatch(/2 Buchungen/);
  });
});
