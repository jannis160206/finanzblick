import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { currency } from "@/lib/format";
import type { AppState, Transaction } from "@/lib/types";
import { executeTool } from "./agent";
import { compareSelection, queryMetric } from "./answers";
import { resolveFollowUp } from "./followup";
import { detectTool } from "./tools";

const asOf = "2026-11-05";
const row = (id: string, date: string, description: string, amount: number, category: Transaction["category"]): Transaction =>
  ({ id, date, bank: "Raiffeisen", pocket: "Raiffeisen Giro", description, amount, category, includeInPlan: true });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.transactions = [];
  const spend: Record<string, [number, number]> = { "2026-05": [100, 200], "2026-06": [120, 200], "2026-07": [80, 200],
    "2026-08": [100, 300], "2026-09": [150, 300], "2026-10": [130, 900] };
  for (const [month, [food, shopping]] of Object.entries(spend)) {
    state.transactions.push(row(`g${month}`, `${month}-25`, "GEHALT", 2000, "Gehalt"));
    state.transactions.push(row(`f${month}`, `${month}-05`, "BILLA", -food, "Lebensmittel"));
    state.transactions.push(row(`s${month}`, `${month}-12`, "MEDIAMARKT", -shopping, "Shopping"));
  }
  state.transactions.push(row("now", "2026-11-03", "BILLA", -999, "Lebensmittel"));
  return state;
}

function chat(state: AppState, texts: string[]) {
  const dashboard = calculateDashboard(state);
  const users: string[] = [];
  return texts.map((text) => {
    const follow = resolveFollowUp(text, users);
    const tool = follow?.tool ?? detectTool(text);
    users.push(text);
    return { tool, ...executeTool(tool!, text, { state, dashboard, asOf, previous: follow?.previous }) };
  });
}

describe("Finanz-Check", () => {
  it("routes casual health questions to the check", () => {
    for (const text of ["Bin ich eher sparsam oder gebe ich viel aus?", "Wie stehe ich finanziell da?", "Mach mal einen Finanz-Check",
      "Wie gut wirtschafte ich?", "Wie hoch ist meine Sparquote?", "gebe ich zu viel aus", "Bin ich reich?"])
      expect(detectTool(text), text).toBe("check");
  });

  it("rates savings rate and spending trend from the last three full months", () => {
    const [check] = chat(fixture(), ["Bin ich sparsam?"]);
    expect(check.card?.kind).toBe("check");
    const lines = check.card!.lines;
    const rate = lines.find((line) => line.label === "Sparquote")!;
    // Aug–Okt: Einnahmen 2000, Ausgaben (400 + 450 + 1030) / 3 = 626,67 → 69 % Sparquote.
    expect(rate.value).toBeCloseTo(1373.33, 2);
    expect(rate.tone).toBe("good");
    expect(rate.detail).toContain("69 %");
    expect(lines.find((line) => line.label === "Ausgaben im Schnitt")!.value).toBeCloseTo(626.67, 2);
    const october = lines.find((line) => line.label.startsWith("Ausgaben Oktober"))!;
    expect(october.value).toBe(1030);
    expect(october.tone).toBe("warn");
    expect(check.text).toMatch(/Punkten sind im grünen Bereich/);
  });

  it("asks for data when nothing is imported", () => {
    const state = createEmptyAccountState();
    state.transactions = [];
    const [check] = chat(state, ["Wie stehe ich finanziell da?"]);
    expect(check.card).toBeUndefined();
    expect(check.text).toMatch(/Importiere/);
  });
});

describe("Ausgabenverlauf", () => {
  it("detects trend questions", () => {
    expect(queryMetric("Wie haben sich meine Ausgaben entwickelt?")).toBe("trend");
    expect(queryMetric("Was sind meine größten Kostenfresser?")).toBe("breakdown");
    expect(queryMetric("What is my biggest expense?")).toBe("largest");
    expect(detectTool("What is my biggest expense?")).toBe("query");
    expect(queryMetric("Hab ich diesen Monat mehr ausgegeben als letzten?")).toBe("compare");
    expect(compareSelection("Hab ich diesen Monat mehr ausgegeben als letzten?", "2026-11-11", []).map((period) => period.month)).toEqual(["2026-11", "2026-10"]);
    expect(detectTool("Wie haben sich meine Ausgaben entwickelt?")).toBe("query");
    expect(detectTool("Zeig mir den Verlauf meiner Ausgaben für Essen")).toBe("query");
  });

  it("names the contracts found in the bookings when no fixed costs are planned", () => {
    const state = fixture();
    for (const month of ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]) state.transactions.push(row(`n${month}`, `${month}-15`, "NETFLIX.COM", -13.99, "Abonnements"));
    const [answer] = chat(state, ["Welche Fixkosten hab ich?"]);
    expect(answer.text).toMatch(/^In deinem Plan sind für diesen Monat keine Fixkosten eingetragen\. Aus deinen Buchungen erkenne ich .+ mit zusammen .+ im Monat\.$/);
    expect(answer.card?.page?.href).toBe("/vertraege");
  });

  it("lists six full months and keeps the trend for follow-ups", () => {
    const [trend, food, three] = chat(fixture(), ["Wie haben sich meine Ausgaben entwickelt?", "und für Lebensmittel?", "und in den letzten 3 Monaten?"]);
    expect(trend.card!.lines.map((line) => line.label)).toEqual(["Mai 2026", "Juni 2026", "Juli 2026", "August 2026", "September 2026", "Oktober 2026"]);
    expect(trend.card!.lines.at(-1)!.value).toBe(1030);
    expect(trend.card!.lines.at(-1)!.tone).toBe("warn");
    expect(trend.card!.total).toBe(Math.round((300 + 320 + 280 + 400 + 450 + 1030) / 6 * 100) / 100);
    expect(trend.text).toContain(`Oktober 2026 (${currency(1030)})`);
    expect(trend.text).toMatch(/gestiegen/);
    expect(food.tool).toBe("query");
    expect(food.card!.lines.map((line) => line.value)).toEqual([100, 120, 80, 100, 150, 130]);
    expect(three.card!.lines).toHaveLength(3);
  });
});
