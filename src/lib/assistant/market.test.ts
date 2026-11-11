import { afterEach, describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { currency } from "@/lib/format";
import { callWebTool, fetchMarketSnapshot, listWebTools } from "@/lib/web/mcp-client";
import { clearMarketCache, exchangeRates, inflation, interestRates, parseEcbCsv } from "@/lib/web/market-data";
import { executeTool } from "./agent";
import { currenciesIn, marketAnswer, type MarketSnapshot } from "./market";
import { detectTool } from "./tools";

const asOf = "2026-11-05";
const csv = (rows: [string, string, number][]) =>
  ["KEY,FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE,TITLE", ...rows.map(([key, period, value]) => `${key},M,AT,${period},${value},"Titel, mit Komma"`)].join("\n");

// Fake internet: answers like Eurostat and the ECB and records every requested URL.
function fakeFetch(urls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("eurostat")) return new Response(JSON.stringify({ value: { "0": 3.5 }, dimension: { time: { category: { index: { "2026-10": 0 } } } } }));
    if (url.includes("FM/")) return new Response(csv([["FM.D.U2.EUR.4F.KR.DFR.LEV", "2026-11-05", 2.5]]));
    if (url.includes("MIR/")) return new Response(csv([["MIR.M.AT.B.L21.A.R.A.2250.EUR.N", "2026-09", 0.46], ["MIR.M.AT.B.L22.A.R.A.2250.EUR.N", "2026-09", 2.18],
      ["MIR.M.AT.B.L22.F.R.A.2250.EUR.N", "2026-09", 2.18]]));
    if (url.includes("EXR/")) return new Response(csv([["EXR.D.JPY.EUR.SP00.A", "2026-11-05", 177.85], ["EXR.D.USD.EUR.SP00.A", "2026-11-05", 1.08]]));
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

const snapshot: MarketSnapshot = {
  inflation: { value: 3.5, period: "2026-10", source: "Eurostat", url: "" },
  rates: { ecbDeposit: { value: 2.5, period: "2026-11-05", source: "EZB", url: "" }, overnight: { value: 0.46, period: "2026-09", source: "OeNB", url: "" },
    fixedUpToOneYear: { value: 2.18, period: "2026-09", source: "OeNB", url: "" } },
  fx: [{ currency: "JPY", value: 177.85, period: "2026-11-05", source: "EZB", url: "" }], errors: [],
};

function dashboard() {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  return { state, dashboard: calculateDashboard(state) };
}

afterEach(() => clearMarketCache());

describe("market data sources", () => {
  it("parses ECB csv with quoted commas", () => {
    expect(parseEcbCsv(csv([["EXR.D.JPY.EUR.SP00.A", "2026-11-05", 177.85]]))).toEqual([{ key: "EXR.D.JPY.EUR.SP00.A", period: "2026-11-05", value: 177.85 }]);
    expect(parseEcbCsv("")).toEqual([]);
  });

  it("reads inflation, rates and exchange rates and only sends currency codes", async () => {
    const urls: string[] = [];
    expect((await inflation(fakeFetch(urls))).value).toBe(3.5);
    const rates = await interestRates(fakeFetch(urls));
    expect([rates.ecbDeposit?.value, rates.overnight?.value, rates.fixedUpToOneYear?.value]).toEqual([2.5, 0.46, 2.18]);
    expect((await exchangeRates(["usd", "jpy", "EUR", "x"], fakeFetch(urls))).map((rate) => rate.currency)).toEqual(["JPY", "USD"]);
    expect(urls.some((url) => url.includes("EXR/D.JPY+USD.EUR"))).toBe(true);
  });

  it("keeps the last value when a source fails", async () => {
    await inflation(fakeFetch());
    const broken = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect((await inflation(broken)).value).toBe(3.5);
  });
});

describe("finanzblick-web MCP server", () => {
  it("lists its tools and answers over MCP", async () => {
    expect(await listWebTools()).toEqual(expect.arrayContaining(["get_inflation", "get_interest_rates", "get_exchange_rates", "get_market_snapshot"]));
    expect(await callWebTool("get_exchange_rates", { currencies: ["JPY"] }, fakeFetch())).toEqual([expect.objectContaining({ currency: "JPY", value: 177.85 })]);
    const result = await fetchMarketSnapshot(["JPY"], fakeFetch());
    expect(result.inflation?.value).toBe(3.5);
    expect(result.errors).toEqual([]);
  });

  it("reports partial failures instead of failing", async () => {
    const offline = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const result = await fetchMarketSnapshot([], offline);
    expect(result.errors).toEqual(["Inflation", "Zinsen"]);
  });
});

describe("market answers", () => {
  it.each([
    "Wie hoch ist die Inflation gerade?", "Welche Zinsen bekomme ich fürs Sparkonto?", "Was bringt Tagesgeld aktuell?", "Wie hoch ist der Leitzins?",
    "Wie viel sind 3000 € in Yen?", "Was sind 10.000 € in 10 Jahren noch wert?", "Wie ist der Wechselkurs zum Dollar?", "Wie stark ist die Teuerung?",
  ])("routes %s to market", (text) => expect(detectTool(text)).toBe("market"));

  it.each([
    ["100 € im Monat in einen ETF, was habe ich nach 10 Jahren?", "depot"],
    ["Rechne mir den Zinseszins für 200 € im Monat", "depot"],
  ])("keeps %s on %s", (text, tool) => expect(detectTool(text)).toBe(tool));

  it("detects currencies from countries and units", () => {
    expect(currenciesIn("Urlaub in Japan und London")).toEqual(["JPY", "GBP"]);
    expect(currenciesIn("australische Dollar")).toEqual(["AUD"]);
    expect(currenciesIn("Wie viel ist ein Dollar?")).toEqual(["USD"]);
  });

  it("converts euros into yen", () => {
    const result = marketAnswer("Wie viel sind 3000 € in Yen?", snapshot, dashboard().dashboard);
    expect(result.text).toContain("533.550 Yen");
    expect(result.card?.title).toBe("Wechselkurs");
  });

  it("explains inflation and future purchasing power", () => {
    const result = marketAnswer("Was sind 10.000 € in 10 Jahren noch wert?", snapshot, dashboard().dashboard);
    expect(result.text).toContain(currency(7089.19));
    expect(result.card?.note).toContain("finanzblick-web");
  });

  it("compares savings rates", () => {
    const result = marketAnswer("Welche Zinsen bekomme ich fürs Sparkonto?", snapshot, dashboard().dashboard);
    expect(result.text).toMatch(/0,46 %.*2,18 %/);
    expect(result.card?.lines.map((line) => line.label)).toContain("EZB-Einlagesatz");
    expect(marketAnswer("Was ist der aktuelle Leitzins?", snapshot, dashboard().dashboard).text).toMatch(/^Der Leitzins der EZB \(Einlagesatz\) liegt bei /);
    expect(marketAnswer("Was ist Inflation?", snapshot, dashboard().dashboard).text).toMatch(/^Inflation heißt, dass die Preise allgemein steigen.+Die Inflation in Österreich liegt bei 3,5 %/);
  });

  it("says so when offline", () => {
    expect(marketAnswer("Inflation?", undefined, dashboard().dashboard).text).toContain("nicht an die aktuellen Marktdaten");
  });

  it("adds the real value to the depot calculator", () => {
    const { state, dashboard: data } = dashboard();
    const result = executeTool("depot", "100 € im Monat in einen ETF, 10 Jahre", { state, dashboard: data, asOf, market: snapshot });
    expect(result.card?.lines.at(-1)?.label).toBe("Mittel, in heutiger Kaufkraft");
  });
});
