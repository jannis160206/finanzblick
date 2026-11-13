import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { cleanUntrusted, DATA_RULE } from "./untrusted";
import { liveLogoDirectory } from "@/lib/automation/merchant-live-logo-directory";
import { normalizeLocalLogoName } from "@/lib/automation/merchant-local-logos";
import { MAX_LOGO_INPUT, normalizeLogoRaster } from "@/lib/automation/merchant-logo-raster";
import { chat, type ChatOptions } from "./client";
import { extractJsonArray } from "./categorize";
import {
  checkLimit, decodeEntities, domainSlug, fetchPage, IP_HOST, type MerchantPlace, openStreetMapShop, PARKED, pauseHost, politeSlot,
} from "./industry";

const USER_AGENT = "Finanzblick/1.0 (private dashboard; local merchant logos)";
// The live importer and the per-account quota (1024 stored logos) both stay above this.
export const MAX_DIRECTORY_FILES = 950;
const IMAGE_FILE = /\.(?:png|jpe?g|webp|avif)$/i;
const WIKI_INTERVAL_MS = 1_500;
// Browser tab favicons (16/32 px) are too blurry for a booking list.
const MIN_ICON_PIXELS = 64;
const MAX_ICON_TRIES = 5;
const TIMEOUT_MS = 10_000;
const API_BUSY_PAUSE_MS = 120_000;

export type LogoOutcome =
  | { status: "exists"; file: string }
  | { status: "saved"; file: string; source: string; entity?: string }
  // transient: a source could not be asked (rate limit, timeout), so try again later.
  // needsModel: several companies carry the name and only the local model could tell them apart.
  | { status: "not-found"; reason: string; transient?: boolean; needsModel?: boolean; cause?: string };

export type LogoFinderOptions = {
  directory?: string;
  fetcher?: typeof fetch;
  ai?: ChatOptions | false;
  signal?: AbortSignal;
  /** Try www.<name>.at/.de/.com when no registry knows the merchant (default true). */
  guessWebsite?: boolean;
  /** File name to store the logo under when the search name differs (alias "OBI SAGT DANKE", search "OBI"). */
  saveAs?: string;
  /** A shortened name ("Europa" from "Europa Park Rust") needs the model's confirmation, not just an exact label. */
  requireConfirmation?: boolean;
  /** Where the card was used; lets OpenStreetMap name the local shop's website. */
  place?: MerchantPlace;
  /** Known identity of the merchant (curated brand or the user's override): skips the name search. */
  hint?: { wikidata?: string; website?: string };
  throttleMs?: number;
};

// Windows-safe file name whose normalized form still matches the merchant alias.
export function logoFileName(name: string) {
  const base = name.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ")
    .trim().replace(/[. ]+$/, "").slice(0, 90);
  if (normalizeLocalLogoName(base) !== normalizeLocalLogoName(name) || normalizeLocalLogoName(base).length < 2)
    return undefined;
  return `${base}.png`;
}

export async function logoDirectoryFiles(directory = liveLogoDirectory()) {
  try {
    return (await readdir(directory)).filter((file) => IMAGE_FILE.test(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function existingLogo(directory: string, name: string) {
  const wanted = normalizeLocalLogoName(name);
  const images = await logoDirectoryFiles(directory);
  const match = images.find((file) => normalizeLocalLogoName(file.replace(IMAGE_FILE, "")) === wanted);
  return { count: images.length, match };
}

const searchSchema = z.object({ search: z.array(z.object({ id: z.string().regex(/^Q\d+$/) })).max(10) });
const entitySchema = z.object({
  entities: z.record(z.string(), z.object({
    id: z.string(),
    labels: z.record(z.string(), z.object({ value: z.string() })).optional(),
    aliases: z.record(z.string(), z.array(z.object({ value: z.string() }))).optional(),
    descriptions: z.record(z.string(), z.object({ value: z.string() })).optional(),
    claims: z.record(z.string(), z.array(z.object({
      mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).optional() }),
      rank: z.string().optional(),
    }).loose())).optional(),
  }).loose()),
});
const imageInfoSchema = z.object({
  query: z.object({
    pages: z.record(z.string(), z.object({
      imageinfo: z.array(z.object({ thumburl: z.string().url().optional(), url: z.string().url() })).optional(),
    }).loose()),
  }),
});

type Candidate = {
  id: string; label: string; names: string[]; description: string; logo?: string; website?: string;
};

function timeoutSignal(signal?: AbortSignal, ms = TIMEOUT_MS) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function getJson(url: URL, fetcher: typeof fetch, signal: AbortSignal | undefined, interval: number) {
  await politeSlot(url.host, signal, interval);
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: timeoutSignal(signal),
    cache: "no-store",
  });
  checkLimit(url.host, response);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as unknown;
  // MediaWiki reports overload inside a 200 answer ("cirrussearch-too-busy-error", "maxlag", "ratelimited").
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof code === "string") {
    if (/busy|maxlag|ratelimit|readonly/i.test(code)) pauseHost(url.host, API_BUSY_PAUSE_MS);
    throw new Error(`${url.host}: ${code}`);
  }
  return body;
}

