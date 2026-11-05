import { z } from "zod";
import { normalizeLocalLogoName } from "@/lib/automation/merchant-local-logos";
import type { Category } from "@/lib/categories";

const USER_AGENT = "Finanzblick/1.0 (private dashboard; merchant industry)";
const MAX_PAGE_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;
const CACHE_LIMIT = 500;

export type IndustrySource = "OpenStreetMap" | "Wikidata" | "Webseite";
// kind: the OpenStreetMap tag ("shop=bakery"); strong: a specific shop type found under this exact name at this place.
export type Industry = { category: Category; label: string; source: IndustrySource; kind?: string; strong?: boolean };
export type MerchantPlace = { city?: string; postcode?: string };
export type IndustryOptions = { fetcher?: typeof fetch; signal?: AbortSignal; place?: MerchantPlace };

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

async function wikidata(params: Record<string, string>, fetcher: typeof fetch, signal: AbortSignal | undefined, interval: number) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  await politeSlot(url.host, signal, interval);
  url.search = new URLSearchParams({ ...params, format: "json" }).toString();
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: timeoutSignal(signal), cache: "no-store",
  });
  checkLimit(url.host, response);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function fromWikidata(name: string, fetcher: typeof fetch, signal: AbortSignal | undefined, interval: number): Promise<Industry | undefined> {
  const ids = searchSchema.parse(await wikidata({
    action: "wbsearchentities", search: name, language: "de", uselang: "de", type: "item", limit: "6",
  }, fetcher, signal, interval)).search.map((item) => item.id);
  if (!ids.length) return undefined;
  const parsed = entitySchema.parse(await wikidata({
    action: "wbgetentities", ids: ids.join("|"), props: "labels|aliases|descriptions|claims", languages: "de|en|mul",
  }, fetcher, signal, interval));
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
    }, fetcher, signal, interval));
    labels = Object.values(named.entities).flatMap((item) => Object.values(item.labels ?? {}).map((label) => label.value));
  }
  const description = entity.descriptions?.de?.value ?? entity.descriptions?.en?.value ?? "";
  const text = [description, ...labels].join(" · ");
  const category = industryCategory(text);
  return category ? { category, label: text.slice(0, 160), source: "Wikidata" } : undefined;
}

