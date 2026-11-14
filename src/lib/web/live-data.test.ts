import { describe, expect, it } from "vitest";
import { currentInfo } from "@/lib/assistant/current-info";
import { liveQuote, parseNewsFeed } from "./live-data";
import { parseDuckDuckGo, searchWeb, webQuery } from "./search";

const now = new Date("2026-11-14T20:15:00Z");

describe("current values", () => {
  it.each([
    ["Was ist der aktuelle Bitcoin-Preis?", "quote", "Bitcoin"], ["Wie steht der DAX?", "quote", "DAX"], ["Was kostet eine Apple-Aktie aktuell?", "quote", "Apple"],
    ["Wie hat sich der Bitcoin-Preis in den letzten 30 Tagen entwickelt?", "quote", "Bitcoin"], ["Wie hoch ist der Goldpreis heute?", "quote", "Gold"],
    ["Was gibt es Neues an der Börse?", "news", "Börse"], ["Wie viel kostet ein Liter Diesel gerade?", "price", "Liter Diesel"],
    ["Wie hoch ist die KESt 2026?", "tax", "KESt"], ["Wie hoch sind die Sparzinsen aktuell?", "rate", "Sparzinsen"],
  ])("sends „%s“ to live sources", (question, kind, subject) => {
    expect(currentInfo(question)).toEqual({ kind, subject });
  });

  it.each(["Was ist ein ETF?", "Was hältst du von Bitcoin?", "Was ist ein Wechselkurs?", "Was ist die KESt?", "Wie viel ist mein Depot wert?",
    "Wie viel habe ich heute ausgegeben?"])("leaves explanations and the user's own data alone: %s", (question) => {
    expect(currentInfo(question)).toBeUndefined();
  });

  it("keeps „aktuell“ in the search words and does not limit quotes to Austria", () => {
    expect(webQuery("Wie viel kostet ein Liter Diesel gerade?", "price")).toBe("kostet liter diesel gerade aktuell Österreich");
    expect(webQuery("Wie steht der DAX?", "quote")).toBe("steht dax aktuell");
    expect(webQuery("Wie hoch ist die KESt 2026?", "tax")).toBe("kest 2026 Österreich");
  });
});

/** Answers by URL prefix; anything else is a 404. */
function stub(routes: Record<string, unknown>) {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return new Response("", { status: 404 });
    const body = routes[key];
    return typeof body === "string" ? new Response(body, { headers: { "content-type": "text/xml" } }) : Response.json(body);
  }) as typeof fetch;
  return { urls, fetcher };
}

