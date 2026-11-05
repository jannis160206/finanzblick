import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classify, actualBookings } from "@/lib/calc";
import { isAtmBooking } from "@/lib/atm-logo";
import { allCategories } from "@/lib/categories";
import { shouldShowMerchantMark } from "@/lib/merchant-mark-policy";
import type { AppState, Transaction } from "@/lib/types";
import { liveLogoDirectory } from "@/lib/automation/merchant-live-logo-directory";
import { normalizeLocalLogoName } from "@/lib/automation/merchant-local-logos";
import { accountMerchantBookingPresentations } from "@/lib/automation/merchant-booking-presentations";
import {
  accountMerchantNamePresentations,
  accountMerchantPresentations,
} from "@/lib/automation/merchant-logo-presentations";
import { MerchantLogoRequest } from "@/lib/automation/merchant-logo-request";
import { merchantLogoBookingId, merchantLogoName } from "@/lib/automation/merchant-mark-name";
import { normalizeMerchantDescriptor } from "@/lib/automation/merchants";
import type { AutomationStore } from "@/lib/automation/store";
import type { ChatOptions } from "./client";
import { industryCategory } from "./industry";
import { findMerchantLogo, logoFileName } from "./logo-finder";
import { webTarget } from "./web-categories";

export const LOGO_MISSES_FILE = ".logo-misses.json";
const RETRY_MISS_MS = 30 * 86_400_000;
const MAX_MISSES = 3000;
const BATCH = 100;
const MAX_QUERY_WORDS = 4;

export type LogoTarget = {
  /** Normalized identity of the merchant; one search per merchant. */
  key: string;
  /** Names to search, most specific first; the first one found becomes the file name. */
  queries: string[];
  context: string;
  bookings: number;
  /** A person-like name from a transfer only gets a registry match, never a guessed website. */
  guessWebsite: boolean;
  /** Merchant names (aliases) keep their own file name, whatever name found the logo. */
  saveAs?: string;
};

const display = (word: string) =>
  word.length <= 3 ? word.toUpperCase() : word[0].toLocaleUpperCase("de-AT") + word.slice(1);

const STOP_WORDS = new Set([
  "von", "to", "on", "the", "der", "die", "das", "und", "and", "of", "at", "de", "la", "le",
  "zum", "zur", "im", "in", "am", "bei", "fuer", "für", "gmbh", "gmb", "ag", "kg", "co",
]);
// Words that name a trade or region, not a brand; a logo saved under them would match strangers.
const GENERIC_WORDS = new Set([
  "baeckerei", "bäckerei", "diskont", "bauernhof", "europa", "global", "austria", "international",
  "service", "services", "shop", "store", "online", "markt", "handel", "center", "zentrum", "gasthof",
  "gasthaus", "restaurant", "cafe", "hotel", "apotheke", "trafik", "tankstelle", "fil", "filiale",
]);
const categoryNames = new Set(allCategories.map((category) => normalizeLocalLogoName(category)));
const withUmlauts = (text: string) => text.replace(/ae/gi, "ä").replace(/oe/gi, "ö").replace(/ue/gi, "ü");

function genericName(name: string) {
  const normalized = normalizeLocalLogoName(name);
  if (categoryNames.has(normalized)) return true;
  const words = normalized.split(" ").filter(Boolean);
  if (words.every((word) => STOP_WORDS.has(word) || GENERIC_WORDS.has(word))) return true;
  return words.length === 1 && !!(industryCategory(name) || industryCategory(withUmlauts(name)));
}

// "SPAR Fil. 6423 Spar Fil Finkenstein" => "Spar Spar Finkenstein", "Spar Spar", "Spar":
// the file name must consist of words that appear in the booking text, so it matches it later.
export function logoQueries(name: string): string[] {
  const all = normalizeMerchantDescriptor(name).split(" ").filter(Boolean);
  while (all.length && STOP_WORDS.has(all[0])) all.shift();
  const words = all.filter((word, index) => index === 0 || word !== all[index - 1]).slice(0, MAX_QUERY_WORDS);
  const queries: string[] = [];
  for (let size = words.length; size > 0; size--) {
    // "Hotel ON", "TO" end in a connecting word and name nothing.
    if (STOP_WORDS.has(words[size - 1])) continue;
    const query = words.slice(0, size).map(display).join(" ");
    const letters = query.match(/\p{L}/gu)?.length ?? 0;
    if (letters < 2 || genericName(query) || !logoFileName(query)) continue;
    queries.push(query);
  }
  return queries;
}

/** Shortened single words ("Europa" from "Europa Park") are too ambiguous for an unconfirmed match or a guessed site. */
export function shortenedQuery(target: Pick<LogoTarget, "queries" | "saveAs">, query: string) {
  const full = normalizeLocalLogoName(target.saveAs ?? target.queries[0] ?? "");
  const normalized = normalizeLocalLogoName(query);
  return normalized !== full && !normalized.includes(" ");
}

function targetFor(row: Transaction): Omit<LogoTarget, "bookings"> | undefined {
  const alias = merchantLogoName(row)?.trim();
  const card = webTarget(row);
  if (alias) {
    if (genericName(alias) || !logoFileName(alias)) return undefined;
    // A person or a PayPal payee is only ever looked up by its full name.
    const first = normalizeLocalLogoName(alias).split(" ")[0];
    const shorter = card
      ? logoQueries(alias).filter((query) => normalizeLocalLogoName(query).split(" ")[0] === first)
      : [];
    return {
      key: normalizeLocalLogoName(alias), queries: [...new Set([alias, ...shorter])], saveAs: alias,
      context: row.description.slice(0, 200), guessWebsite: !!card,
    };
  }
  if (!card) return undefined;
  const queries = logoQueries(card.name);
  if (!queries.length) return undefined;
  return { key: normalizeLocalLogoName(queries.at(-1)!), queries, context: row.description.slice(0, 200), guessWebsite: true };
}

