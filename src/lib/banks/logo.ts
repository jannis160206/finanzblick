import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { IP_HOST } from "@/lib/ai/industry";
import { logoPngFromImage, pageLogoCandidates } from "@/lib/ai/logo-finder";
import { MAX_LOGO_INPUT, MAX_LOGO_STORED, readBoundedLogoFile } from "@/lib/automation/merchant-logo-raster";
import { EnableBankingClient, readEnableBankingConfig, type EnableBankingConfig } from "@/lib/banking/enable-banking";
import { bankChoices, type BankChoice } from "@/lib/banking/sync";
import { canonicalBank, normalizeBankName, type BankEntry } from "./registry";

// Server only: resolves bank logos from Enable Banking's institution list or the bank's
// official website and keeps them as re-encoded PNG files next to the merchant logos.

export type BankLogoImage = { png: Buffer; version: string };
export type ProviderBank = Pick<BankChoice, "name" | "logo">;
export type BankLogoDeps = {
  directory?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Enable Banking's banks for one country; undefined when the provider is not configured. */
  providerBanks?: (country: string) => Promise<readonly ProviderBank[] | undefined>;
  /** Runs before a lookup that needs the network (rate limit); throwing cancels it. */
  beforeLookup?: () => void;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const BANK_LOGO_MISS_RETRY_MS = 7 * DAY_MS;
const TRANSIENT_RETRY_MS = HOUR_MS;
const PROVIDER_LIST_TTL_MS = DAY_MS;
const PROVIDER_LIST_RETRY_MS = 10 * 60_000;
export const MAX_BANK_LOGO_FILES = 300;
const MEMORY_ENTRIES = 200;
const USER_AGENT = "Finanzblick/1.0 (private dashboard; local bank logos)";
const REQUEST_TIMEOUT_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 30_000;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_ICON_TRIES = 5;
// A wordmark this much wider than tall is unreadable in a square tile; a square site icon wins.
const WIDE_RATIO = 2;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CACHE_FILE = /^[a-z0-9-]{1,100}\.(?:png|miss)$/;
const missSchema = z.object({ at: z.number(), transient: z.boolean().optional() });

type Remembered = { image?: BankLogoImage; until: number };
type Lookup = { fetcher: typeof fetch; signal: AbortSignal; transient: boolean };

const memory = new Map<string, Remembered>();
const inflight = new Map<string, Promise<BankLogoImage | undefined>>();
const providerLists = new Map<string, { banks: readonly ProviderBank[] | undefined; until: number }>();
const pendingLists = new Map<string, Promise<readonly ProviderBank[] | undefined>>();

/** Sibling of the private merchant logo folder (`merchant-logos`) next to the account database. */
export function bankLogoDirectory(
  databasePath = process.env.FINANZBLICK_DATABASE_PATH || join(process.cwd(), ".local-data", "finanzblick.sqlite"),
) {
  return join(dirname(resolve(databasePath)), "bank-logos");
}

export function clearBankLogoCaches() {
  memory.clear();
  inflight.clear();
  providerLists.clear();
  pendingLists.clear();
}

const withVersion = (png: Buffer): BankLogoImage =>
  ({ png, version: createHash("sha256").update(png).digest("hex").slice(0, 16) });

function remember(id: string, value: Remembered) {
  memory.delete(id);
  memory.set(id, value);
  if (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
}

const isProviderHost = (host: string) => host === "enablebanking.com" || host.endsWith(".enablebanking.com");
const isDomainHost = (...domains: string[]) => (host: string) =>
  domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

function safeUrl(url: URL, allowed: (host: string) => boolean) {
  return url.protocol === "https:" && !url.username && !url.password && url.port === ""
    && !IP_HOST.test(url.hostname) && url.hostname.includes(".") && allowed(url.hostname);
}

/** Only https logo URLs on Enable Banking's own host are ever fetched from the provider list. */
export function isProviderLogoUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return safeUrl(new URL(value), isProviderHost);
  } catch {
    return false;
  }
}

async function discard(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

async function readLimited(response: Response, max: number, truncate: boolean) {
  const declared = Number(response.headers.get("content-length"));
  if (!truncate && Number.isFinite(declared) && declared > max) {
    await discard(response);
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      if (!truncate) return undefined;
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, max);
}

// Redirects are followed by hand so every hop stays on an allowed https host.
async function fetchAllowed(start: URL, allowed: (host: string) => boolean, kind: "page" | "image", lookup: Lookup) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!safeUrl(url, allowed)) return undefined;
    let response: Response;
    try {
      response = await lookup.fetcher(url, {
        headers: {
          Accept: kind === "page" ? "text/html" : "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8",
          "Accept-Language": "de,en;q=0.8",
          "User-Agent": USER_AGENT,
        },
        redirect: "manual",
        signal: AbortSignal.any([lookup.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        cache: "no-store",
      });
    } catch {
      lookup.transient = true;
      return undefined;
    }
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      const location = response.headers.get("location");
      if (!location) return undefined;
      try {
        url = new URL(location, url);
      } catch {
        return undefined;
      }
      continue;
    }
    const type = (response.headers.get("content-type") ?? "").trim();
    if (!response.ok || !(kind === "page" ? /^text\/html\b/i : /^image\//i).test(type)) {
      if (response.status === 429 || response.status >= 500) lookup.transient = true;
      await discard(response);
      return undefined;
    }
    const bytes = await readLimited(response, kind === "page" ? MAX_PAGE_BYTES : MAX_LOGO_INPUT, kind === "page")
      .catch(() => {
        lookup.transient = true;
        return undefined;
      });
    return bytes?.length ? { bytes, type, url } : undefined;
  }
  return undefined;
}

