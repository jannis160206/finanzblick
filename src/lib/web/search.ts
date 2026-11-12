import { lookup } from "node:dns/promises";
import { decodeEntities, fetchPage } from "@/lib/ai/industry";
import { cleanUntrusted } from "@/lib/ai/untrusted";
import { contentWords } from "@/lib/knowledge-base/query";
import { lookupKnowledge, shortenText, type KnowledgeHit } from "./knowledge";
import { cached } from "./market-data";
import { agreedFigures, scrubQuestion, searchFiller, searchTopicWords, type WebSearchProvider, type WebSearchResult, type WebSource } from "./web-answer";

// The automatic web search of the finance assistant. Only search words leave the device: no amounts, names of the
// user's accounts, e-mail addresses or IBANs. Pages are read over https from public hosts only, size- and time-capped.

const USER_AGENT = "Finanzblick/1.0 (privates Finanzdashboard; Websuche des Finanz-Assistenten)";
const SEARCH_TIMEOUT_MS = 5_000;
const PAGE_TIMEOUT_MS = 4_500;
const MAX_SOURCES = 3;
const SOURCE_LENGTH = 460;
const CACHE_MS = 6 * 60 * 60 * 1000;

export type WebHit = { title: string; url: string; snippet: string };
export type WebSearchOptions = {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  wikipedia?: (topic: string) => Promise<KnowledgeHit | undefined>;
  env?: Partial<Record<string, string>>;
  avoid?: string[];
};

