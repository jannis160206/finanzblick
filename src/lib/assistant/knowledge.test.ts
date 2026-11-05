import { afterEach, describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { appStateSchema, type AssistantKnowledge } from "@/lib/types";
import { lookupKnowledge, pickPage, shortenText } from "@/lib/web/knowledge";
import { clearMarketCache } from "@/lib/web/market-data";
import { callWebTool, fetchKnowledge, listWebTools } from "@/lib/web/mcp-client";
import { executeTool } from "./agent";
import { findKnowledge, isStale, knowledgeAnswer, knowledgeList, knowledgeTopics, learnPhrase, matchPhrase, phrasePattern, relevantKnowledge, storeKnowledge } from "./knowledge";
import { detectTool } from "./tools";

const etfPages = [
  { title: "ETF", index: 1, extract: "ETF steht als Abkürzung für: exchange-traded fund, Form der Geldanlage, siehe Börsengehandelter Fonds; Eidgenössisches Turnfest", pageprops: { disambiguation: "" }, fullurl: "https://de.wikipedia.org/wiki/ETF" },
  { title: "Börsengehandelter Fonds", index: 2, extract: "Ein börsengehandelter Fonds (englisch exchange-traded fund, ETF) ist ein Investmentfonds, der fortlaufend an einer Börse gehandelt wird. Die meisten bilden einen Index nach.", fullurl: "https://de.wikipedia.org/wiki/B%C3%B6rsengehandelter_Fonds" },
  { title: "Xtrackers", index: 3, extract: "Xtrackers ist eine Marke für ETF der DWS Group mit Sitz in Frankfurt am Main, die seit 2007 angeboten wird.", fullurl: "https://de.wikipedia.org/wiki/Xtrackers" },
];

function fakeWiki(urls: string[] = [], pages: unknown[] = etfPages): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ query: { pages } }));
  }) as typeof fetch;
}

const entry = (patch: Partial<AssistantKnowledge> = {}): AssistantKnowledge => ({
  id: "k1", topic: "etf", title: "Börsengehandelter Fonds", text: "Ein börsengehandelter Fonds ist ein Investmentfonds, der an einer Börse gehandelt wird. Er bildet meist einen Index nach. Die Kosten sind niedrig.",
  url: "https://de.wikipedia.org/wiki/B%C3%B6rsengehandelter_Fonds", source: "Wikipedia (de) · CC BY-SA 4.0", at: Date.now(), ...patch,
});

afterEach(() => clearMarketCache());

describe("knowledge lookup", () => {
  it("skips disambiguation pages and picks the matching article in one request", async () => {
    const urls: string[] = [];
    const hit = await lookupKnowledge("ETF", fakeWiki(urls));
    expect(hit?.title).toBe("Börsengehandelter Fonds");
    expect(hit?.source).toContain("CC BY-SA");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`gsrsearch=${encodeURIComponent("Börsengehandelter Fonds").replace(/%20/g, "+")}`);
    await lookupKnowledge("etf", fakeWiki(urls));
    expect(urls).toHaveLength(1);
  });

  it("ignores airlines and towns with the same short name and retries with finance context", async () => {
    const pages = [
      { title: "ETF Airways", index: 1, extract: "ETF Airways d.o.o. ist eine kroatische Charterfluggesellschaft mit Sitz in Stupnički Obrež nahe Zagreb." },
      { title: "Kesten", index: 2, extract: "Kesten ist eine Ortsgemeinde im Landkreis Bernkastel-Wittlich in Rheinland-Pfalz." },
    ];
    expect(pickPage("ETF", pages)).toBeUndefined();
    const urls: string[] = [];
    expect(await lookupKnowledge("Pickerl", fakeWiki(urls, pages))).toBeUndefined();
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("Geldanlage");
    await lookupKnowledge("KESt", fakeWiki(urls, []));
    expect(urls[2]).toContain("Kapitalertragsteuer");
  });

  it("does not cut sentences at abbreviations", () => {
    const result = knowledgeAnswer("Was ist das?", [entry({ text: "Die Muster d.o.o. ist z. B. ein Anbieter von Fonds. Sie verwaltet Geld. Ein dritter Satz folgt. Der vierte nicht." })]);
    expect(result.text).toBe("Die Muster d.o.o. ist z. B. ein Anbieter von Fonds. Sie verwaltet Geld. Ein dritter Satz folgt.");
  });

  it("skips people and prefers Austrian articles", () => {
    const pages = [
      { title: "Hans Abfertigung", index: 1, extract: "Hans Abfertigung (* 3. Mai 1950 in Wien) ist ein österreichischer Politiker und Autor vieler Bücher." },
      { title: "Abfertigung (Arbeitsrecht)", index: 2, extract: "Die Abfertigung ist eine Zahlung des Arbeitgebers bei Ende des Arbeitsverhältnisses nach österreichischem Recht." },
    ];
    expect(pickPage("Abfertigung", pages)?.title).toBe("Abfertigung (Arbeitsrecht)");
    expect(pickPage("Quantenschaum", [{ title: "Bäckerei", index: 1, extract: "Eine Bäckerei ist ein Handwerksbetrieb, der Brot und Gebäck herstellt und verkauft." }])).toBeUndefined();
  });

  it("shortens long texts at sentence ends", () => {
    const text = shortenText(`${"Ein Satz mit Inhalt. ".repeat(100)}`, 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith(".")).toBe(true);
  });

  it("is offered by the MCP server", async () => {
    expect(await listWebTools()).toContain("search_knowledge");
    const hit = await fetchKnowledge("ETF", fakeWiki());
    expect(hit?.title).toBe("Börsengehandelter Fonds");
    await expect(callWebTool("search_knowledge", { query: "x" })).rejects.toThrow();
  });
});

