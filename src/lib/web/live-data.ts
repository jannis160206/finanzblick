import { decodeEntities } from "@/lib/ai/industry";
import { cleanUntrusted } from "@/lib/ai/untrusted";
import { currentSubject, type CurrentKind } from "@/lib/assistant/current-info";
import { cached } from "./market-data";
import type { WebSource } from "./web-answer";

// Live values for questions about quotes and news: CoinGecko for crypto, Yahoo Finance for shares, indices, metals and
// oil, the Bing news feed for headlines. Only the name of the asset or the topic leaves the device, never personal data.

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Finanzblick/1.0";
const TIMEOUT_MS = 5_000;
const QUOTE_TTL = 2 * 60 * 1000;
const NEWS_TTL = 15 * 60 * 1000;

export type LiveOptions = { fetcher?: typeof fetch; signal?: AbortSignal; now?: () => Date };

async function getJson(url: string, options: LiveOptions): Promise<unknown> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const response = await (options.fetcher ?? fetch)(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Thousands with a dot ("59.463 €"), as the chat writes amounts, so the answer can quote them exactly.
const number = (value: number) => value.toLocaleString("de-DE", { minimumFractionDigits: value >= 1000 ? 0 : value >= 1 ? 2 : 0,
  maximumFractionDigits: value >= 1000 ? 0 : value >= 1 ? 2 : 4 });
const percent = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toLocaleString("de-DE", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} %`;
const stamp = (date: Date) => `${date.toLocaleDateString("de-AT", { timeZone: "Europe/Vienna" })}, ${date.toLocaleTimeString("de-AT", { timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit" })} Uhr`;
const money = (value: number, currency: string) => currency === "EUR" ? `${number(value)} €` : currency === "USD" ? `${number(value)} US-$` : `${number(value)} ${currency}`;

// Shares, indices, metals and oil by their usual German names; everything else is looked up in Yahoo's search.
const symbols: Record<string, { symbol: string; name: string; unit?: string }> = {
  Gold: { symbol: "GC=F", name: "Gold", unit: "je Feinunze (COMEX-Future)" },
  Silber: { symbol: "SI=F", name: "Silber", unit: "je Feinunze (COMEX-Future)" },
  Platin: { symbol: "PL=F", name: "Platin", unit: "je Feinunze (NYMEX-Future)" },
  "Öl": { symbol: "BZ=F", name: "Rohöl Brent", unit: "je Barrel (Future)" },
  DAX: { symbol: "^GDAXI", name: "DAX", unit: "Punkte" },
  ATX: { symbol: "^ATX", name: "ATX", unit: "Punkte" },
  Nasdaq: { symbol: "^IXIC", name: "Nasdaq Composite", unit: "Punkte" },
  "Dow Jones": { symbol: "^DJI", name: "Dow Jones", unit: "Punkte" },
  "S&P 500": { symbol: "^GSPC", name: "S&P 500", unit: "Punkte" },
  "MSCI World": { symbol: "EUNL.DE", name: "iShares Core MSCI World UCITS ETF (Xetra)" },
};
const cryptoNames = new Set(["Bitcoin", "Ethereum", "Solana", "XRP", "Dogecoin", "Cardano", "Litecoin"]);

const coinSearchSchema = (value: unknown) => (value as { coins?: { id?: string; name?: string; symbol?: string; market_cap_rank?: number }[] })?.coins ?? [];

async function cryptoQuote(subject: string, options: LiveOptions): Promise<WebSource | undefined> {
  const coins = coinSearchSchema(await getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(subject)}`, options));
  const wanted = subject.toLowerCase();
  const coin = coins.find((item) => item.name?.toLowerCase() === wanted || item.symbol?.toLowerCase() === wanted) ?? (cryptoNames.has(subject) ? coins[0] : undefined);
  if (!coin?.id || !/^[a-z0-9-]{1,80}$/.test(coin.id)) return undefined;
  const [price, history] = await Promise.all([
    getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=eur,usd&include_24hr_change=true&include_last_updated_at=true`, options),
    getJson(`https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart?vs_currency=eur&days=30&interval=daily`, options).catch(() => undefined),
  ]);
  const data = (price as Record<string, { eur?: number; usd?: number; eur_24h_change?: number; last_updated_at?: number }>)[coin.id];
  if (typeof data?.eur !== "number") return undefined;
  const points = ((history as { prices?: [number, number][] } | undefined)?.prices ?? []).map(([, value]) => value).filter(Number.isFinite);
  const first = points[0];
  const updated = data.last_updated_at ? new Date(data.last_updated_at * 1000) : (options.now?.() ?? new Date());
  const parts = [
    `${coin.name ?? subject} (${(coin.symbol ?? "").toUpperCase()}): ${money(data.eur, "EUR")} je Coin${typeof data.usd === "number" ? ` (${money(data.usd, "USD")})` : ""}`,
    typeof data.eur_24h_change === "number" ? `24 Stunden: ${percent(data.eur_24h_change)}` : "",
    first ? `30 Tage: ${percent((data.eur / first - 1) * 100)} (Spanne ${number(Math.min(...points))}–${number(Math.max(...points))} €)` : "",
    `Stand ${stamp(updated)}`,
  ].filter(Boolean);
  return { n: 1, title: `${coin.name ?? subject} Kurs – CoinGecko`, url: `https://www.coingecko.com/de/munze/${coin.id}`, site: "coingecko.com", official: false,
    text: `${parts.join(" · ")}.` };
}

type YahooChart = { chart?: { result?: { meta?: { currency?: string; symbol?: string; regularMarketPrice?: number; regularMarketTime?: number; chartPreviousClose?: number;
  longName?: string; shortName?: string }; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } };

async function yahooChart(symbol: string, options: LiveOptions) {
  const chart = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`, options) as YahooChart;
  const result = chart.chart?.result?.[0];
  const price = result?.meta?.regularMarketPrice;
  if (!result?.meta || typeof price !== "number") return undefined;
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter((value): value is number => typeof value === "number");
  return { meta: result.meta, price, closes };
}

async function marketQuote(subject: string, options: LiveOptions): Promise<WebSource | undefined> {
  let target = symbols[subject];
  if (!target) {
    const found = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(subject)}&quotesCount=5&newsCount=0`, options) as
      { quotes?: { symbol?: string; shortname?: string; longname?: string; quoteType?: string }[] };
    const hit = (found.quotes ?? []).find((item) => item.symbol && /^(?:EQUITY|ETF|INDEX|FUTURE|MUTUALFUND|CURRENCY)$/.test(item.quoteType ?? ""));
    if (!hit?.symbol || !/^[\w.=^-]{1,20}$/.test(hit.symbol)) return undefined;
    target = { symbol: hit.symbol, name: cleanUntrusted(hit.longname ?? hit.shortname ?? hit.symbol, 80) };
  }
  const chart = await yahooChart(target.symbol, options);
  if (!chart) return undefined;
  const currency = (chart.meta.currency ?? "").toUpperCase();
  const points = target.unit === "Punkte";
  // Prices in US dollars also get a rough euro value.
  const euroRate = currency === "USD" && !points ? (await yahooChart("EURUSD=X", options).catch(() => undefined))?.price : undefined;
  const first = chart.meta.chartPreviousClose ?? chart.closes[0];
  const previous = chart.closes.length >= 2 ? chart.closes[chart.closes.length - 2] : undefined;
  const value = points ? `${number(chart.price)} Punkte` : money(chart.price, currency || "EUR");
  const updated = chart.meta.regularMarketTime ? new Date(chart.meta.regularMarketTime * 1000) : (options.now?.() ?? new Date());
  const parts = [
    `${target.name} (${target.symbol}): ${value}${target.unit && !points ? ` ${target.unit}` : ""}${euroRate ? ` (≈ ${money(chart.price / euroRate, "EUR")})` : ""}`,
    previous ? `Vortag: ${percent((chart.price / previous - 1) * 100)}` : "",
    first ? `30 Tage: ${percent((chart.price / first - 1) * 100)}` : "",
    chart.closes.length ? `Spanne 30 Tage ${number(Math.min(...chart.closes))}–${number(Math.max(...chart.closes))}${points ? " Punkte" : ` ${currency === "EUR" ? "€" : currency}`}` : "",
    `Stand ${stamp(updated)}`,
  ].filter(Boolean);
  return { n: 1, title: `${target.name} – Yahoo Finance`, url: `https://finance.yahoo.com/quote/${encodeURIComponent(target.symbol)}`, site: "finance.yahoo.com",
    official: false, text: `${parts.join(" · ")}.` };
}