const fold = (value: string) => value.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
const plain = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/&shy;|&#173;/g, "").replace(/&nbsp;|&#160;/g, " ")
  .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&(?!amp;|quot;|apos;|#\d+;|auml;|ouml;|uuml;|szlig;)[a-z]+;/gi, " "));

const country = /\b(?:österreich|oesterreich|austria|deutschland|schweiz|usa|eu)\b/i;

/** The search words sent to the search engine: personal details and amounts never leave the device. */
export function webQuery(question: string): string {
  const scrubbed = scrubQuestion(question);
  const words = contentWords(scrubbed).filter((word) => !searchFiller.has(word)).slice(0, 8);
  if (!words.length) return "";
  return country.test(scrubbed) ? words.join(" ") : `${words.join(" ")} Österreich`;
}

const official = /(?:^|\.)(?:gv\.at|sozialministerium\.at|arbeiterkammer\.at|wko\.at|oenb\.at|statistik\.at|svs\.at|gesundheitskasse\.at|sozialversicherung\.at|ams\.at|konsument\.at|europa\.eu)$/;
const reputable = /(?:^|\.)(?:wikipedia\.org|orf\.at|derstandard\.at|diepresse\.com|vki\.at|finanz\.at|oesterreich\.gv\.at)$/;
const unusable = /(?:^|\.)(?:facebook|instagram|tiktok|youtube|twitter|x|pinterest|linkedin|reddit|amazon|ebay|bing|msn|google|microsoft)\.[a-z]+$/;
const siteOf = (url: URL) => url.hostname.replace(/^www\./, "");

/** Bing wraps result links in a click-tracking URL; the real target is the base64url `u` parameter after "a1". */
export function bingTarget(href: string): string | undefined {
  try {
    const url = new URL(href, "https://www.bing.com");
    if (!/(?:^|\.)bing\.com$/.test(url.hostname)) return url.href;
    const encoded = url.searchParams.get("u");
    if (!encoded?.startsWith("a1")) return undefined;
    return Buffer.from(encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

/** The organic results of a Bing result page: title, target link and snippet. */
export function parseBing(html: string): WebHit[] {
  const hits: WebHit[] = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const part = block.slice(0, Math.max(0, block.indexOf("</li>")) || block.length);
    const link = part.match(/<h2[^>]*>\s*<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = bingTarget(decodeEntities(link[1]));
    const snippet = part.match(/<div class="b_caption[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? part.match(/<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    if (url) hits.push({ title: plain(link[2]), url, snippet: plain(snippet).replace(/\s*…$/, "") });
  }
  return hits;
}

const privateAddress = (address: string) =>
  /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) ||
  /^(?:::1?|::ffff:.*|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*)$/i.test(address);
const lookupAll = async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address);

/** A fetch that refuses hosts resolving to private or local addresses, so search results can never reach the home network. */
export function publicFetch(resolve: (host: string) => Promise<string[]> = lookupAll, fetcher: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const addresses = await resolve(url.hostname);
    if (!addresses.length || addresses.some(privateAddress)) throw new Error("Keine öffentliche Adresse.");
    return fetcher(input, init);
  }) as typeof fetch;
}

const noise = /cookie|javascript|newsletter|datenschutzerkl|©|alle rechte|vorheriges thema|nächstes thema|naechstes thema/i;
const tableText = (table: string) => [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
  .map((row) => [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => plain(cell[1])).filter(Boolean).join(": "))
  .filter(Boolean).join("; ");

const FIGURES = /€|euro\b|cent\b|%|prozent/i;
// Long paragraphs keep their most telling sentences: amounts and the question's words first, in their original order.
function focusText(text: string, stems: string[], limit: number) {
  if (text.length <= limit) return text;
  const sentences = text.split(/(?<=[.!?;])\s+(?=[A-ZÄÖÜ0-9„"])/);
  const weight = (sentence: string) => (FIGURES.test(sentence) && /\d/.test(sentence) ? 2 : 0) + stems.filter((stem) => fold(sentence).includes(stem)).length;
  const chosen = new Set<number>();
  const seen = new Set<string>();
  let length = 0;
  for (const { index } of sentences.map((sentence, index) => ({ index, weight: weight(sentence) })).sort((a, b) => b.weight - a.weight || a.index - b.index)) {
    if (length && length + sentences[index].length + 1 > limit || seen.has(sentences[index])) continue;
    seen.add(sentences[index]);
    chosen.add(index);
    length += sentences[index].length + 1;
  }
  return shortenText(sentences.filter((_, index) => chosen.has(index)).join(" "), limit);
}

/**
 * The two passages of a page that answer the question best, in page order and a few sentences long. Paragraphs need the
 * question's words; a table of amounts counts too when the question asks for an amount ("Wie hoch ist …?").
 */
export function bestPassage(html: string, terms: string[], options: { amounts?: boolean; year?: string; limit?: number } = {}): string | undefined {
  const body = html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|template|button|select)\b[\s\S]*?<\/\1>/gi, " ");
  const stems = [...new Set(terms.map((term) => fold(term).slice(0, 6)).filter((term) => term.length >= 3))];
  const need = Math.min(2, stems.length);
  const tables = [...body.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((match) => ({ index: match.index, text: shortenText(tableText(match[0]), 260), table: true }));
  const flow = body.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => " ".repeat(table.length));
  const blocks = [...flow.matchAll(/<(p|li|dd|h[2-4]|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => ({ index: match.index, text: plain(match[2]), table: false }))
    // Menus and topic lists are short lines without a sentence.
    .filter((block) => block.text.length >= 50 && block.text.length <= 1500 && (/[.!?:]$|[.!?]\s/.test(block.text) || /\d/.test(block.text)));
  const scored = [...blocks, ...tables].filter((block) => !noise.test(block.text) && block.text.length >= 20).map((block) => {
    const folded = fold(block.text);
    const found = stems.filter((stem) => folded.includes(stem)).length;
    const figures = FIGURES.test(block.text) && /\d/.test(block.text);
    const usable = block.table ? !!options.amounts && figures && /\d/.test(block.text) : found >= need;
    const years: string[] = block.text.match(/\b20[0-3]\d\b/g) ?? [];
    // The asked year counts; a passage that only talks about earlier years is probably outdated.
    const dated = options.year ? years.includes(options.year) ? 2 : years.length ? -2 : 0 : years.some((year) => year >= "2025") ? 0.5 : 0;
    const base = block.table ? 1 + found : found * 2 + (/\d/.test(block.text) ? 0.5 : 0);
    return { ...block, usable, figures, score: base + dated + (options.amounts && figures ? 1 : 0) };
  }).filter((block) => block.usable).sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, 2);
  // Asked for an amount but the best paragraphs name none: the page's table of amounts takes the second place.
  const table = options.amounts && !picked.some((block) => block.figures) ? scored.find((block) => block.table) : undefined;
  const best = (table ? [picked[0], table] : picked).filter((block, index, list) => list.indexOf(block) === index).sort((a, b) => a.index - b.index);
  const limit = options.limit ?? SOURCE_LENGTH;
  return best.length ? best.map((item) => focusText(item.text, stems, Math.floor(limit / best.length))).join(" ") : undefined;
}

// Result snippets often start with the page date ("7. Sept. 2026 · …").
const cleanSnippet = (snippet: string) => snippet.replace(/^\s*\d{1,2}\.\s?[a-zäöü]{3,5}\.?\s?\d{4}\s*[·•-]\s*/i, "").trim();
const amountQuestion = /\b(?:wie (?:hoch|viel)|betrag|höhe|hoehe|\w*satz|\w*grenze|\w*pauschale|kosten|gebühr\w*|gebuehr\w*|\w*geld|\w*bonus|\w*freibetrag)\b/i;
async function getJson(url: URL, fetcher: typeof fetch, signal: AbortSignal, headers: Record<string, string> = {}) {
  const response = await fetcher(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers }, signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Suche antwortet mit ${response.status}`);
  return response.json() as Promise<unknown>;
}

type Provider = { name: WebSearchProvider; run: (query: string, signal: AbortSignal) => Promise<WebHit[]> };

function providers(env: Partial<Record<string, string>>, fetcher: typeof fetch): Provider[] {
  const list: Provider[] = [];
  const searxng = env.FINANZBLICK_SEARXNG_URL?.trim();
  // A self-hosted SearXNG may run in the home network; only this configured address is allowed there.
  if (searxng && /^https?:\/\//.test(searxng)) list.push({ name: "searxng", run: async (query, signal) => {
    const url = new URL("search", searxng.endsWith("/") ? searxng : `${searxng}/`);
    url.search = new URLSearchParams({ q: query, format: "json", language: "de-AT", safesearch: "1" }).toString();
    const data = await getJson(url, fetch, signal) as { results?: { title?: string; url?: string; content?: string }[] };
    return (data.results ?? []).map((item) => ({ title: item.title ?? "", url: item.url ?? "", snippet: item.content ?? "" }));
  } });
  const brave = env.BRAVE_SEARCH_API_KEY?.trim();
  if (brave) list.push({ name: "brave", run: async (query, signal) => {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.search = new URLSearchParams({ q: query, country: "AT", search_lang: "de", count: "8" }).toString();
    const data = await getJson(url, fetcher, signal, { "X-Subscription-Token": brave }) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (data.web?.results ?? []).map((item) => ({ title: plain(item.title ?? ""), url: item.url ?? "", snippet: plain(item.description ?? "") }));
  } });
  list.push({ name: "bing", run: async (query, signal) => {
    const url = new URL("https://www.bing.com/search");
    url.search = new URLSearchParams({ q: query, setlang: "de", cc: "AT", count: "10" }).toString();
    const response = await fetcher(url, { headers: { Accept: "text/html", "User-Agent": USER_AGENT, "Accept-Language": "de-AT,de;q=0.9" }, signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Bing antwortet mit ${response.status}`);
    return parseBing(await response.text());
  } });
  return list;
}

