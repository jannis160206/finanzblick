import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { isAtmBooking } from "@/lib/atm-logo";
import { actualBookings, classify } from "@/lib/calc";
import { shouldShowMerchantMark } from "@/lib/merchant-mark-policy";
import type { AppState, Transaction } from "@/lib/types";
import { localLogoGrants, normalizeLocalLogoName } from "@/lib/automation/merchant-local-logos";
import { readAuthorizedMerchantLogo } from "@/lib/automation/merchant-logo-grants";
import type { AuthorizedLogoGrant } from "@/lib/automation/merchant-logo-grant-metadata";
import { readPrivateMerchantLogo } from "@/lib/automation/merchant-logo";
import { MerchantLogoRequest } from "@/lib/automation/merchant-logo-request";
import { merchantLogoName } from "@/lib/automation/merchant-mark-name";
import { normalizeMerchantDescriptor } from "@/lib/automation/merchants";
import type { AutomationStore } from "@/lib/automation/store";
import { type BookingLogo, bookingLogoMarks, logoTarget, personTransfer, tradeWordName } from "./logo-sweep";
import { webTarget } from "./web-categories";

export const LOGO_EVAL_VERSION = 1;

/** merchant: a shop or company; person: a transfer to someone (initials are right); atm: the operator's bank. */
export type LogoKind = "merchant" | "person" | "atm";
export type LogoSource = "Logo-Ordner" | "Wikimedia (freigegeben)" | "Katalog";
export type LogoVerdict = "ok" | "wrong" | "generic";
/** correct: checked by eye; unchecked: has a logo nobody looked at; wrong/generic: by verdict or automatic check. */
export type LogoStatus = "correct" | "unchecked" | "wrong" | "generic" | "missing";

export type LogoInfo = {
  merchantId: string;
  version: string;
  source: LogoSource;
  /** The supplied file's name or the catalogue merchant it belongs to. */
  name: string;
  /** Automatic findings: blank image, same picture as another brand, generic or place name. */
  flags: string[];
};

export type LogoSample = { id: string; date: string; bank: string; amount: number; text: string };

export type MerchantLogoRecord = {
  key: string;
  name: string;
  kind: LogoKind;
  bookings: number;
  withLogo: number;
  logo: LogoInfo | null;
  /** Different logos among its bookings; more than one means the merchant looks inconsistent. */
  logos: number;
  /** Names the background search tries, most specific first; empty: never searched. */
  queries: string[];
  /** Supplied files whose name appears in its bookings but which none of them shows. */
  unusedFiles: string[];
  samples: LogoSample[];
  verdict?: LogoVerdict;
  status: LogoStatus;
};

export type LogoVerdicts = Record<string, { verdict: LogoVerdict; version: string | null; note?: string }>;

export type LogoTally = { merchants: number; withLogo: number; correct: number; unchecked: number; wrong: number; generic: number; missing: number; bookings: number; bookingsWithLogo: number };

const BLANK_DEVIATION = 3;
// Findings that make a logo generic on their own; a duplicate picture only asks for a look (Amex, American Express).
const GENERIC_FLAGS = new Set(["leeres Bild", "Branchenwort als Name", "Ortsname als Name"]);
const MAX_SAMPLES = 3;

function tallyOf(records: readonly MerchantLogoRecord[]): LogoTally {
  const count = (status: LogoStatus) => records.filter((record) => record.status === status).length;
  return {
    merchants: records.length,
    withLogo: records.filter((record) => record.logo).length,
    correct: count("correct"),
    unchecked: count("unchecked"),
    wrong: count("wrong"),
    generic: count("generic"),
    missing: count("missing"),
    bookings: records.reduce((sum, record) => sum + record.bookings, 0),
    bookingsWithLogo: records.reduce((sum, record) => sum + record.withLogo, 0),
  };
}

