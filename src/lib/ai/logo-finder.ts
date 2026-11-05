import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { liveLogoDirectory } from "@/lib/automation/merchant-live-logo-directory";
import { normalizeLocalLogoName } from "@/lib/automation/merchant-local-logos";
import { MAX_LOGO_INPUT, normalizeLogoRaster } from "@/lib/automation/merchant-logo-raster";
import { chat, type ChatOptions } from "./client";
import { extractJsonArray } from "./categorize";
import { checkLimit, decodeEntities, domainSlug, fetchPage, IP_HOST, PARKED, politeSlot } from "./industry";

const USER_AGENT = "Finanzblick/1.0 (private dashboard; local merchant logos)";
// The live importer and the per-account quota (1024 stored logos) both stay above this.
export const MAX_DIRECTORY_FILES = 950;
const IMAGE_FILE = /\.(?:png|jpe?g|webp|avif)$/i;
const WIKI_INTERVAL_MS = 1_500;
// Browser tab favicons (16/32 px) are too blurry for a booking list.
const MIN_ICON_PIXELS = 64;
const MAX_ICON_TRIES = 5;
const TIMEOUT_MS = 10_000;

export type LogoOutcome =
  | { status: "exists"; file: string }
  | { status: "saved"; file: string; source: string; entity?: string }
  // transient: a source could not be asked (rate limit, timeout), so try again later.
  | { status: "not-found"; reason: string; transient?: boolean };

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
  return response.json() as Promise<unknown>;
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

async function chooseCandidate(
  name: string, context: string | undefined, candidates: Candidate[], ai: ChatOptions | false, confirm = false,
) {
  const wanted = normalizeLocalLogoName(name);
  const exact = candidates.filter((candidate) => candidate.names.some((value) => normalizeLocalLogoName(value) === wanted));
  if (exact.length === 1 && !confirm) return exact[0];
  if (!candidates.length || !ai) return undefined;
  // The model must positively confirm the brand; otherwise no logo is stored.
  const options = candidates.map((candidate) => `${candidate.id}: ${candidate.label} – ${candidate.description}`).join("\n");
  const answer = await chat([
    { role: "system", content: "Du ordnest einen Händlernamen aus einer österreichischen Bankbuchung dem richtigen Wikidata-Unternehmen zu. Antworte nur mit JSON: [{\"id\":\"Q…\",\"confidence\":0-100}] oder [{\"id\":null,\"confidence\":0}] wenn keiner sicher passt." },
    { role: "user", content: `Händler: ${name}${context ? `\nBuchungstext: ${context}` : ""}\nKandidaten:\n${options}` },
  ], { ...ai, maxTokens: 40 }).catch(() => undefined);
  if (!answer) return undefined;
  const parsed = z.array(z.object({ id: z.string().nullable(), confidence: z.coerce.number() }))
    .safeParse(extractJsonArray(answer.content));
  const choice = parsed.success ? parsed.data[0] : undefined;
  if (!choice?.id || choice.confidence < 90) return undefined;
  return candidates.find((candidate) => candidate.id === choice.id);
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

// Public https images only; redirects are followed by hand so they cannot reach local hosts.
async function fetchImage(start: URL, fetcher: typeof fetch, signal?: AbortSignal) {
  let url = start;
  for (let hop = 0; hop < 3; hop++) {
    if (url.protocol !== "https:" || IP_HOST.test(url.hostname) || url.hostname === "localhost") return undefined;
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

async function downloadCommonsLogo(file: string, fetcher: typeof fetch, signal: AbortSignal | undefined, interval: number) {
  const info = new URL("https://commons.wikimedia.org/w/api.php");
  info.search = new URLSearchParams({
    action: "query", titles: `File:${file}`, prop: "imageinfo", iiprop: "url", iiurlwidth: "256", format: "json",
  }).toString();
  const pages = imageInfoSchema.parse(await getJson(info, fetcher, signal, interval)).query.pages;
  const image = Object.values(pages)[0]?.imageinfo?.[0];
  const source = image?.thumburl ?? image?.url;
  if (!source) return undefined;
  const url = new URL(source);
  if (url.protocol !== "https:" || !["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname)) return undefined;
  await politeSlot(url.host, signal, interval);
  const response = await fetcher(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: timeoutSignal(signal, 15_000),
    redirect: "error",
    cache: "no-store",
  });
  checkLimit(url.host, response);
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
export function pageLogoCandidates(html: string, base: URL): URL[] {
  const found: { url: URL; score: number }[] = [];
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
    if (!/logo/i.test(hints)) continue;
    images++;
    add(src, 250 - images);
  }
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attribute(tag, "property") ?? attribute(tag, "name") ?? attribute(tag, "itemprop") ?? "").toLowerCase();
    const content = attribute(tag, "content");
    if (key === "logo" || (/^(?:og:image|twitter:image)$/.test(key) && /logo/i.test(content ?? ""))) add(content, 200);
  }
  add("/apple-touch-icon.png", 100);
  const unique = new Map<string, { url: URL; score: number }>();
  for (const entry of found) {
    const key = entry.url.href;
    if (!unique.has(key) || unique.get(key)!.score < entry.score) unique.set(key, entry);
  }
  return [...unique.values()].sort((a, b) => b.score - a.score).map((entry) => entry.url);
}

async function logoFromPage(
  page: { url: URL; html: string }, fetcher: typeof fetch, signal?: AbortSignal,
): Promise<{ png: Buffer; source: string } | undefined> {
  for (const url of pageLogoCandidates(page.html, page.url).slice(0, MAX_ICON_TRIES)) {
    signal?.throwIfAborted();
    if (url.protocol === "http:") url.protocol = "https:";
    const image = await fetchImage(url, fetcher, signal).catch(() => undefined);
    const png = image ? await logoPngFromImage(image.bytes, image.type) : undefined;
    if (png) return { png, source: url.href };
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
    const logo = await logoFromPage(page, fetcher, signal);
    if (logo) return logo;
  }
  return undefined;
}

async function logoFromWebsite(website: string, fetcher: typeof fetch, signal?: AbortSignal) {
  const url = new URL(website);
  url.protocol = "https:";
  const page = await fetchPage(url, fetcher, signal);
  if (!page) return undefined;
  return logoFromPage(page, fetcher, signal);
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
  const fail = (error: unknown) => {
    if (options.signal?.aborted) throw error;
    transient = true;
    return undefined;
  };
  // 1. The logo Wikidata records for the company, 2. its official website's icon,
  // 3. the website its name suggests.
  const candidates = (await wikidataCandidates(name, fetcher, options.signal, interval).catch(fail)) ?? [];
  const chosen = await chooseCandidate(name, context, candidates, options.ai ?? {}, options.requireConfirmation);
  let logo: { png: Buffer; source: string } | undefined;
  if (chosen?.logo) logo = await downloadCommonsLogo(chosen.logo, fetcher, options.signal, interval).catch(fail);
  if (!logo && chosen?.website) logo = await logoFromWebsite(chosen.website, fetcher, options.signal).catch(fail);
  if (!logo && !chosen && options.guessWebsite !== false)
    logo = await logoFromGuessedSite(name, fetcher, options.signal);
  if (!logo)
    return {
      status: "not-found",
      reason: chosen ? "Logo konnte nicht sicher geladen werden" : "Kein eindeutiges Unternehmen mit Logo gefunden",
      ...(transient ? { transient: true } : {}),
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