export const PARKED = /domain (?:is )?for sale|domain kaufen|zu verkaufen|parked|sedo|this domain|diese domain|coming soon|baustelle/i;
export const IP_HOST = /^(?:\d{1,3}\.){3}\d{1,3}$|^\[|:/;

export function decodeEntities(text: string) {
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
export async function fetchPage(start: URL, fetcher: typeof fetch, signal?: AbortSignal): Promise<{ url: URL; html: string } | undefined> {
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

export function domainSlug(name: string) {
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

// OpenStreetMap tag => purpose. Weak types only pre-fill the review dialog: a hotel near home is
// a day out, a bakery may be lunch; the household's own choice for that type decides later.
const OSM_TYPES: Record<string, [Category, boolean]> = {};
const osm = (category: Category, strong: boolean, ...tags: string[]) => {
  for (const tag of tags) OSM_TYPES[tag] = [category, strong];
};
osm("Lebensmittel", true, "shop=supermarket", "shop=convenience", "shop=greengrocer", "shop=butcher", "shop=deli", "shop=organic",
  "shop=farm", "shop=frozen_food", "shop=health_food", "shop=cheese", "shop=seafood", "shop=dairy");
osm("Drogerie", true, "shop=chemist", "shop=perfumery", "shop=cosmetics");
osm("Gesundheit", true, "amenity=pharmacy", "amenity=doctors", "amenity=dentist", "amenity=clinic", "amenity=hospital",
  "shop=optician", "shop=medical_supply", "shop=hearing_aids", "healthcare=*");
osm("Körperpflege", true, "shop=hairdresser", "shop=beauty", "shop=massage", "amenity=spa");
osm("Restaurants", true, "amenity=restaurant", "amenity=fast_food", "amenity=food_court");
osm("Restaurants", false, "amenity=bar", "amenity=pub", "amenity=biergarten", "amenity=nightclub");
osm("Cafés & Snacks", true, "amenity=cafe", "amenity=ice_cream", "shop=confectionery", "shop=pastry", "shop=chocolate", "shop=coffee");
osm("Cafés & Snacks", false, "shop=bakery");
osm("Tanken", true, "amenity=fuel");
osm("Parken & Maut", true, "amenity=parking", "amenity=parking_entrance", "amenity=parking_space");
osm("Reparaturen & Instandhaltung", true, "shop=hardware", "shop=doityourself", "shop=paint", "shop=trade", "shop=building_materials",
  "shop=tiles", "shop=bathroom_furnishing");
osm("Möbel & Einrichtung", true, "shop=furniture", "shop=interior_decoration", "shop=bed", "shop=kitchen", "shop=lighting",
  "shop=curtain", "shop=carpet");
osm("Wohnen & Haushalt", false, "shop=houseware", "shop=garden_centre", "shop=household_linen");
osm("Shopping", true, "shop=clothes", "shop=shoes", "shop=fashion_accessories", "shop=boutique", "shop=electronics", "shop=computer",
  "shop=mobile_phone", "shop=hifi", "shop=sports", "shop=outdoor", "shop=department_store", "shop=toys", "shop=jewelry", "shop=bag",
  "shop=variety_store", "shop=mall", "shop=second_hand", "shop=watches");
osm("Shopping", false, "shop=gift");
osm("Bildung", false, "shop=books", "shop=stationery", "amenity=library", "amenity=school", "amenity=language_school");
osm("Haustiere", true, "shop=pet", "amenity=veterinary", "shop=pet_grooming");
osm("Fahrzeugwartung", true, "shop=car_repair", "shop=tyres", "shop=car_parts", "amenity=car_wash", "craft=car_repair");
osm("Urlaub", false, "tourism=hotel", "tourism=motel", "tourism=guest_house", "tourism=hostel", "tourism=apartment",
  "tourism=chalet", "tourism=camp_site", "tourism=alpine_hut", "shop=travel_agency");
osm("Freizeit", false, "tourism=theme_park", "tourism=zoo", "tourism=aquarium", "tourism=museum", "tourism=attraction",
  "tourism=gallery", "amenity=cinema", "amenity=theatre", "amenity=arts_centre", "leisure=water_park", "leisure=swimming_pool",
  "leisure=amusement_arcade", "leisure=escape_game", "leisure=miniature_golf", "shop=ticket");
osm("Sport & Fitness", true, "leisure=fitness_centre", "leisure=sports_centre", "leisure=climbing", "leisure=sports_hall");
osm("Geschenke & Spenden", false, "shop=florist");
osm("Porto & Versand", true, "amenity=post_office");
// Places, not shops: their tags never decide anything.
const POI_CLASSES = new Set(["shop", "amenity", "tourism", "leisure", "healthcare", "craft", "office"]);

export function osmCategory(tagClass: string, tagType: string): { category: Category; strong: boolean } | undefined {
  const found = OSM_TYPES[`${tagClass}=${tagType}`] ?? OSM_TYPES[`${tagClass}=*`];
  return found ? { category: found[0], strong: found[1] } : undefined;
}

const nominatimSchema = z.array(z.object({
  category: z.string().max(40), type: z.string().max(60), name: z.string().max(300).optional().nullable(),
  display_name: z.string().max(1000),
  extratags: z.record(z.string(), z.string()).nullable().optional(),
}).loose()).max(20);
const words = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .split(/[^a-z0-9]+/).filter(Boolean);
const compact = (value: string) => words(value).join("");

// Bank texts cut names after ~22 characters ("WARMBADERHOF RESTAURA"), so each word may be a prefix.
export function osmNameMatches(query: string, name: string) {
  const wanted = words(query);
  const found = words(name);
  if (!wanted.length || !found.length) return false;
  if (wanted.every((word) => found.some((other) => other.startsWith(word)))) return true;
  const joined = compact(query);
  return joined.length >= 4 && compact(name).includes(joined);
}

function osmPlaceMatches(place: MerchantPlace, address: string) {
  if (place.postcode) return new RegExp(`(?<!\\d)${place.postcode}(?!\\d)`).test(address);
  const city = place.city ? compact(place.city).slice(0, 6) : "";
  return city.length >= 3 && compact(address).includes(city);
}

const OSM_INTERVAL_MS = 1_100;
const WIKIDATA_INTERVAL_MS = 1_500;
const BACKOFF_MS = 10 * 60_000;
const nextAt = new Map<string, number>();
const blockedUntil = new Map<string, number>();
// Nominatim's usage policy allows one request per second; Wikidata asks for serial, unhurried requests.
// After a 429/503 the host is left alone until Retry-After (else ten minutes) has passed.
export async function politeSlot(host: string, signal: AbortSignal | undefined, interval: number) {
  const now = Date.now();
  if ((blockedUntil.get(host) ?? 0) > now) throw new Error(`${host} rate limited`);
  const at = Math.max(now, nextAt.get(host) ?? 0);
  nextAt.set(host, at + interval);
  if (at > now) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, at - now);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export function checkLimit(host: string, response: Response) {
  if (response.status !== 429 && response.status !== 503) return;
  const seconds = Number(response.headers.get("retry-after"));
  blockedUntil.set(host, Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 3_600_000) : BACKOFF_MS));
}

async function nominatim(
  query: string, fetcher: typeof fetch, signal: AbortSignal | undefined, interval: number, extratags = false,
) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  await politeSlot(url.host, signal, interval);
  url.search = new URLSearchParams({ format: "jsonv2", limit: "8", q: query, ...(extratags ? { extratags: "1" } : {}) }).toString();
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, "Accept-Language": "de,en;q=0.8" },
    signal: timeoutSignal(signal), cache: "no-store",
  });
  checkLimit(url.host, response);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return nominatimSchema.parse(await response.json());
}