export function summarizeLogos(records: readonly MerchantLogoRecord[]) {
  const byKind = (kind: LogoKind) => tallyOf(records.filter((record) => record.kind === kind));
  return { merchant: byKind("merchant"), atm: byKind("atm"), person: byKind("person"), all: tallyOf(records) };
}

/** Logo picture facts that need no eyes: a blank square or the same picture shown for another brand. */
export async function logoPicture(png: Buffer): Promise<{ blank: boolean; fingerprint: string } | undefined> {
  // stats() reads the input, so transparency is flattened onto white first: a black logo on clear ground is not blank.
  const flat = await sharp(png, { limitInputPixels: 16_000_000 }).flatten({ background: "#ffffff" }).png().toBuffer().catch(() => undefined);
  if (!flat) return undefined;
  const stats = await sharp(flat).stats().catch(() => undefined);
  const raw = await sharp(flat).resize(24, 24, { fit: "contain", background: "#ffffff" }).greyscale().raw().toBuffer().catch(() => undefined);
  if (!stats || !raw) return undefined;
  const blank = stats.channels.slice(0, 3).every((channel) => channel.stdev < BLANK_DEVIATION);
  // Coarse levels so re-encoded copies of one picture still compare equal.
  const fingerprint = createHash("sha256").update(raw.map((value) => value >> 4)).digest("hex").slice(0, 16);
  return { blank, fingerprint };
}

const sampleOf = (row: Transaction): LogoSample => ({
  id: row.id, date: row.date, bank: row.bank, amount: row.amount,
  text: [row.merchantAlias, row.description].filter(Boolean).join(" · ").slice(0, 160),
});

function kindOf(row: Transaction): LogoKind {
  if (isAtmBooking(row)) return "atm";
  return !webTarget(row) && personTransfer(row) ? "person" : "merchant";
}

function keyOf(row: Transaction, kind: LogoKind, catalogueName: (id: string) => string | undefined) {
  const target = kind === "atm" ? undefined : logoTarget(row);
  if (target) return { key: target.key, name: target.saveAs ?? target.queries[0] ?? target.key, queries: target.queries };
  const named = merchantLogoName(row) ?? (row.merchantId ? catalogueName(row.merchantId) : undefined) ?? row.merchantAlias?.trim();
  if (named) return { key: `${kind === "atm" ? "atm:" : ""}${normalizeLocalLogoName(named)}`, name: named, queries: [] };
  const words = normalizeMerchantDescriptor(row.description).split(" ").filter((word) => word && !/\d/.test(word)).slice(0, 3);
  const text = words.join(" ") || row.description.slice(0, 30);
  return { key: `${kind === "atm" ? "atm" : "text"}:${normalizeLocalLogoName(text)}`, name: text, queries: [] };
}

export type LogoEvaluation = { records: MerchantLogoRecord[]; pictures: Map<string, Buffer> };

/**
 * Every merchant the user's bookings show a mark for, with the logo the app displays today, where it
 * comes from and whether it can be trusted. Reads the account's data and logo store; writes nothing.
 */
