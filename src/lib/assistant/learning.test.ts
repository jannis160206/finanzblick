import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { appStateSchema, plannedOneOffSchema, savingsGoalSchema, type AppState } from "@/lib/types";
import { executeTool } from "./agent";
import { knowledgeList, learnPhrase, matchPhrase } from "./knowledge";
import { aliasTeaching, applyAliases, correction, countAliases, learnAlias, openGaps, pickName, recordGap, rephrases, resolveGap, unknownTarget, unlearnPhrase } from "./learning";
import { detectTool } from "./tools";

const asOf = "2026-10-07";
function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.settings.baselineDate = "2026-09-11";
  state.savingsGoals = [
    savingsGoalSchema.parse({ id: "motorrad", name: "Motorrad", pocket: "Motorrad", target: 3000, date: "2027-07-31", funding: { monthly: 100, extras: {} } }),
    savingsGoalSchema.parse({ id: "schrank", name: "Schrank", pocket: "Schrank", target: 800, date: "2027-03-31", funding: { monthly: 50, extras: {} } }),
  ];
  state.plannedOneOffs = [plannedOneOffSchema.parse({ id: "pickerl", name: "Pickerl", date: "2027-03-01", amount: 400, installments: 1, pocket: "Giro" })];
  return state;
}
const context = (state: AppState) => ({ state, dashboard: calculateDashboard(state), asOf });

describe("corrections", () => {
  it("extracts what was meant", () => {
    expect(correction("Nein, ich meinte meine Ausgaben im Oktober")).toEqual({ text: "meine Ausgaben im Oktober" });
    expect(correction("Ich meinte eigentlich das Pickerl")).toEqual({ text: "das Pickerl" });
    expect(correction("falsch, ich wollte wissen wie viel ich für Essen ausgebe")).toEqual({ text: "wie viel ich für Essen ausgebe" });
  });
  it("treats a plain no as negative feedback", () => {
    expect(correction("Nein, das meinte ich nicht")).toEqual({ text: "" });
    expect(correction("Das war falsch")).toEqual({ text: "" });
    expect(correction("Du hast mich falsch verstanden")).toEqual({ text: "" });
  });
  it("leaves ordinary messages alone", () => {
    expect(correction("Wie viel hab ich im Oktober fürs Essen ausgegeben?")).toBeUndefined();
  });
});

describe("rephrasing after an unclear message", () => {
  it("learns only a real rephrasing, never the next topic", () => {
    expect(rephrases("wv hab ich fuer essen ausgegeben letzten monat", "Wie viel hab ich letzten Monat für Essen ausgegeben?")).toBe(true);
    expect(rephrases("Was kostet mich das Fitnessstudio", "Wie teuer ist mein Fitnessvertrag?")).toBe(true);
    expect(rephrases("Kann man mit 3000 netto in Wien gut leben?", "Was ist ein ETF?")).toBe(false);
  });
});

describe("own words", () => {
  it("learns explicit aliases", () => {
    expect(aliasTeaching("Mit Japan meine ich Motorrad")).toEqual({ from: "Japan", to: "Motorrad" });
    expect(aliasTeaching("Wenn ich Urlaub sage, meine ich das Motorrad")).toEqual({ from: "Urlaub", to: "Motorrad" });
    expect(aliasTeaching("Unter Kasten verstehe ich den Schrank")).toEqual({ from: "Kasten", to: "Schrank" });
    expect(aliasTeaching("Bike ist bei mir dasselbe wie Motorrad")).toEqual({ from: "Bike", to: "Motorrad" });
    expect(aliasTeaching("Mit 500 meine ich Motorrad")).toBeUndefined();
    expect(aliasTeaching("Erhöhe Motorrad auf 4.000 €")).toBeUndefined();
  });
  it("replaces whole words only and counts uses", () => {
    const aliases = learnAlias([], "Japan", "Motorrad", 1);
    const result = applyAliases(aliases, "Erhöhe Japan auf 4.000 €");
    expect(result).toEqual({ text: "Erhöhe Motorrad auf 4.000 €", used: ["Japan"] });
    expect(applyAliases(aliases, "Japanisch essen").text).toBe("Japanisch essen");
    expect(applyAliases(aliases, "Japan statt Motorrad").used).toEqual([]);
    expect(countAliases(aliases, result.used)[0].hits).toBe(1);
    expect(learnAlias(aliases, "japan", "Schrank", 2)).toEqual([{ from: "japan", to: "Schrank", at: 2 }]);
  });
  it("finds the unknown name and the picked choice", () => {
    expect(unknownTarget("Erhöhe Japan auf 4.000 € und schieb es auf August 2027", ["Motorrad", "Schrank", "Pickerl"])).toBe("Japan");
    expect(unknownTarget("Erhöhe Motorrad auf 4.000 €", ["Motorrad"])).toBeUndefined();
    expect(pickName("Motorrad", ["Motorrad", "Schrank"])).toBe("Motorrad");
    expect(pickName("das Motorrad bitte", ["Motorrad", "Schrank"])).toBe("Motorrad");
    expect(pickName("keins davon", ["Motorrad", "Schrank"])).toBeUndefined();
  });
  it("runs an aliased command against the real goal", () => {
    const state = fixture();
    const unknown = executeTool("edit", "Erhöhe Japan auf 4.000 €", context(state));
    expect(unknown.choices).toEqual(expect.arrayContaining(["Motorrad", "Schrank"]));
    const text = applyAliases(learnAlias([], "Japan", "Motorrad"), "Erhöhe Japan auf 4.000 €").text;
    const result = executeTool("edit", text, context(state));
    expect(result.change?.operations[0]).toMatchObject({ op: "goal_update", goalId: "motorrad", target: 4000 });
  });
});

describe("gaps and feedback", () => {
  it("counts, resolves and lists open questions", () => {
    let gaps = recordGap([], "Wie steht mein Konto bei Oma?", 1);
    gaps = recordGap(gaps, "wie steht mein konto bei oma", 2);
    gaps = recordGap(gaps, "Was ist mit dem Ding?", 3);
    expect(gaps).toHaveLength(2);
    expect(openGaps(gaps)[0]).toMatchObject({ count: 2 });
    gaps = resolveGap(gaps, "Wie steht mein Konto bei Oma?", "accounts");
    expect(openGaps(gaps).map((gap) => gap.text)).toEqual(["Was ist mit dem Ding?"]);
  });
  it("unlearns a phrasing after a thumbs down", () => {
    const phrases = learnPhrase([], "Zeig mal die Kohle", "accounts");
    expect(matchPhrase(phrases, "zeig mal die kohle")?.tool).toBe("accounts");
    expect(unlearnPhrase(phrases, "Zeig mal die Kohle")).toEqual([]);
  });
  it("reports aliases and open gaps when asked", () => {
    expect(detectTool("Was kannst du noch nicht?")).toBe("knowledge");
    const state = { ...fixture(), assistantAliases: learnAlias([], "Japan", "Motorrad"), assistantGaps: recordGap([], "Was ist mit dem Ding?") };
    expect(appStateSchema.safeParse(state).error?.issues).toBeUndefined();
    const list = knowledgeList(state);
    expect(list.text).toMatch(/Bezeichnung/);
    expect(JSON.stringify(list.card)).toContain("Japan");
    expect(JSON.stringify(list.card)).toContain("Was ist mit dem Ding?");
  });
});