describe("knowledge questions", () => {
  it("routes definition questions to knowledge and leaves other tools alone", () => {
    for (const text of ["Was ist ein ETF?", "Was bedeutet KESt?", "Was versteht man unter Zinseszins?", "Wie funktioniert ein Bausparvertrag?",
      "Erklär mir Tagesgeld", "Was ist der Unterschied zwischen Tagesgeld und Festgeld?", "Was ist die Arbeitnehmerveranlagung?", "Was hast du gelernt?"])
      expect(detectTool(text), text).toBe("knowledge");
    expect(detectTool("100 € im Monat in einen ETF, was habe ich nach 10 Jahren?")).toBe("depot");
    expect(detectTool("Wie funktionieren die Sparziele?")).toBe("explain");
    expect(detectTool("Was ist ein Pocket?")).toBe("explain");
    expect(detectTool("Wie hoch ist die Inflation?")).toBe("market");
    expect(detectTool("Was ist Inflation?")).toBe("market");
    expect(detectTool("Was kann ich bei der Arbeitnehmerveranlagung absetzen?")).toBe("tax");
    expect(detectTool("Was ist auf dem Sparkonto?")).not.toBe("knowledge");
    expect(detectTool("Was ist diese Woche fällig?")).toBe("briefing");
    expect(detectTool("Was ist mit Japan?", ["Japan"])).not.toBe("knowledge");
    expect(detectTool("Was ist Japan?", ["Japan"])).not.toBe("knowledge");
    expect(detectTool("Was sind meine Abos?")).not.toBe("knowledge");
  });

  it("extracts the terms", () => {
    expect(knowledgeTopics("Was ist eigentlich ein ETF?")).toEqual(["etf"]);
    expect(knowledgeTopics("Was ist die KESt in Österreich?")).toEqual(["kest Österreich"]);
    expect(knowledgeTopics("Unterschied zwischen Tagesgeld und Festgeld")).toEqual(["tagesgeld", "festgeld"]);
    expect(knowledgeTopics("etf was is des eigentlich")).toEqual([]);
    expect(knowledgeTopics("etf was is des eigentlich", [], true)).toEqual(["etf"]);
  });

  it("answers from stored knowledge without the internet", () => {
    const stored = [entry()];
    expect(findKnowledge(stored, "ETF")?.id).toBe("k1");
    expect(findKnowledge(stored, "börsengehandelter fonds")?.id).toBe("k1");
    const result = knowledgeAnswer("Was ist ein ETF?", stored);
    expect(result.text).toContain("Investmentfonds");
    expect(result.card?.title).toBe("Börsengehandelter Fonds");
    expect(result.card?.note).toContain("ohne neue Internetabfrage");
    expect(knowledgeAnswer("Was ist ein ETF?", stored, { fresh: ["k1"] }).card?.note).toContain("Eben im Internet nachgeschlagen");
    expect(knowledgeAnswer("Was ist ein Quark?", [], { offline: true }).text).toContain("nicht ins Internet");
    expect(isStale(entry({ at: Date.now() - 91 * 24 * 60 * 60 * 1000 }))).toBe(true);
  });

  it("stores, refreshes, lists and validates learned knowledge", () => {
    const state = createEmptyAccountState();
    state.assistantKnowledge = storeKnowledge([entry()], [entry({ id: "k2", at: Date.now() + 1 })], []);
    expect(state.assistantKnowledge.map((item) => item.id)).toEqual(["k2"]);
    state.assistantKnowledge = storeKnowledge(state.assistantKnowledge, [], ["k2"]);
    expect(state.assistantKnowledge[0].uses).toBe(1);
    state.assistantPhrases = learnPhrase([], "geht sich ein fernseher um 900 aus", "budget");
    expect(appStateSchema.safeParse(state).success).toBe(true);
    const list = knowledgeList(state);
    expect(list.text).toContain("1 Begriff");
    expect(list.card?.lines.at(-1)?.label).toBe("1 gelernte Formulierung");
    expect(executeTool("knowledge", "Was hast du gelernt?", { state, dashboard: calculateDashboard(state), asOf: "2026-11-05" }).card?.title).toBe("Was ich dazugelernt habe");
    expect(relevantKnowledge(state.assistantKnowledge, "Lohnt sich ein börsengehandelter Fonds für mich?")).toHaveLength(1);
  });
});

describe("learned phrasings", () => {
  it("matches the same phrasing with other amounts", () => {
    expect(phrasePattern("Geht sich 1.200 € aus?")).toBe(phrasePattern("geht sich 900 € aus"));
    const phrases = learnPhrase([], "Kohle am Start?", "accounts");
    expect(matchPhrase(phrases, "kohle am start")?.tool).toBe("accounts");
    expect(matchPhrase(phrases, "Kohle?")).toBeUndefined();
    const again = learnPhrase(phrases, "kohle am start!", "accounts");
    expect(again[0].hits).toBe(1);
    expect(learnPhrase(again, "kohle am start", "budget")[0].tool).toBe("budget");
  });
});