async function toPng(image: { bytes: Buffer; type: string }) {
  try {
    return await logoPngFromImage(image.bytes, image.type);
  } catch {
    return undefined;
  }
}

async function providerLogo(logo: string, lookup: Lookup) {
  if (!isProviderLogoUrl(logo)) return undefined;
  const image = await fetchAllowed(new URL(logo), isProviderHost, "image", lookup);
  return image ? toPng(image) : undefined;
}

// The icons the bank's official homepage declares, restricted to the registry's domains and their subdomains.
async function siteLogo(entry: BankEntry, lookup: Lookup) {
  const site = isDomainHost(entry.domain);
  const assets = isDomainHost(entry.domain, ...(entry.assetDomains ?? []));
  const transient = lookup.transient;
  for (const start of [`https://www.${entry.domain}/`, `https://${entry.domain}/`]) {
    const page = await fetchAllowed(new URL(start), site, "page", lookup);
    if (!page) continue;
    // A missing www host does not make a reachable homepage without icons a temporary failure.
    lookup.transient = transient;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(page.bytes);
    const candidates = pageLogoCandidates(html, page.url).filter((url) => assets(url.hostname)).slice(0, MAX_ICON_TRIES);
    for (const candidate of candidates) {
      if (candidate.protocol === "http:") candidate.protocol = "https:";
      const image = await fetchAllowed(candidate, assets, "image", lookup);
      const png = image ? await toPng(image) : undefined;
      if (png) return png;
    }
    return undefined;
  }
  return undefined;
}

const isWide = (png: Buffer) => png.readUInt32BE(16) > png.readUInt32BE(20) * WIDE_RATIO;

async function lookupLogo(entry: BankEntry | undefined, provider: ProviderBank | undefined, fetcher: typeof fetch) {
  const lookup: Lookup = { fetcher, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), transient: false };
  let wide: Buffer | undefined;
  if (provider?.logo) {
    const png = await providerLogo(provider.logo, lookup);
    if (png && !isWide(png)) return { png, transient: false };
    wide = png;
  }
  const site = entry ? await siteLogo(entry, lookup) : undefined;
  return { png: site ?? wide, transient: lookup.transient };
}

async function enableBankingBanks(country: string): Promise<readonly ProviderBank[] | undefined> {
  let config: EnableBankingConfig | null;
  try {
    config = readEnableBankingConfig();
  } catch {
    return undefined;
  }
  return config ? bankChoices(country, new EnableBankingClient(config)) : undefined;
}

async function providerBanksFor(country: string, deps: BankLogoDeps, now: number) {
  const cached = providerLists.get(country);
  if (cached && cached.until > now) return cached.banks;
  const pending = pendingLists.get(country);
  if (pending) return pending;
  const load = (deps.providerBanks ?? enableBankingBanks)(country)
    .then(
      (banks) => {
        providerLists.set(country, { banks, until: now + (banks ? PROVIDER_LIST_TTL_MS : PROVIDER_LIST_RETRY_MS) });
        return banks;
      },
      () => {
        providerLists.set(country, { banks: undefined, until: now + PROVIDER_LIST_RETRY_MS });
        return undefined;
      },
    )
    .finally(() => pendingLists.delete(country));
  pendingLists.set(country, load);
  return load;
}

/** Exact name first, then any provider bank the registry maps to the same entry (shortest name wins). */
export function matchProviderBank(
  banks: readonly ProviderBank[], name: string, entry?: BankEntry, country?: string,
): ProviderBank | undefined {
  const usable = banks.filter((bank) => isProviderLogoUrl(bank.logo));
  const wanted = normalizeBankName(name);
  const exact = usable.find((bank) => normalizeBankName(bank.name) === wanted);
  if (exact || !entry) return exact;
  return usable.filter((bank) => canonicalBank(bank.name, country)?.id === entry.id)
    .sort((a, b) => a.name.length - b.name.length)[0];
}