function usableHits(hits: WebHit[], avoid: Set<string>) {
  const seen = new Set<string>();
  return hits.flatMap((hit) => {
    try {
      const url = new URL(hit.url);
      const site = siteOf(url);
      if (url.protocol !== "https:" || url.href.length > 500 || unusable.test(url.hostname) || seen.has(site) || avoid.has(url.href) || avoid.has(site) ||
        /\.pdf$/i.test(url.pathname)) return [];
      seen.add(site);
      return [{ ...hit, url: url.href, site, official: official.test(url.hostname) }];
    } catch {
      return [];
    }
  });
}

const rank = (hit: WebHit & { site: string; official: boolean }, stems: string[]) => {
  const text = fold(`${hit.title} ${hit.snippet}`);
  return (hit.official ? 4 : 0) + (reputable.test(hit.site) ? 2 : 0) + (hit.site.endsWith(".at") ? 1 : 0) + stems.filter((stem) => text.includes(stem)).length;
};

async function runSearch(question: string, query: string, options: WebSearchOptions, env: Partial<Record<string, string>>): Promise<Omit<WebSearchResult, "ms">> {
  const fetcher = options.fetcher ?? publicFetch(options.resolve);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS + PAGE_TIMEOUT_MS)]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS + PAGE_TIMEOUT_MS);
  // Page passages and the Wikipedia topic use the cleaned words too, so nothing personal leaves the device that way either.
  const terms = searchTopicWords(question);
  const stems = terms.map((term) => fold(term).slice(0, 6));
  const topic = terms.filter((word) => word.length >= 6 && !/^\d+$/.test(word)).sort((a, b) => b.length - a.length)[0];
  const wikipedia = topic ? (options.wikipedia ?? ((term: string) => lookupKnowledge(term, fetcher)))(topic).catch(() => undefined) : Promise.resolve(undefined);
  const avoid = new Set(options.avoid ?? []);
  let provider: WebSearchProvider = "none";
  let hits: ReturnType<typeof usableHits> = [];
  for (const candidate of providers(env, fetcher)) {
    try {
      hits = usableHits(await candidate.run(query, AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])), avoid);
    } catch {
      if (signal.aborted) break;
      hits = [];
    }
    if (hits.length) { provider = candidate.name; break; }
  }
  const picked = hits.map((hit, index) => ({ hit, score: rank(hit, stems) - index * 0.3 })).sort((a, b) => b.score - a.score).slice(0, MAX_SOURCES + 1).map((item) => item.hit);
  const amounts = amountQuestion.test(question);
  const year = question.match(/\b20[2-3]\d\b/)?.[0];
  const pages = await Promise.all(picked.map(async (hit) => {
    try {
      const page = await fetchPage(new URL(hit.url), fetcher, AbortSignal.any([signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]));
      return page ? bestPassage(page.html, terms, { amounts, year }) : undefined;
    } catch {
      return undefined;
    }
  }));
  // A page that answered in its own text beats a bare result snippet.
  const sources: Omit<WebSource, "n">[] = picked.map((hit, index) => ({ hit, passage: pages[index], order: index }))
    .sort((a, b) => Number(!!b.passage) - Number(!!a.passage) || a.order - b.order)
    .map(({ hit, passage }) => ({
      title: cleanUntrusted(hit.title, 120), url: hit.url, site: hit.site, official: hit.official,
      text: cleanUntrusted(passage ?? cleanSnippet(hit.snippet), SOURCE_LENGTH + 40),
    })).filter((source) => source.text.length >= 60).slice(0, MAX_SOURCES);
  const wiki = await wikipedia;
  if (wiki && sources.length < MAX_SOURCES && !avoid.has(wiki.url) && !sources.some((source) => source.site.endsWith("wikipedia.org"))) {
    sources.push({ title: wiki.title, url: wiki.url, site: "de.wikipedia.org", official: false, text: cleanUntrusted(shortenText(wiki.text, SOURCE_LENGTH), SOURCE_LENGTH + 40) });
    if (provider === "none") provider = "wikipedia";
  }
  const numbered = sources.map((source, index) => ({ ...source, n: index + 1 }));
  return { query, sources: numbered, agreed: agreedFigures(numbered.map((source) => source.text)), provider };
}