describe("live quotes", () => {
  it("takes coins from CoinGecko with the 24-hour and 30-day change and the time", async () => {
    const { fetcher } = stub({
      "https://api.coingecko.com/api/v3/search": { coins: [{ id: "litecoin", name: "Litecoin", symbol: "ltc", market_cap_rank: 20 }] },
      "https://api.coingecko.com/api/v3/simple/price": { litecoin: { eur: 1234.5, usd: 1361.2, eur_24h_change: -2.04, last_updated_at: now.getTime() / 1000 } },
      "https://api.coingecko.com/api/v3/coins/litecoin/market_chart": { prices: [[1, 1000], [2, 1300], [3, 1234.5]] },
    });
    const quote = await liveQuote("Was kostet ein Litecoin gerade?", { fetcher });
    expect(quote).toMatchObject({ site: "coingecko.com", url: "https://www.coingecko.com/de/munze/litecoin" });
    expect(quote?.text).toBe("Litecoin (LTC): 1.235 € je Coin (1.361 US-$) · 24 Stunden: −2,0 % · 30 Tage: +23,4 % (Spanne 1.000–1.300 €) · Stand 14.11.2026, 21:15 Uhr.");
  });

  it("looks up shares at Yahoo Finance, never as a coin of the same name, with a rough euro value", async () => {
    const chart = (price: number, currency: string) => ({ chart: { result: [{ meta: { currency, regularMarketPrice: price, chartPreviousClose: 200, regularMarketTime: now.getTime() / 1000 },
      indicators: { quote: [{ close: [200, 210, null, 220, price] }] } }] } });
    const { urls, fetcher } = stub({
      "https://query1.finance.yahoo.com/v1/finance/search": { quotes: [{ symbol: "AAPL", longname: "Apple Inc.", quoteType: "EQUITY" }] },
      "https://query1.finance.yahoo.com/v8/finance/chart/AAPL": chart(230.5, "USD"),
      "https://query1.finance.yahoo.com/v8/finance/chart/EURUSD%3DX": chart(1.1, "USD"),
    });
    const quote = await liveQuote("Was kostet eine Apple-Aktie aktuell?", { fetcher });
    expect(quote?.text).toBe("Apple Inc. (AAPL): 230,50 US-$ (≈ 209,55 €) · Vortag: +4,8 % · 30 Tage: +15,3 % · Spanne 30 Tage 200,00–230,50 USD · Stand 14.11.2026, 21:15 Uhr.");
    expect(urls.some((url) => url.includes("coingecko"))).toBe(false);
  });

  it("answers quotes from the live source and falls back to the search when there is none", async () => {
    const { fetcher } = stub({ "https://query1.finance.yahoo.com/v8/finance/chart/%5EATX": { chart: { result: [{ meta: { currency: "EUR", regularMarketPrice: 4512.3,
      regularMarketTime: now.getTime() / 1000 }, indicators: { quote: [{ close: [4400, 4512.3] }] } }] } } });
    const result = await searchWeb("Wie steht der ATX gerade?", { fetcher, env: {}, current: "quote", wikipedia: async () => undefined });
    expect(result).toMatchObject({ provider: "live", sources: [{ n: 1, site: "finance.yahoo.com" }] });
    expect(result.sources[0].text).toMatch(/^ATX \(\^ATX\): 4\.512 Punkte · Vortag: \+2,6 %/);
    const none = await searchWeb("Wie steht die Firma Gibtsnicht AG gerade?", { fetcher: stub({}).fetcher, env: {}, current: "quote", wikipedia: async () => undefined });
    expect(none.provider).toBe("none");
  });
});

describe("live news and search pages", () => {
  it("keeps recent https headlines with their date and the real link", () => {
    const item = (title: string, url: string, date: string) => `<item><title>${title}</title><link>http://www.bing.com/news/apiclick.aspx?ref=x&amp;url=${encodeURIComponent(url)}&amp;c=1</link>` +
      `<description>Kurz &amp; knapp</description><pubDate>${date}</pubDate></item>`;
    const feed = `<rss><channel>${item("ATX schließt im Plus", "https://www.derstandard.at/a", "Fri, 14 Nov 2026 10:00:00 GMT")}` +
      `${item("Alte Meldung", "https://www.orf.at/b", "Mon, 01 Jan 2024 10:00:00 GMT")}${item("Unsicher", "http://example.com/c", "Fri, 14 Nov 2026 09:00:00 GMT")}</channel></rss>`;
    expect(parseNewsFeed(feed, 4, now.getTime())).toEqual([{ n: 1, title: "ATX schließt im Plus", url: "https://www.derstandard.at/a", site: "derstandard.at", official: false,
      text: "ATX schließt im Plus (14.11.2026) – Kurz & knapp" }]);
  });

  it("reads DuckDuckGo results through their redirect links and skips ads", () => {
    const result = (href: string, title: string, snippet: string) =>
      `<div class="result results_links"><h2 class="result__title"><a rel="nofollow" class="result__a" href="${href}">${title}</a></h2>` +
      `<a class="result__snippet" href="${href}">${snippet}</a></div>`;
    const html = result("//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.bmf.gv.at%2Fpendler&amp;rut=abc", "BMF – <b>Pendler</b>rechner", "Der <b>Pendler</b>euro 2026") +
      result("https://duckduckgo.com/y.js?ad_domain=shop.example", "Anzeige", "Kaufen");
    expect(parseDuckDuckGo(html)).toEqual([{ title: "BMF – Pendlerrechner", url: "https://www.bmf.gv.at/pendler", snippet: "Der Pendlereuro 2026" }]);
  });
});