function cacheKey(entry: BankEntry | undefined, provider: ProviderBank | undefined, country: string) {
  if (entry) return entry.id;
  if (!provider) return undefined;
  const slug = normalizeBankName(provider.name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `eb-${slug || createHash("sha256").update(provider.name).digest("hex").slice(0, 16)}-${country.toLowerCase()}`;
}

async function readCache(directory: string, key: string, now: number): Promise<Remembered | undefined> {
  try {
    const png = await readBoundedLogoFile(join(directory, `${key}.png`), MAX_LOGO_STORED);
    if (png.length > 24 && png.subarray(0, 8).equals(PNG_SIGNATURE)) return { image: withVersion(png), until: now + HOUR_MS };
  } catch {
    // Missing or unsafe file: fall through to the miss marker or a new lookup.
  }
  try {
    const marker = missSchema.safeParse(JSON.parse(await readFile(join(directory, `${key}.miss`), "utf8")));
    if (!marker.success || marker.data.at > now) return undefined;
    const until = marker.data.at + (marker.data.transient ? TRANSIENT_RETRY_MS : BANK_LOGO_MISS_RETRY_MS);
    return until > now ? { until } : undefined;
  } catch {
    return undefined;
  }
}

async function cachedLogo(directory: string, key: string, now: number) {
  const id = `${directory}\0${key}`;
  const known = memory.get(id);
  if (known && known.until > now) return known;
  const stored = await readCache(directory, key, now);
  // The folder is read again at least hourly, so deleting a cached file takes effect without a restart.
  if (stored) remember(id, { ...stored, until: Math.min(stored.until, now + HOUR_MS) });
  return stored;
}

// Oldest miss markers go first, then the oldest logos, so the folder never exceeds the cap.
async function pruneCache(directory: string, keep: string) {
  const files = (await readdir(directory)).filter((file) => CACHE_FILE.test(file) && !file.startsWith(`${keep}.`));
  const excess = files.length - (MAX_BANK_LOGO_FILES - 1);
  if (excess <= 0) return;
  const dated = await Promise.all(files.map(async (file) => ({
    file,
    miss: file.endsWith(".miss"),
    at: (await stat(join(directory, file)).catch(() => undefined))?.mtimeMs ?? 0,
  })));
  dated.sort((a, b) => Number(b.miss) - Number(a.miss) || a.at - b.at);
  await Promise.all(dated.slice(0, excess).map(({ file }) => unlink(join(directory, file)).catch(() => undefined)));
}

async function writeCache(directory: string, key: string, extension: "png" | "miss", data: Buffer | string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await pruneCache(directory, key);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, join(directory, `${key}.${extension}`));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  if (extension === "png") await unlink(join(directory, `${key}.miss`)).catch(() => undefined);
}

function reportWriteError(error: unknown) {
  console.error("Bank logo cache write failed:", error instanceof Error ? error.message : "unknown error");
}

/**
 * PNG logo for a bank name: (1) the logo URL from Enable Banking's own institution list,
 * (2) the icon on the official domain from the local registry, (3) nothing. Results and misses are
 * cached on disk; misses are retried after seven days (an hour when a source was unreachable).
 */
export async function resolveBankLogo(
  input: { name: string; country?: string }, deps: BankLogoDeps = {},
): Promise<BankLogoImage | undefined> {
  const name = input.name.trim().slice(0, 120);
  if (!name) return undefined;
  const country = input.country && /^[A-Z]{2}$/.test(input.country) ? input.country : "AT";
  const clock = deps.now ?? Date.now;
  const now = clock();
  const directory = deps.directory ?? bankLogoDirectory();
  const entry = canonicalBank(name, country);
  if (entry) {
    const cached = await cachedLogo(directory, entry.id, now);
    if (cached) return cached.image;
  }
  const banks = await providerBanksFor(country, deps, now);
  const provider = banks ? matchProviderBank(banks, name, entry, country) : undefined;
  const key = cacheKey(entry, provider, country);
  if (!key) return undefined;
  if (!entry) {
    const cached = await cachedLogo(directory, key, now);
    if (cached) return cached.image;
  }
  const id = `${directory}\0${key}`;
  const running = inflight.get(id);
  if (running) return running;
  deps.beforeLookup?.();
  const task = (async () => {
    const result = await lookupLogo(entry, provider, deps.fetcher ?? fetch)
      .catch(() => ({ png: undefined, transient: true }));
    const finished = clock();
    if (result.png) {
      const image = withVersion(result.png);
      await writeCache(directory, key, "png", result.png).catch(reportWriteError);
      remember(id, { image, until: finished + HOUR_MS });
      return image;
    }
    const marker = { at: finished, ...(result.transient ? { transient: true } : {}) };
    await writeCache(directory, key, "miss", JSON.stringify(marker)).catch(reportWriteError);
    remember(id, { until: finished + HOUR_MS });
    return undefined;
  })().finally(() => inflight.delete(id));
  inflight.set(id, task);
  return task;
}
