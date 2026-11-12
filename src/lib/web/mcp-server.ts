import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { lookupKnowledge } from "./knowledge";
import { exchangeRates, inflation, interestRates, type ExchangeRate, type InterestRates, type Observation } from "./market-data";

export type MarketSnapshot = { inflation?: Observation; rates?: InterestRates; fx: ExchangeRate[]; errors: string[] };

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const fail = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });
const currencies = z.array(z.string().regex(/^[A-Za-z]{3}$/)).max(10);

export async function marketSnapshot(codes: string[] = [], fetcher?: typeof fetch): Promise<MarketSnapshot> {
  const [prices, rates, fx] = await Promise.allSettled([inflation(fetcher), interestRates(fetcher), exchangeRates(codes, fetcher)]);
  const errors: string[] = [];
  if (prices.status === "rejected") errors.push("Inflation");
  if (rates.status === "rejected") errors.push("Zinsen");
  if (fx.status === "rejected") errors.push("Wechselkurse");
  return {
    ...(prices.status === "fulfilled" ? { inflation: prices.value } : {}),
    ...(rates.status === "fulfilled" ? { rates: rates.value } : {}),
    fx: fx.status === "fulfilled" ? fx.value : [], errors,
  };
}

// MCP server with read-only public data (Eurostat, ECB, Wikipedia). It never sees personal finance data.
export function createWebMcpServer(fetcher?: typeof fetch) {
  const server = new McpServer({ name: "finanzblick-web", version: "1.0.0" });
  const annotations = { readOnlyHint: true, openWorldHint: true };
  server.registerTool("get_inflation", {
    description: "Aktuelle Inflationsrate in Österreich (HVPI, Veränderung zum Vorjahresmonat, Eurostat).", inputSchema: {}, annotations,
  }, async () => { try { return json(await inflation(fetcher)); } catch (error) { return fail(error); } });
  server.registerTool("get_interest_rates", {
    description: "EZB-Einlagesatz sowie durchschnittliche Zinsen österreichischer Banken für täglich fällige und bis 1 Jahr gebundene Spareinlagen.",
    inputSchema: {}, annotations,
  }, async () => { try { return json(await interestRates(fetcher)); } catch (error) { return fail(error); } });
  server.registerTool("get_exchange_rates", {
    description: "EZB-Referenzkurse: wie viele Einheiten der Fremdwährung 1 Euro kostet, z. B. JPY, USD, GBP.",
    inputSchema: { currencies }, annotations,
  }, async ({ currencies: codes }) => { try { return json(await exchangeRates(codes, fetcher)); } catch (error) { return fail(error); } });
  server.registerTool("get_market_snapshot", {
    description: "Alles für die Sparplanung auf einmal: Inflation, Sparzinsen und optional Wechselkurse.",
    inputSchema: { currencies: currencies.optional() }, annotations,
  }, async ({ currencies: codes }) => json(await marketSnapshot(codes ?? [], fetcher)));
  server.registerTool("search_knowledge", {
    description: "Allgemeines Finanzwissen nachschlagen (deutschsprachige Wikipedia), z. B. ETF, KESt, Bausparvertrag, Tagesgeld, Arbeitnehmerveranlagung. " +
      "Liefert Titel, kurze Erklärung, Link und Lizenz oder null, wenn nichts Passendes gefunden wurde.",
    inputSchema: { query: z.string().trim().min(2).max(80) }, annotations,
  }, async ({ query }) => { try { return json((await lookupKnowledge(query, fetcher)) ?? null); } catch (error) { return fail(error); } });
  return server;
}
