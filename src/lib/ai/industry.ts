import { z } from "zod";
import { normalizeLocalLogoName } from "@/lib/automation/merchant-local-logos";
import type { Category } from "@/lib/categories";

const USER_AGENT = "Finanzblick/1.0 (private dashboard; merchant industry)";
const MAX_PAGE_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;
const CACHE_LIMIT = 500;

export type Industry = { category: Category; label: string; source: "Wikidata" | "Webseite" };
export type IndustryOptions = { fetcher?: typeof fetch; signal?: AbortSignal };

// Each keyword names one purpose; a text matching two purposes stays undecided.
const INDUSTRY_KEYWORDS: [RegExp, Category][] = [
  [/baumarkt|heimwerk|hardware store|home improvement|\bdiy\b|werkzeug|baustoff|fliesen|fugen|dichtband|renovier|sanitär|bauen\b/i, "Reparaturen & Instandhaltung"],
  [/möbel|furniture|einrichtung|interior|wohnaccessoire|matratze/i, "Möbel & Einrichtung"],
  [/supermarkt|supermarket|lebensmittel|grocery|groceries|discounter|feinkost/i, "Lebensmittel"],
  [/drogerie|drugstore|chemist|parfümerie/i, "Drogerie"],
  [/apotheke|pharmacy|optiker|optician|arztpraxis|medizin|medical|hörgerät/i, "Gesundheit"],
  [/friseur|barber|hairdresser|kosmetik|cosmetic|nagelstudio/i, "Körperpflege"],
  [/restaurant|pizzeria|gasthaus|gastronomie|steakhouse|sushi/i, "Restaurants"],
  [/café|coffee|kaffeehaus|bäckerei|bakery|konditorei/i, "Cafés & Snacks"],
  [/lieferdienst|food delivery|essenslieferung/i, "Lieferdienste"],
  [/tankstelle|filling station|petrol|gas station|mineralöl/i, "Tanken"],
  [/fluggesellschaft|airline|hotel|reisebüro|travel agency|ferienwohnung|reiseveranstalter|tour operator/i, "Urlaub"],
  [/fitness|sportverein|gym\b|yoga|kletterhalle/i, "Sport & Fitness"],
  [/tierbedarf|tiernahrung|pet supplies|zoohandlung|tierarzt|veterinar/i, "Haustiere"],
  [/streaming|video on demand|musikdienst|music streaming|software as a service|abonnement/i, "Abonnements"],
  [/versicherung|insurance/i, "Versicherungen"],
  [/mobilfunk|telekommunikation|telecommunication|internet service provider|internetanbieter/i, "Telefon & Internet"],
  [/energieversorger|stromanbieter|electric utility|energy company|gasversorger/i, "Energie & Nebenkosten"],
  [/kino|cinema|theater|konzert|ticket|freizeitpark|amusement park|videospiel|video game/i, "Entertainment"],
  [/buchhandlung|bookshop|bookstore|verlag|publisher|online-kurs|sprachschule/i, "Bildung"],
  [/sportartikel|sporting goods|sportgeschäft|bekleidung|clothing|fashion|mode\b|schuh|shoe|elektronik|electronics|onlinehändler|online retailer|online shop|onlineshop|versandhändler|kaufhaus|department store|e-commerce|warenhaus/i, "Shopping"],
];

export function industryCategory(text: string): Category | undefined {
  const found = new Set(INDUSTRY_KEYWORDS.filter(([pattern]) => pattern.test(text)).map(([, category]) => category));
  // Shops often call themselves "online shop" next to their actual trade; the trade wins.
  if (found.size > 1) found.delete("Shopping");
  return found.size === 1 ? [...found][0] : undefined;
}

const searchSchema = z.object({ search: z.array(z.object({ id: z.string().regex(/^Q\d+$/) })).max(10) });
const valueSchema = z.object({ id: z.string().regex(/^Q\d+$/) }).loose();
const entitySchema = z.object({
  entities: z.record(z.string(), z.object({
    labels: z.record(z.string(), z.object({ value: z.string() })).optional(),
    aliases: z.record(z.string(), z.array(z.object({ value: z.string() }))).optional(),
    descriptions: z.record(z.string(), z.object({ value: z.string() })).optional(),
    claims: z.record(z.string(), z.array(z.object({
      mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).optional() }),
      rank: z.string().optional(),
    }).loose())).optional(),
  }).loose()),
});

function timeoutSignal(signal?: AbortSignal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
}