function claimValue(entity: z.infer<typeof entitySchema>["entities"][string], property: string) {
  const value = entity.claims?.[property]?.find((claim) => claim.rank !== "deprecated")?.mainsnak.datavalue?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function wikidataCandidates(
  name: string, fetcher: typeof fetch, signal: AbortSignal | undefined, interval: number,
): Promise<Candidate[]> {
  const search = new URL("https://www.wikidata.org/w/api.php");
  search.search = new URLSearchParams({
    action: "wbsearchentities", search: name, language: "de", uselang: "de", type: "item", limit: "6", format: "json",
  }).toString();
  const ids = searchSchema.parse(await getJson(search, fetcher, signal, interval)).search.map((item) => item.id);
  return wikidataEntities(ids, fetcher, signal, interval);
}

async function wikidataEntities(
  ids: string[], fetcher: typeof fetch, signal: AbortSignal | undefined, interval: number,
): Promise<Candidate[]> {
  if (!ids.length) return [];
  const entities = new URL("https://www.wikidata.org/w/api.php");
  entities.search = new URLSearchParams({
    action: "wbgetentities", ids: ids.join("|"), props: "labels|aliases|descriptions|claims",
    languages: "de|en|mul", format: "json",
  }).toString();
  const parsed = entitySchema.parse(await getJson(entities, fetcher, signal, interval));
  return ids.flatMap((id) => {
    const entity = parsed.entities[id];
    if (!entity) return [];
    const logo = claimValue(entity, "P154");
    const website = claimValue(entity, "P856");
    if (!logo && !(website && /^https?:\/\//i.test(website))) return [];
    const labels = Object.values(entity.labels ?? {}).map((label) => label.value);
    const aliases = Object.values(entity.aliases ?? {}).flat().map((alias) => alias.value);
    return [{
      id, ...(logo ? { logo } : {}), ...(website ? { website } : {}),
      label: entity.labels?.de?.value ?? entity.labels?.mul?.value ?? entity.labels?.en?.value ?? labels[0] ?? id,
      names: [...new Set([...labels, ...aliases])],
      description: entity.descriptions?.de?.value ?? entity.descriptions?.en?.value ?? "",
    }];
  });
}

// Descriptions of things that carry a shop's name without being one: places, people, works.
const NOT_A_BUSINESS = /\b(?:familienname|vorname|nachname|given name|family name|surname|gemeinde\b|\w*stadt\b|dorf\b|\w*bezirk\b|borough|district|county|provinz|province|landkreis|gymnasium|schule\b|school|universität|university|hochschule|ortschaft|ortsteil|stadtteil|bezirk|municipality|city in|city of|capital|town in|village|commune|fluss|river|berg in|mountain|film|album|single|song|lied|roman\b|novel|episode|fernsehserie|television series|musiker|musician|sänger|singer|politiker|politician|fußballspieler|footballer|schauspieler|actor|actress|asteroid|gattung|genus|species|protein|wikimedia)/i;
// Descriptions of companies and brands, in German and English.
const BUSINESS = /(?:unternehmen|firma|konzern|kette|marke|handel|supermarkt|discounter|drogerie|restaurant|fast.?food|gastronomie|bank|versicherung|hotel|tankstelle|mineralöl|telekom|mobilfunk|fluggesellschaft|airline|company|corporation|brand|retail|chain|supermarket|store|operator|betreiber|anbieter|dienstleist|plattform|platform|website|online|hersteller|manufacturer|verkehrs|logistik|lieferdienst|delivery|streaming|software|publisher|entwickler|developer|carrier|railway|bahn)/i;

/** place: the name only belongs to towns, people or works, so no website of that name is a shop's either. */
type Choice = { chosen?: Candidate; needsModel?: boolean; place?: boolean };

async function chooseCandidate(
  name: string, context: string | undefined, candidates: Candidate[], ai: ChatOptions | false, confirm = false,
): Promise<Choice> {
  // Accents and case do not matter ("ΚΑΦΕΝΕΙΟ" is "Καφενείο").
  const fold = (value: string) => normalizeLocalLogoName(value.normalize("NFKD").replace(/\p{M}/gu, ""));
  const wanted = fold(name);
  const named = candidates.filter((candidate) => candidate.names.some((value) => fold(value) === wanted));
  // A town's website or a surname's namesake is never a shop's logo.
  const exact = named.filter((candidate) => !NOT_A_BUSINESS.test(candidate.description));
  if (named.length && !exact.length) return { place: true };
  if (!confirm) {
    if (exact.length === 1) return { chosen: exact[0] };
    // Several entries of one brand (the company and its trademark) share their logo or website.
    const marks = new Set(exact.map((candidate) => candidate.logo ?? candidate.website));
    if (exact.length > 1 && marks.size === 1) return { chosen: exact[0] };
    const businesses = exact.filter((candidate) => BUSINESS.test(candidate.description));
    if (businesses.length === 1) return { chosen: businesses[0] };
  }
  // The model only picks among real brands with their own Commons logo: it confused short or local names
  // with a pistol, a London borough, a school and an Israeli broadcaster when websites were allowed.
  const brands = candidates.filter((candidate) => candidate.logo && !NOT_A_BUSINESS.test(candidate.description));
  if (!brands.length || (wanted.match(/\p{L}/gu)?.length ?? 0) < 3) return {};
  if (!ai) return { needsModel: true };
  // The model must positively confirm the brand; otherwise no logo is stored.
  const options = brands.map((candidate) => `${candidate.id}: ${cleanUntrusted(candidate.label, 120)} – ${cleanUntrusted(candidate.description, 200)}`).join("\n");
  const answer = await chat([
    { role: "system", content: "Du ordnest einen Händlernamen aus einer österreichischen Bankbuchung dem richtigen Wikidata-Unternehmen zu. Antworte nur mit JSON: [{\"id\":\"Q…\",\"confidence\":0-100}] oder [{\"id\":null,\"confidence\":0}] wenn keiner sicher passt. " + DATA_RULE },
    { role: "user", content: `Händler: ${cleanUntrusted(name, 120)}${context ? `\nBuchungstext: ${cleanUntrusted(context, 300)}` : ""}\nKandidaten:\n${options}` },
  ], { ...ai, maxTokens: 40 }).catch(() => undefined);
  if (!answer) return { needsModel: true };
  const parsed = z.array(z.object({ id: z.string().nullable(), confidence: z.coerce.number() }))
    .safeParse(extractJsonArray(answer.content));
  const choice = parsed.success ? parsed.data[0] : undefined;
  if (!choice?.id || choice.confidence < 90) return {};
  const chosen = brands.find((candidate) => candidate.id === choice.id);
  return chosen ? { chosen } : {};
}

async function readBytes(response: Response, max: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return undefined;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer()).subarray(0, max + 1);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Social networks' own icons: a shop page links them, but they are never the shop's logo.
// Domain marketplaces and parking pages show their own branding on any name for sale.
const PARKING_HOST = /(?:^|\.)(?:domainmarket\.com|dan\.com|sedo\.com|sedoparking\.com|afternic\.com|hugedomains\.com|bodis\.com|parkingcrew\.net|above\.com|undeveloped\.com|godaddy\.com|parklogic\.com|domainnameshop\.com)$/i;
const SOCIAL_HOST = /(?:^|\.)(?:facebook\.com|fbcdn\.net|instagram\.com|twitter\.com|x\.com|twimg\.com|youtube\.com|ytimg\.com|linkedin\.com|licdn\.com|tiktok\.com|pinterest\.com|whatsapp\.com|tripadvisor\.[a-z.]+|google\.com|gstatic\.com)$/i;
const siteOf = (host: string) => host.toLowerCase().split(".").slice(-2).join(".");

// Public https images only; redirects are followed by hand so they cannot reach local hosts, and an icon that
// redirects to another site (a parked "/apple-touch-icon.png" sending to Facebook) is not the shop's.
async function fetchImage(start: URL, fetcher: typeof fetch, signal?: AbortSignal) {
  let url = start;
  for (let hop = 0; hop < 3; hop++) {
    if (url.protocol !== "https:" || IP_HOST.test(url.hostname) || url.hostname === "localhost" || SOCIAL_HOST.test(url.hostname) ||
      PARKING_HOST.test(url.hostname))
      return undefined;
    if (hop > 0 && siteOf(url.hostname) !== siteOf(start.hostname)) return undefined;
    const response = await fetcher(url, {
      headers: { Accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8", "User-Agent": USER_AGENT },
      redirect: "manual", signal: timeoutSignal(signal), cache: "no-store",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return undefined;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) return undefined;
    const bytes = await readBytes(response, MAX_LOGO_INPUT);
    return bytes?.length ? { bytes, type: response.headers.get("content-type") ?? "" } : undefined;
  }
  return undefined;
}

const UNSAFE_SVG = /<!ENTITY|<!DOCTYPE|<script\b|<image\b|<foreignObject\b|<use\b[^>]*href\s*=\s*["'](?!#)|url\(\s*["']?(?!#)/i;

// Square PNG for the logo folder; SVG logos are rendered without any external resources.
export async function logoPngFromImage(bytes: Buffer, type = "") {
  const head = bytes.subarray(0, 512).toString("utf8");
  if (/svg/i.test(type) || /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(head)) {
    const text = bytes.toString("utf8");
    if (!/<svg\b/i.test(text) || UNSAFE_SVG.test(text)) return undefined;
    const raster = await sharp(bytes, { density: 300, limitInputPixels: 16_000_000 })
      .resize(256, 256, { fit: "inside" }).png().toBuffer().catch(() => undefined);
    return raster ? (await normalizeLogoRaster(raster, { suppliedLocalFile: true })) ?? undefined : undefined;
  }
  const meta = await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata().catch(() => undefined);
  if (!meta?.width || !meta.height || Math.min(meta.width, meta.height) < MIN_ICON_PIXELS) return undefined;
  return (await normalizeLogoRaster(bytes, { suppliedLocalFile: true })) ?? undefined;
}

export async function blankOnWhite(png: Buffer) {
  const flat = await sharp(png).flatten({ background: "#ffffff" }).png().toBuffer().catch(() => undefined);
  const stats = flat ? await sharp(flat).stats().catch(() => undefined) : undefined;
  return !!stats && stats.channels.slice(0, 3).every((channel) => channel.stdev < 3);
}

async function downloadCommonsLogo(file: string, fetcher: typeof fetch, signal: AbortSignal | undefined, interval: number) {
  const info = new URL("https://commons.wikimedia.org/w/api.php");
  info.search = new URLSearchParams({
    action: "query", titles: `File:${file}`, prop: "imageinfo", iiprop: "url", iiurlwidth: "256", format: "json",
  }).toString();
  // A logo file Commons no longer has (renamed, deleted) is no pause, just no logo.
  const pages = imageInfoSchema.safeParse(await getJson(info, fetcher, signal, interval)).data?.query.pages ?? {};
  const image = Object.values(pages)[0]?.imageinfo?.[0];
  const source = image?.thumburl ?? image?.url;
  if (!source) return undefined;
  const url = new URL(source);
  if (url.protocol !== "https:" || !["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname)) return undefined;
  await politeSlot(url.host, signal, interval);
  const response = await fetcher(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: timeoutSignal(signal, 15_000),
    redirect: "manual",
    cache: "no-store",
  });
  checkLimit(url.host, response);
  if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
  if (!response.ok) return undefined;
  const bytes = await readBytes(response, MAX_LOGO_INPUT);
  const png = bytes ? await logoPngFromImage(bytes, response.headers.get("content-type") ?? "") : undefined;
  return png ? { png, source: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, "_"))}` } : undefined;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  const value = match?.slice(1).find((part) => part !== undefined);
  return value === undefined ? undefined : decodeEntities(value);
}

// Logo candidates a homepage declares, best first: the square app icon, a vector
// icon, large icons, the header logo, a logo share image, the classic touch icon.
export function pageLogoCandidates(html: string, base: URL, brand?: string): URL[] {
  const found: { url: URL; score: number }[] = [];
  // A page logo image must carry the brand or the site's name; footers also show partners' and agencies' logos.
  const own = [base.hostname.replace(/^www\./i, "").split(".")[0], ...(brand ?? "").split(/\s+/)]
    .map(siteSlug).filter((word) => word.length >= 3);
  const add = (href: string | undefined, score: number) => {
    if (!href || /^data:/i.test(href.trim())) return;
    try {
      const url = new URL(href.trim(), base);
      if (url.protocol === "https:" || url.protocol === "http:") found.push({ url, score });
    } catch {
      // Ignore malformed URLs.
    }
  };
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attribute(tag, "rel") ?? "").toLowerCase();
    const href = attribute(tag, "href");
    const size = Math.max(0, ...[...(attribute(tag, "sizes") ?? "").matchAll(/(\d+)x(\d+)/gi)]
      .map((match) => Math.min(Number(match[1]), Number(match[2]))));
    if (/apple-touch-icon/.test(rel)) add(href, 400 + Math.min(size, 512) / 10);
    else if (/(?:^|\s)icon(?:\s|$)/.test(rel) && !/mask-icon/.test(rel)) {
      const vector = /svg/i.test(attribute(tag, "type") ?? "") || /\.svg(?:[?#]|$)/i.test(href ?? "");
      add(href, vector ? 350 : size >= 96 ? 300 + Math.min(size, 512) / 10 : 60);
    }
  }
  let images = 0;
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    if (images >= 3) break;
    const src = attribute(tag, "src") ?? attribute(tag, "data-src");
    const hints = [src, attribute(tag, "alt"), attribute(tag, "class"), attribute(tag, "id")].join(" ");
    if (!/logo/i.test(hints) || !own.some((word) => siteSlug(hints).includes(word))) continue;
    images++;
    add(src, 250 - images);
  }
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attribute(tag, "property") ?? attribute(tag, "name") ?? attribute(tag, "itemprop") ?? "").toLowerCase();
    const content = attribute(tag, "content");
    if (key === "logo" || (/^(?:og:image|twitter:image)$/.test(key) && /logo/i.test(content ?? ""))) add(content, 200);
  }
  // The organization's logo from its structured data: "logo": "…" or "logo": { "url": "…" }.
  for (const [, script] of html.matchAll(/<script\b[^>]*application\/ld\+json[^>]*>([\s\S]{0,20000}?)<\/script>/gi)) {
    for (const match of script.matchAll(/"logo"\s*:\s*(?:"([^"]{1,500})"|\{[^{}]{0,500}?"(?:url|contentUrl)"\s*:\s*"([^"]{1,500})")/g))
      add((match[1] ?? match[2]).replace(/\\\//g, "/"), 270);
  }
  add("/apple-touch-icon.png", 100);
  const unique = new Map<string, { url: URL; score: number }>();
  for (const entry of found) {
    const key = entry.url.href;
    if (!unique.has(key) || unique.get(key)!.score < entry.score) unique.set(key, entry);
  }
  return [...unique.values()].sort((a, b) => b.score - a.score).map((entry) => entry.url);
}

const manifestSchema = z.object({
  icons: z.array(z.object({ src: z.string().max(500), sizes: z.string().max(100).optional(), purpose: z.string().max(60).optional() }).loose()).max(40),
}).loose();

// The app icons of the site's web app manifest, largest first (192–512 px squares, made for home screens).
async function manifestIcons(page: { url: URL; html: string }, fetcher: typeof fetch, signal?: AbortSignal): Promise<URL[]> {
  const tag = [...page.html.matchAll(/<link\b[^>]*>/gi)].map(([value]) => value)
    .find((value) => /(?:^|\s)manifest(?:\s|$)/i.test(attribute(value, "rel") ?? ""));
  const href = tag && attribute(tag, "href");
  if (!href) return [];
  let url: URL;
  try {
    url = new URL(href, page.url);
  } catch {
    return [];
  }
  if (url.protocol === "http:") url.protocol = "https:";
  const file = await fetchImage(url, fetcher, signal).catch(() => undefined);
  if (!file || file.bytes.length > 64 * 1024) return [];
  let parsed: z.infer<typeof manifestSchema> | undefined;
  try {
    parsed = manifestSchema.safeParse(JSON.parse(file.bytes.toString("utf8"))).data;
  } catch {
    return [];
  }
  const size = (sizes = "") => Math.max(0, ...[...sizes.matchAll(/(\d+)x(\d+)/gi)].map((match) => Math.min(Number(match[1]), Number(match[2]))));
  return (parsed?.icons ?? [])
    .filter((icon) => !/monochrome/i.test(icon.purpose ?? "") && (size(icon.sizes) >= 96 || /\.svg(?:[?#]|$)/i.test(icon.src)))
    .sort((left, right) => Math.min(size(right.sizes), 512) - Math.min(size(left.sizes), 512))
    .flatMap((icon) => {
      try {
        return [new URL(icon.src, url)];
      } catch {
        return [];
      }
    });
}

async function logoFromPage(
  page: { url: URL; html: string }, fetcher: typeof fetch, signal?: AbortSignal, brand?: string,
  seen?: { pictures: number },
): Promise<{ png: Buffer; source: string } | undefined> {
  // A page that loads its pictures from a domain marketplace is a name for sale.
  if (PARKING_HOST.test(page.url.hostname) || /\/\/(?:[\w-]+\.)*(?:domainmarket\.com|dan\.com|sedo\.com|afternic\.com|hugedomains\.com)\//i.test(page.html))
    return undefined;
  const [best, ...rest] = pageLogoCandidates(page.html, page.url, brand);
  // The manifest's app icon comes right after the best icon the page names itself, before guessed paths.
  const manifest = (await manifestIcons(page, fetcher, signal)).slice(0, 2);
  const ordered = best && best.pathname !== "/apple-touch-icon.png" ? [best, ...manifest, ...rest] : [...manifest, ...(best ? [best] : []), ...rest];
  const candidates = [...new Map(ordered.map((url) => [url.href, url])).values()];
  for (const url of candidates.slice(0, MAX_ICON_TRIES)) {
    signal?.throwIfAborted();
    if (url.protocol === "http:") url.protocol = "https:";
    const image = await fetchImage(url, fetcher, signal).catch(() => undefined);
    const png = image ? await logoPngFromImage(image.bytes, image.type) : undefined;
    // A white logo for dark headers or a plain colour square shows nothing on the light badge: try the next icon.
    if (png && !(await blankOnWhite(png))) return { png, source: url.href };
    if (png && seen) seen.pictures++;
  }
  return undefined;
}

const siteSlug = (text: string) => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/&/g, "und").replace(/[^a-z0-9]+/g, "");

// www.<name>.at/.de/.com, only when the page really presents that brand and is no parked domain.
async function logoFromGuessedSite(name: string, fetcher: typeof fetch, signal?: AbortSignal) {
  const slug = domainSlug(name);
  if (!slug) return undefined;
  for (const tld of ["at", "de", "com"]) {
    signal?.throwIfAborted();
    const page: { url: URL; html: string } | undefined = await fetchPage(new URL(`https://www.${slug}.${tld}/`), fetcher, signal)
      .catch(() => undefined);
    if (!page || !siteSlug(page.url.hostname).includes(slug)) continue;
    const title = decodeEntities(page.html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i)?.[1] ?? "");
    const siteName: string = [...page.html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => tag)
      .filter((tag) => /(?:property|name)\s*=\s*["'](?:og:site_name|application-name|og:title)["']/i.test(tag))
      .map((tag) => attribute(tag, "content") ?? "").join(" ");
    const text: string = `${title} ${siteName}`;
    if (!text.trim() || PARKED.test(text) || !siteSlug(text).includes(slug)) continue;
    const seen = { pictures: 0 };
    const logo = await logoFromPage(page, fetcher, signal, name, seen);
    // A site presenting the brand with pictures that only show nothing here (a white logo) is the merchant's;
    // the same name under another ending is a namesake then.
    if (logo || seen.pictures) return logo;
  }
  return undefined;
}

async function logoFromWebsite(website: string, fetcher: typeof fetch, signal?: AbortSignal, brand?: string) {
  const url = new URL(website);
  url.protocol = "https:";
  const page = await fetchPage(url, fetcher, signal);
  if (!page) return undefined;
  return logoFromPage(page, fetcher, signal, brand);
}

export async function findMerchantLogo(
  name: string, context: string | undefined, options: LogoFinderOptions = {},
): Promise<LogoOutcome> {
  const file = logoFileName(options.saveAs ?? name);
  if (!file || !logoFileName(name)) return { status: "not-found", reason: "Ungültiger Händlername" };
  const directory = options.directory ?? liveLogoDirectory();
  const existing = await existingLogo(directory, options.saveAs ?? name);
  if (existing.match) return { status: "exists", file: existing.match };
  if (existing.count >= MAX_DIRECTORY_FILES) return { status: "not-found", reason: "Logo-Ordner ist voll" };
  const fetcher = options.fetcher ?? fetch;
  const interval = options.throttleMs ?? WIKI_INTERVAL_MS;
  let transient = false;
  let cause: string | undefined;
  // A registry that cannot answer now (rate limit, timeout) is asked again soon.
  const fail = (error: unknown) => {
    if (options.signal?.aborted) throw error;
    transient = true;
    cause ??= error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 160) : "unknown";
    return undefined;
  };
  // A shop's own website that does not load is simply no source; it must not hold up the merchants after it.
  const unavailable = (error: unknown) => {
    if (options.signal?.aborted) throw error;
    return undefined;
  };
  // 0. A known identity (curated brand, the user's override), 1. the logo Wikidata records for the company,
  // 2. its official website's icon, 3. the brand or website OpenStreetMap records for the shop where the
  // card was used, 4. the website its name suggests.
  const hinted = options.hint?.wikidata
    ? (await wikidataEntities([options.hint.wikidata], fetcher, options.signal, interval).catch(fail))?.[0] : undefined;
  const found = hinted || options.hint?.website ? undefined : await wikidataCandidates(name, fetcher, options.signal, interval).catch(fail);
  const choice: Choice = hinted || options.hint?.website ? { chosen: hinted }
    : await chooseCandidate(name, context, found ?? [], options.ai ?? {}, options.requireConfirmation);
  // Without Wikidata's answer nobody knows whether the name is a town or a person: no guessing then.
  const registryAnswered = !!(hinted || options.hint?.website) || found !== undefined;
  let chosen = choice.chosen;
  const shop = !chosen && !options.hint && options.place
    ? await openStreetMapShop(name, options.place, { fetcher, signal: options.signal, throttleMs: options.throttleMs }).catch(fail)
    : undefined;
  if (shop?.wikidata)
    chosen = (await wikidataEntities([shop.wikidata], fetcher, options.signal, interval).catch(fail))?.[0];
  let logo: { png: Buffer; source: string } | undefined;
  if (chosen?.logo) logo = await downloadCommonsLogo(chosen.logo, fetcher, options.signal, interval).catch(fail);
  if (!logo && options.hint?.website) logo = await logoFromWebsite(options.hint.website, fetcher, options.signal, name).catch(unavailable);
  if (!logo && chosen?.website) logo = await logoFromWebsite(chosen.website, fetcher, options.signal, chosen.label).catch(unavailable);
  if (!logo && shop?.website) logo = await logoFromWebsite(shop.website.href, fetcher, options.signal, name).catch(unavailable);
  if (!logo && !chosen && !shop && !options.hint && !choice.place && registryAnswered && options.guessWebsite !== false)
    logo = await logoFromGuessedSite(name, fetcher, options.signal);
  if (!logo)
    return {
      status: "not-found",
      reason: chosen || options.hint ? "Logo konnte nicht sicher geladen werden"
        : choice.needsModel ? "Mehrere Unternehmen dieses Namens, lokale KI nötig" : "Kein eindeutiges Unternehmen mit Logo gefunden",
      ...(transient ? { transient: true, ...(cause ? { cause } : {}) } : {}), ...(choice.needsModel && !chosen ? { needsModel: true } : {}),
    };
  await mkdir(directory, { recursive: true });
  // The live importer ignores the temporary name, so it never sees a partial file.
  const temporary = join(directory, `.ai-${randomUUID()}.tmp`);
  await writeFile(temporary, logo.png, { flag: "wx" });
  try {
    await rename(temporary, join(directory, file));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { status: "saved", file, source: logo.source, ...(chosen ? { entity: chosen.id } : {}) };
}