export async function evaluateLogos(
  store: AutomationStore, userId: string, state: AppState, options: { verdicts?: LogoVerdicts; folderFiles?: readonly string[] } = {},
): Promise<LogoEvaluation> {
  const request = new MerchantLogoRequest(store, userId);
  const rows = actualBookings(state).filter((row) => shouldShowMerchantMark(row, classify(row)));
  const marks = await bookingLogoMarks(store, userId, rows, request);
  const grants = localLogoGrants(store, userId);
  const grantById = new Map<string, AuthorizedLogoGrant>();
  for (const grant of grants.values()) if (!grantById.has(grant.merchantId)) grantById.set(grant.merchantId, grant);
  const catalogueName = (id: string) => store.getMerchant(id)?.canonicalName;
  const places = new Set(rows.flatMap((row) => {
    const city = webTarget(row)?.place?.city;
    return city ? [normalizeLocalLogoName(city)] : [];
  }));

  const info = new Map<string, LogoInfo>();
  const pictures = new Map<string, Buffer>();
  const fingerprints = new Map<string, Set<string>>();
  async function describe(logo: BookingLogo): Promise<LogoInfo> {
    const id = `${logo.merchantId}:${logo.version}`;
    const known = info.get(id);
    if (known) return known;
    const grant = grantById.get(logo.merchantId);
    const merchant = grant ? undefined : store.getMerchant(logo.merchantId);
    const name = grant?.logo.provenance.kind === "local-file" ? grant.logo.provenance.sourceLabel : grant?.canonicalName ?? merchant?.canonicalName ?? logo.merchantId;
    const source: LogoSource = !grant ? "Katalog" : grant.logo.provenance.kind === "local-file" ? "Logo-Ordner" : "Wikimedia (freigegeben)";
    const flags: string[] = [];
    const bare = name.replace(/\.(?:png|jpe?g|webp|avif)$/i, "");
    if (tradeWordName(bare, { categories: false })) flags.push("Branchenwort als Name");
    if (normalizeLocalLogoName(bare).length >= 4 && places.has(normalizeLocalLogoName(bare))) flags.push("Ortsname als Name");
    const png = grant
      ? await readAuthorizedMerchantLogo(store.accounts.path, userId, grant.logo).catch(() => null)
      : merchant?.logo ? await readPrivateMerchantLogo(store.accounts.path, merchant.logo).catch(() => null) : null;
    if (png) {
      pictures.set(id, png);
      const picture = await logoPicture(png);
      if (picture?.blank) flags.push("leeres Bild");
      if (picture) fingerprints.set(picture.fingerprint, (fingerprints.get(picture.fingerprint) ?? new Set()).add(id));
    } else flags.push("Datei nicht lesbar");
    const result: LogoInfo = { merchantId: logo.merchantId, version: logo.version, source, name: bare, flags };
    info.set(id, result);
    return result;
  }

  type Group = { key: string; name: string; kind: LogoKind; queries: string[]; rows: Transaction[]; logos: Map<string, { logo: BookingLogo; count: number }> };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const kind = kindOf(row);
    const { key, name, queries } = keyOf(row, kind, catalogueName);
    const group: Group = groups.get(key) ?? { key, name, kind, queries, rows: [], logos: new Map() };
    group.rows.push(row);
    const logo = marks.get(row.id);
    if (logo) {
      const id = `${logo.merchantId}:${logo.version}`;
      const entry = group.logos.get(id) ?? { logo, count: 0 };
      entry.count++;
      group.logos.set(id, entry);
    }
    groups.set(key, group);
  }
  for (const group of groups.values()) for (const { logo } of group.logos.values()) await describe(logo);
  // The same picture under two different brand names is someone's generic icon, not either brand's logo.
  for (const ids of fingerprints.values()) {
    const names = new Set([...ids].map((id) => normalizeLocalLogoName(info.get(id)!.name)));
    if (names.size < 2) continue;
    for (const id of ids) {
      const others = [...ids].filter((other) => other !== id).map((other) => info.get(other)!.name);
      info.get(id)!.flags.push(`gleiches Bild wie ${others.slice(0, 2).join(", ")}`);
    }
  }

  const folder = (options.folderFiles ?? []).map((file) => ({ file, name: normalizeLocalLogoName(file.replace(/\.(?:png|jpe?g|webp|avif)$/i, "")) }));
  const records: MerchantLogoRecord[] = [];
  for (const group of groups.values()) {
    const best = [...group.logos.values()].sort((left, right) => right.count - left.count)[0];
    const logo = best ? info.get(`${best.logo.merchantId}:${best.logo.version}`)! : null;
    const texts = group.rows.map((row) => ` ${normalizeLocalLogoName([row.merchantAlias, row.description].filter(Boolean).join(" "))} `);
    const unusedFiles = folder
      .filter(({ name }) => name && texts.some((text) => text.includes(` ${name} `)) && normalizeLocalLogoName(logo?.name ?? "") !== name)
      .map(({ file }) => file);
    const verdict = options.verdicts?.[group.key];
    const current = verdict && (verdict.version === (logo?.version ?? null)) ? verdict.verdict : undefined;
    const automatic = logo?.flags.some((flag) => GENERIC_FLAGS.has(flag)) ? "generic" : undefined;
    const status: LogoStatus = !logo ? "missing"
      : current === "wrong" || current === "generic" ? current
      : current === "ok" ? "correct"
      : automatic ?? "unchecked";
    records.push({
      key: group.key, name: group.name, kind: group.kind, bookings: group.rows.length,
      withLogo: [...group.logos.values()].reduce((sum, entry) => sum + entry.count, 0),
      logo, logos: group.logos.size, queries: group.queries, unusedFiles,
      samples: group.rows.slice(0, MAX_SAMPLES).map(sampleOf),
      ...(current ? { verdict: current } : {}), status,
    });
  }
  records.sort((left, right) => right.bookings - left.bookings || left.key.localeCompare(right.key));
  const shown = new Map<string, Buffer>();
  for (const record of records) {
    const id = record.logo && `${record.logo.merchantId}:${record.logo.version}`;
    if (id && pictures.has(id)) shown.set(record.key, pictures.get(id)!);
  }
  return { records, pictures: shown };
}