/**
 * Searches the web for a general finance question and returns up to three short, numbered sources: official Austrian
 * sites first, Wikipedia as a fallback. Results are cached for six hours; `FINANZBLICK_WEB_SEARCH=off` turns it off.
 */
export async function searchWeb(question: string, options: WebSearchOptions = {}): Promise<WebSearchResult> {
  const started = performance.now();
  const env = options.env ?? process.env;
  const query = webQuery(question);
  const empty = (disabled?: boolean): WebSearchResult => ({ query, sources: [], agreed: [], provider: "none", ms: Math.round(performance.now() - started), ...(disabled ? { disabled } : {}) });
  if (/^(?:off|false|0|aus|nein)$/i.test(env.FINANZBLICK_WEB_SEARCH?.trim() ?? "")) return empty(true);
  if (!query) return empty();
  const key = `web-search:v1:${fold(query)}:${[...(options.avoid ?? [])].sort().join(",")}`;
  try {
    const result = await cached(key, async () => {
      const found = await runSearch(question, query, options, env);
      // Nothing found is not cached, so the next try searches again.
      if (!found.sources.length) throw new Error("Keine Quellen.");
      return found;
    }, CACHE_MS);
    return { ...result, ms: Math.round(performance.now() - started) };
  } catch {
    return empty();
  }
}