/** The current quote of a coin, share, index, metal or oil, with change and time; undefined when nothing fits. */
export async function liveQuote(question: string, options: LiveOptions = {}): Promise<WebSource | undefined> {
  const subject = currentSubject(question);
  if (!subject) return undefined;
  // Coins only for known coins or when the question says so; "Apple" is the share, not a coin of that name.
  const coin = cryptoNames.has(subject) || /\b(?:krypto\w*|crypto\w*|coin|token)\b/i.test(question);
  return cached(`live-quote:v1:${subject.toLowerCase()}:${coin}`, async () => {
    const quote = coin ? await cryptoQuote(subject, options).catch(() => undefined) ?? await marketQuote(subject, options) : await marketQuote(subject, options);
    if (!quote) throw new Error("Kein Kurs.");
    return quote;
  }, QUOTE_TTL).catch(() => undefined);
}

const tag = (item: string, name: string) => decodeEntities(item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "") ?? "")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const NEWS_DAYS = 14;

/** Recent headlines from the Bing news feed; the real article link sits in the `url` parameter of Bing's click link. */
export function parseNewsFeed(xml: string, limit = 4, now = Date.now()): WebSource[] {
  const sources: WebSource[] = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = cleanUntrusted(tag(item, "title"), 160);
    let link = tag(item, "link");
    try {
      const wrapped = new URL(link);
      link = wrapped.searchParams.get("url") ?? link;
      const url = new URL(link);
      if (url.protocol !== "https:") continue;
      link = url.href;
    } catch {
      continue;
    }
    const published = Date.parse(tag(item, "pubDate"));
    // Old articles are no news.
    if (Number.isFinite(published) && now - published > NEWS_DAYS * 24 * 60 * 60 * 1000) continue;
    const date = Number.isFinite(published) ? ` (${new Date(published).toLocaleDateString("de-AT", { timeZone: "Europe/Vienna" })})` : "";
    const description = cleanUntrusted(tag(item, "description"), 280);
    if (!title) continue;
    sources.push({ n: sources.length + 1, title, url: link, site: new URL(link).hostname.replace(/^www\./, ""), official: false,
      text: `${title}${date}${description ? ` – ${description}` : ""}` });
    if (sources.length === limit) break;
  }
  return sources;
}

/** The latest headlines about a topic (Austrian edition, German). */
export async function liveNews(question: string, options: LiveOptions = {}): Promise<WebSource[]> {
  const topic = currentSubject(question) || "Wirtschaft Finanzen";
  return cached(`live-news:v1:${topic.toLowerCase()}`, async () => {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    const response = await (options.fetcher ?? fetch)(`https://www.bing.com/news/search?q=${encodeURIComponent(topic)}&format=rss&setlang=de&cc=AT&qft=sortbydate%3d%221%22`,
      { headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, text/xml" }, cache: "no-store", signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const sources = parseNewsFeed(await response.text(), 4, (options.now?.() ?? new Date()).getTime());
    if (!sources.length) throw new Error("Keine Nachrichten.");
    return sources;
  }, NEWS_TTL).catch(() => []);
}

/** The live sources for a kind of current question; prices, rates and tax figures come from the normal web search. */
export async function liveSources(question: string, kind: CurrentKind, options: LiveOptions = {}): Promise<WebSource[]> {
  if (kind === "quote") {
    const quote = await liveQuote(question, options);
    return quote ? [quote] : [];
  }
  if (kind === "news") return liveNews(question, options);
  return [];
}