export type LogoComparison = { gained: string[]; lost: string[]; changed: string[]; worse: string[]; better: string[] };

const statusRank: Record<LogoStatus, number> = { missing: 0, wrong: 0, generic: 0, unchecked: 1, correct: 2 };

/** Per merchant against an earlier run: logos gained or lost, a different picture, a worse or better status. */
export function compareLogoRuns(
  before: readonly Pick<MerchantLogoRecord, "key" | "logo" | "status">[], after: readonly Pick<MerchantLogoRecord, "key" | "logo" | "status">[],
): LogoComparison {
  const previous = new Map(before.map((record) => [record.key, record]));
  const result: LogoComparison = { gained: [], lost: [], changed: [], worse: [], better: [] };
  for (const record of after) {
    const old = previous.get(record.key);
    if (!old) continue;
    if (!old.logo && record.logo) result.gained.push(record.key);
    else if (old.logo && !record.logo) result.lost.push(record.key);
    else if (old.logo && record.logo && old.logo.version !== record.logo.version) result.changed.push(record.key);
    if (statusRank[record.status] < statusRank[old.status]) result.worse.push(record.key);
    else if (statusRank[record.status] > statusRank[old.status]) result.better.push(record.key);
  }
  return result;
}

export async function readVerdicts(file: string): Promise<LogoVerdicts> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) =>
      !!value && typeof value === "object" && ["ok", "wrong", "generic"].includes((value as { verdict?: string }).verdict ?? ""))) as LogoVerdicts;
  } catch {
    return {};
  }
}