type Misses = Record<string, number>;

async function readMisses(directory: string): Promise<Misses> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, LOGO_MISSES_FILE), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, at]) => typeof at === "number")) as Misses;
  } catch {
    return {};
  }
}

async function writeMisses(directory: string, misses: Misses) {
  const entries = Object.entries(misses).sort((a, b) => b[1] - a[1]).slice(0, MAX_MISSES);
  const file = join(directory, LOGO_MISSES_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(Object.fromEntries(entries)));
  await rename(temporary, file);
}

// Bookings that would show a merchant mark but have none yet, grouped per merchant, most bookings first.
export async function missingLogoTargets(
  store: AutomationStore, userId: string, state: AppState,
): Promise<LogoTarget[]> {
  const rows = actualBookings(state).filter((row) => !isAtmBooking(row) && shouldShowMerchantMark(row, classify(row)));
  const request = new MerchantLogoRequest(store, userId);
  const bookingIds = [...new Set(rows.map((row) => merchantLogoBookingId(row)).filter((id): id is string => !!id))];
  const names = [...new Set(rows.map((row) => merchantLogoName(row)).filter((name): name is string => !!name))];
  const merchantIds = [...new Set(rows.map((row) => row.merchantId).filter((id): id is string => !!id))];
  const withBooking = new Set<string>();
  const withName = new Set<string>();
  const withMerchant = new Set<string>();
  for (let index = 0; index < bookingIds.length; index += BATCH)
    for (const mark of await accountMerchantBookingPresentations(store, bookingIds.slice(index, index + BATCH), userId, request))
      if (mark.logo) withBooking.add(mark.bookingId);
  for (let index = 0; index < names.length; index += BATCH)
    for (const mark of await accountMerchantNamePresentations(store, names.slice(index, index + BATCH), userId, request))
      if (mark.logo) withName.add(mark.merchantName);
  for (let index = 0; index < merchantIds.length; index += BATCH)
    for (const mark of await accountMerchantPresentations(store, { merchantIds: merchantIds.slice(index, index + BATCH) }, userId, request))
      if (mark.logo) withMerchant.add(mark.merchantId);
  const targets = new Map<string, LogoTarget>();
  for (const row of rows) {
    const name = merchantLogoName(row);
    if (name ? withName.has(name) : withBooking.has(row.id)) continue;
    if (row.merchantId && withMerchant.has(row.merchantId)) continue;
    const target = targetFor(row);
    if (!target) continue;
    const known = targets.get(target.key);
    if (known) known.bookings++;
    else targets.set(target.key, { ...target, bookings: 1 });
  }
  return [...targets.values()].sort((a, b) => b.bookings - a.bookings);
}

export type LogoSweepResult = {
  saved: { name: string; file: string; source: string }[];
  checked: number;
  remaining: number;
  rateLimited: boolean;
};

export type LogoSweepOptions = {
  limit?: number;
  signal?: AbortSignal;
  directory?: string;
  fetcher?: typeof fetch;
  ai?: ChatOptions | false;
  now?: number;
  throttleMs?: number;
};

/**
 * Looks up logos for merchants without one, a few per call. Merchants nothing was
 * found for are remembered and asked again after 30 days; rate limits stop the run
 * without remembering anything, so the next call continues there.
 */
export async function sweepMissingLogos(
  store: AutomationStore, userId: string, state: AppState, options: LogoSweepOptions = {},
): Promise<LogoSweepResult> {
  const directory = options.directory ?? liveLogoDirectory();
  const now = options.now ?? Date.now();
  const misses = await readMisses(directory);
  const open = (await missingLogoTargets(store, userId, state))
    .filter((target) => !(now - (misses[target.key] ?? -Infinity) < RETRY_MISS_MS));
  const limit = Math.max(1, Math.min(options.limit ?? 5, 25));
  const saved: LogoSweepResult["saved"] = [];
  let checked = 0;
  let rateLimited = false;
  let changed = false;
  for (const target of open.slice(0, limit)) {
    if (options.signal?.aborted) break;
    checked++;
    let stop = false;
    for (const query of target.queries) {
      const shortened = shortenedQuery(target, query);
      const outcome = await findMerchantLogo(query, target.context, {
        directory, signal: options.signal, fetcher: options.fetcher, ai: options.ai ?? {},
        guessWebsite: target.guessWebsite && !shortened, requireConfirmation: shortened,
        throttleMs: options.throttleMs, saveAs: target.saveAs,
      });
      if (outcome.status === "saved") saved.push({ name: target.saveAs ?? query, file: outcome.file, source: outcome.source });
      if (outcome.status !== "not-found") break;
      if (outcome.transient || outcome.reason === "Logo-Ordner ist voll") {
        stop = true;
        break;
      }
    }
    if (stop) {
      rateLimited = true;
      checked--;
      break;
    }
    // An existing file that still does not match is not searched again either.
    misses[target.key] = now;
    changed = true;
  }
  if (changed) await writeMisses(directory, misses).catch(() => undefined);
  return { saved, checked, remaining: Math.max(0, open.length - checked), rateLimited };
}