// The shop type OpenStreetMap records for this name at this place ("Martin Auer, Villach" => shop=bakery).
async function fromOpenStreetMap(
  name: string, place: MerchantPlace, fetcher: typeof fetch, signal: AbortSignal | undefined, interval: number,
): Promise<Industry | undefined> {
  if (compact(name).length < 3 || (!place.city && !place.postcode)) return undefined;
  const first = words(name)[0] ?? "";
  const queries = [[name, place.city].filter(Boolean).join(" "), name];
  // A cut-off last word ("RESTAURA") finds nothing on its own; the distinctive first word may.
  if (first.length >= 6 && words(name).length > 1) queries.push([name.split(/\s+/)[0], place.city].filter(Boolean).join(" "));
  for (const query of [...new Set(queries)]) {
    const results = await nominatim(query, fetcher, signal, interval);
    const matching = results.filter((item) => POI_CLASSES.has(item.category) && item.name &&
      osmNameMatches(name, item.name) && osmPlaceMatches(place, item.display_name));
    if (!matching.length) continue;
    // Two shops of that name with different trades (or an unknown trade) leave it open.
    const mapped = matching.map((item) => ({ item, found: osmCategory(item.category, item.type) }));
    if (mapped.some((entry) => !entry.found)) return undefined;
    const categories = new Set(mapped.map((entry) => entry.found!.category));
    if (categories.size !== 1) return undefined;
    const best = mapped[0];
    return {
      category: best.found!.category, source: "OpenStreetMap", kind: `${best.item.category}=${best.item.type}`,
      strong: mapped.every((entry) => entry.found!.strong),
      label: `${best.item.name} (${best.item.category}=${best.item.type}) · ${best.item.display_name}`.slice(0, 160),
    };
  }
  return undefined;
}

// The brand (Wikidata id) or website OpenStreetMap records for the shop of this name at this place.
// Only one distinct brand or site counts; two different shops of that name leave it open.
export async function openStreetMapShop(
  name: string, place: MerchantPlace, options: { fetcher?: typeof fetch; signal?: AbortSignal; throttleMs?: number } = {},
): Promise<{ wikidata?: string; website?: URL } | undefined> {
  if (compact(name).length < 3 || (!place.city && !place.postcode)) return undefined;
  const query = [name, place.city ?? place.postcode].filter(Boolean).join(" ");
  const results = await nominatim(query, options.fetcher ?? fetch, options.signal, options.throttleMs ?? OSM_INTERVAL_MS, true);
  const brands = new Set<string>();
  const sites = new Set<string>();
  for (const item of results) {
    if (!POI_CLASSES.has(item.category) || !item.name || !osmNameMatches(name, item.name) || !osmPlaceMatches(place, item.display_name))
      continue;
    const brand = item.extratags?.["brand:wikidata"];
    if (brand && /^Q\d{1,12}$/.test(brand)) brands.add(brand);
    const raw = item.extratags?.website ?? item.extratags?.["contact:website"];
    if (!raw) continue;
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      url.protocol = "https:";
      if (IP_HOST.test(url.hostname) || !url.hostname.includes(".")) continue;
      sites.add(url.origin);
    } catch {
      // A malformed tag is just skipped.
    }
  }
  const wikidata = brands.size === 1 ? [...brands][0] : undefined;
  const website = sites.size === 1 ? new URL([...sites][0]) : undefined;
  return wikidata || website ? { ...(wikidata ? { wikidata } : {}), ...(website ? { website } : {}) } : undefined;
}

const cache = new Map<string, Industry | null>();

export type IndustryLookup = { industry?: Industry; failed: boolean };

// failed: a source could not be asked (rate limit, timeout), so "nothing found" is not final.
export async function lookupIndustryResult(name: string, options: IndustryOptions & { throttleMs?: number } = {}): Promise<IndustryLookup> {
  const place = options.place ?? {};
  const key = [normalizeLocalLogoName(name), place.postcode ?? "", compact(place.city ?? "")].join("@");
  if (normalizeLocalLogoName(name).length < 2) return { failed: false };
  if (cache.has(key)) return { industry: cache.get(key) ?? undefined, failed: false };
  const fetcher = options.fetcher ?? fetch;
  let failed = false;
  const fail = () => { failed = true; return undefined; };
  const found = await fromOpenStreetMap(name, place, fetcher, options.signal, options.throttleMs ?? OSM_INTERVAL_MS).catch(fail) ??
    await fromWikidata(name, fetcher, options.signal, options.throttleMs ?? WIKIDATA_INTERVAL_MS).catch(fail) ??
    await fromWebsite(name, fetcher, options.signal).catch(fail);
  // Transient failures (rate limit, timeout) must not be remembered as "no industry".
  if (options.signal?.aborted || (!found && failed)) return { industry: found, failed: !found };
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, found ?? null);
  return { industry: found, failed: false };
}

export async function lookupIndustry(name: string, options: IndustryOptions & { throttleMs?: number } = {}): Promise<Industry | undefined> {
  return (await lookupIndustryResult(name, options)).industry;
}

export function clearIndustryCache() {
  cache.clear();
  nextAt.clear();
  blockedUntil.clear();
}