const escapeXml = (text: string) => text.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A grid of logos with their merchant names, for checking many logos by eye at once. */
export async function logoContactSheet(entries: readonly { label: string; png: Buffer }[], columns = 8): Promise<Buffer> {
  const cell = 140;
  const image = 96;
  const rows = Math.max(1, Math.ceil(entries.length / columns));
  const tiles = await Promise.all(entries.map(async (entry, index) => {
    const logo = await sharp(entry.png).flatten({ background: "#ffffff" })
      .resize(image, image, { fit: "contain", background: "#ffffff" }).png().toBuffer();
    const label = escapeXml(`${index + 1}. ${entry.label}`.slice(0, 26));
    const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="30"><text x="${cell / 2}" y="18" font-family="Arial, sans-serif" font-size="12" text-anchor="middle" fill="#222">${label}</text></svg>`);
    const left = (index % columns) * cell;
    const top = Math.floor(index / columns) * (cell + 10);
    return [
      { input: logo, left: left + (cell - image) / 2, top: top + 8 },
      { input: text, left, top: top + image + 14 },
    ];
  }));
  return sharp({ create: { width: columns * cell, height: rows * (cell + 10), channels: 3, background: "#eef0f3" } })
    .composite(tiles.flat()).png().toBuffer();
}

type CachedResponse = { status: number; headers: Record<string, string>; body: string; at: number } | { error: string; at: number };
const ERROR_TTL_MS = 3 * 86_400_000;
const CACHED_HEADERS = ["content-type", "content-length", "location", "retry-after"];

/**
 * A fetch for the logo test run: answers from a local cache where it can, and asks a host for real at most
 * once per `intervalMs` (Wikidata and Nominatim ask for unhurried, serial requests). Rate limits and server
 * errors are never cached; an unreachable host (no such domain, no answer) is remembered for three days.
 */
export function cachedPoliteFetch(directory: string, options: { ttlMs?: number; intervalMs?: (host: string) => number; fetcher?: typeof fetch; stats?: { hits: number; requests: number } } = {}): typeof fetch {
  const fetcher = options.fetcher ?? fetch;
  const ttl = options.ttlMs ?? 14 * 86_400_000;
  const nextAt = new Map<string, number>();
  const interval = options.intervalMs ?? ((host: string) =>
    /wikidata\.org$/.test(host) ? 1_500 : /nominatim\.openstreetmap\.org$/.test(host) ? 1_100 : /wikimedia\.org$/.test(host) ? 1_000 : 500);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") return fetcher(input, init);
    const file = join(directory, `${createHash("sha256").update(`${init?.redirect ?? "follow"} ${url.href}`).digest("hex")}.json`);
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as CachedResponse;
      if ("error" in cached && Date.now() - cached.at < Math.min(ttl, ERROR_TTL_MS)) {
        if (options.stats) options.stats.hits++;
        throw new TypeError(cached.error);
      }
      if (!("error" in cached) && Date.now() - cached.at < ttl) {
        if (options.stats) options.stats.hits++;
        const nullBody = [101, 204, 205, 304].includes(cached.status);
        return new Response(nullBody ? null : Buffer.from(cached.body, "base64"), { status: cached.status, headers: cached.headers });
      }
    } catch (error) {
      if (error instanceof TypeError) throw error;
      // Not cached yet.
    }
    const now = Date.now();
    const at = Math.max(now, nextAt.get(url.host) ?? 0);
    nextAt.set(url.host, at + interval(url.host));
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
    init?.signal?.throwIfAborted();
    if (options.stats) options.stats.requests++;
    let response: Response;
    try {
      response = await fetcher(input, init);
    } catch (error) {
      // The caller gave up; that says nothing about the host.
      if (init?.signal?.aborted && !(error instanceof Error && error.name === "TimeoutError")) throw error;
      await mkdir(directory, { recursive: true });
      const message = error instanceof Error ? error.message : "fetch failed";
      await writeFile(file, JSON.stringify({ error: message, at: Date.now() } satisfies CachedResponse));
      throw error;
    }
    if (response.status === 429 || response.status >= 500) return response;
    const body = Buffer.from(await response.arrayBuffer());
    // An API error inside a 200 answer ("too busy") is as passing as a 503.
    if (body.subarray(0, 9).toString() === '{"error"') return new Response(body, { status: response.status, headers: response.headers });
    const headers = Object.fromEntries(CACHED_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value === null || (name === "content-length") ? [] : [[name, value]];
    }));
    await mkdir(directory, { recursive: true });
    await writeFile(file, JSON.stringify({ status: response.status, headers, body: body.toString("base64"), at: Date.now() } satisfies CachedResponse));
    const nullBody = [101, 204, 205, 304].includes(response.status);
    return new Response(nullBody ? null : body, { status: response.status, headers });
  }) as typeof fetch;
}