async function wikidata(params: Record<string, string>, fetcher: typeof fetch, signal?: AbortSignal) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.search = new URLSearchParams({ ...params, format: "json" }).toString();
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: timeoutSignal(signal), cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function fromWikidata(name: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<Industry | undefined> {
  const ids = searchSchema.parse(await wikidata({
    action: "wbsearchentities", search: name, language: "de", uselang: "de", type: "item", limit: "6",
  }, fetcher, signal)).search.map((item) => item.id);
  if (!ids.length) return undefined;
  const parsed = entitySchema.parse(await wikidata({
    action: "wbgetentities", ids: ids.join("|"), props: "labels|aliases|descriptions|claims", languages: "de|en|mul",
  }, fetcher, signal));
  const wanted = normalizeLocalLogoName(name);
  const exact = ids.filter((id) => {
    const entity = parsed.entities[id];
    const names = [...Object.values(entity?.labels ?? {}).map((label) => label.value),
      ...Object.values(entity?.aliases ?? {}).flat().map((alias) => alias.value)];
    return names.some((value) => normalizeLocalLogoName(value) === wanted);
  });
  // Two companies with the same name could be in different trades.
  if (exact.length !== 1) return undefined;
  const entity = parsed.entities[exact[0]];
  const linked = ["P452", "P31"].flatMap((property) => (entity.claims?.[property] ?? [])
    .filter((claim) => claim.rank !== "deprecated")
    .flatMap((claim) => {
      const value = valueSchema.safeParse(claim.mainsnak.datavalue?.value);
      return value.success ? [value.data.id] : [];
    })).slice(0, 10);
  let labels: string[] = [];
  if (linked.length) {
    const named = entitySchema.parse(await wikidata({
      action: "wbgetentities", ids: [...new Set(linked)].join("|"), props: "labels", languages: "de|en",
    }, fetcher, signal));
    labels = Object.values(named.entities).flatMap((item) => Object.values(item.labels ?? {}).map((label) => label.value));
  }
  const description = entity.descriptions?.de?.value ?? entity.descriptions?.en?.value ?? "";
  const text = [description, ...labels].join(" · ");
  const category = industryCategory(text);
  return category ? { category, label: text.slice(0, 160), source: "Wikidata" } : undefined;
}

const PARKED = /domain (?:is )?for sale|domain kaufen|zu verkaufen|parked|sedo|this domain|diese domain|coming soon|baustelle/i;
const IP_HOST = /^(?:\d{1,3}\.){3}\d{1,3}$|^\[|:/;

function decodeEntities(text: string) {
  return text.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö").replace(/&uuml;/g, "ü").replace(/&szlig;/g, "ß")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code))).replace(/\s+/g, " ").trim();
}

async function readCapped(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(size, MAX_PAGE_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.byteLength, bytes.byteLength - offset));
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.byteLength) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Only the shop's own https page; redirects are followed manually so they cannot reach local hosts.
async function fetchPage(start: URL, fetcher: typeof fetch, signal?: AbortSignal): Promise<{ url: URL; html: string } | undefined> {
  let url = start;
  for (let hop = 0; hop < 3; hop++) {
    if (url.protocol !== "https:" || IP_HOST.test(url.hostname) || url.hostname === "localhost") return undefined;
    const response = await fetcher(url, {
      headers: { Accept: "text/html", "User-Agent": USER_AGENT, "Accept-Language": "de,en;q=0.8" },
      redirect: "manual", signal: timeoutSignal(signal), cache: "no-store",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return undefined;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !/text\/html/i.test(response.headers.get("content-type") ?? "")) return undefined;
    return { url, html: await readCapped(response) };
  }
  return undefined;
}

function domainSlug(name: string) {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, "und")
    .replace(/[^a-z0-9]+/g, "");
  return slug.length >= 3 && slug.length <= 40 ? slug : undefined;
}

async function fromWebsite(name: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<Industry | undefined> {
  const slug = domainSlug(name);
  if (!slug) return undefined;
  for (const tld of ["de", "at", "com"]) {
    const page: { url: URL; html: string } | undefined =
      await fetchPage(new URL(`https://www.${slug}.${tld}/`), fetcher, signal).catch(() => undefined);
    if (!page) continue;
    // A redirect to another brand's site says nothing about this shop.
    if (!page.url.hostname.replace(/[^a-z0-9]/gi, "").toLowerCase().includes(slug)) continue;
    const title = decodeEntities(page.html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i)?.[1] ?? "");
    const meta = [...page.html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0])
      .filter((tag) => /(?:name|property)\s*=\s*["'](?:description|og:description|og:title|keywords)["']/i.test(tag))
      .map((tag) => decodeEntities(tag.match(/content\s*=\s*"([^"]{1,600})"|content\s*=\s*'([^']{1,600})'/i)?.slice(1).find(Boolean) ?? ""));
    const text = [title, ...meta].filter(Boolean).join(" · ");
    if (!text || PARKED.test(text)) continue;
    const category = industryCategory(text);
    if (category) return { category, label: `${page.url.hostname}: ${text}`.slice(0, 160), source: "Webseite" };
    return undefined;
  }
  return undefined;
}

const cache = new Map<string, Industry | null>();

export async function lookupIndustry(name: string, options: IndustryOptions = {}): Promise<Industry | undefined> {
  const key = normalizeLocalLogoName(name);
  if (key.length < 2) return undefined;
  if (cache.has(key)) return cache.get(key) ?? undefined;
  const fetcher = options.fetcher ?? fetch;
  let failed = false;
  const fail = () => { failed = true; return undefined; };
  const found = await fromWikidata(name, fetcher, options.signal).catch(fail) ??
    await fromWebsite(name, fetcher, options.signal).catch(fail);
  // Transient failures (rate limit, timeout) must not be remembered as "no industry".
  if (options.signal?.aborted || (!found && failed)) return found;
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, found ?? null);
  return found;
}

export function clearIndustryCache() {
  cache.clear();
}
