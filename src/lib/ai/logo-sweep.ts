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
import {
  merchantBookingMarkKey, merchantLogoBookingId, merchantLogoName, merchantMarkFor, merchantNameMarkKey,
} from "@/lib/automation/merchant-mark-name";
import type { MerchantPresentation } from "@/lib/automation/merchant-presentation-schema";
import { normalizeMerchantDescriptor } from "@/lib/automation/merchants";
import type { AutomationStore } from "@/lib/automation/store";
import type { ChatOptions } from "./client";
import { industryCategory, type MerchantPlace } from "./industry";
import { findPersonNames } from "./pseudonymize";
import { knownLogoBrand, readLogoOverrides } from "./logo-brands";
import { findMerchantLogo, logoFileName, type LogoOutcome } from "./logo-finder";
import { webTarget } from "./web-categories";

export const LOGO_MISSES_FILE = ".logo-misses.json";
// Raised whenever the search finds more: every merchant not found before is tried once more.
export const LOGO_FINDER_VERSION = 2;
const RETRY_MISS_MS = 30 * 86_400_000;
// Ambiguous names wait for the local model, which may simply not have been running.
const RETRY_MODEL_MS = 3 * 86_400_000;
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
  /** Card payment place, so OpenStreetMap can name a local shop's website. */
  place?: MerchantPlace;
  /** The merchant's own web address from the booking text ("BEISPIEL.GG", "WWW.OEBB.AT"). */
  website?: string;
};

const display = (word: string) =>
  word.length <= 3 ? word.toUpperCase() : word[0].toLocaleUpperCase("de-AT") + word.slice(1);

const STOP_WORDS = new Set([
  "von", "to", "on", "the", "der", "die", "das", "und", "and", "of", "at", "de", "la", "le",
  "zum", "zur", "im", "in", "am", "bei", "fuer", "für", "gmbh", "gmb", "ag", "kg", "co",
  "mbh", "gesmbh", "og", "ltd", "limited", "inc", "llc", "pte", "plc", "sa", "sl", "srl", "sarl", "sas", "spa", "bv", "ab", "oy",
]);
// A company, not a person: a legal form or a web address in the name ("Beispiel GmbH", "Beispiel.gg").
const COMPANY = /\b(?:gmbh|gesmbh|mbh|ag|kg|og|e\.?\s?u|ltd|limited|inc|llc|pte|plc|s\.?\s?a|s\.?\s?l|srl|sarl|bv|ab|oy)\b\.?|\.(?:com|net|org|io|gg|me|at|de|eu)\b/i;
// Web addresses of payment services and shop builders name no merchant of their own.
const SERVICE_DOMAIN = /^(?:www\.)?(?:paypal|sumup|klarna|stripe|adyen|hobex|wix|shopify|squareup|zettle|google|apple|amzn|amazon)\./i;
const WEB_ADDRESS = /(?<![\w@.-])((?:www\.)?[a-z0-9][a-z0-9-]{1,40}\.(?:at|de|ch|com|eu|net|org|io|me|gg|co\.uk|it|es|fr|nl|lt|gr|si|hr|cy))(?![\w-])/i;

const PAYMENT_SERVICE = /\b(?:paypal|klarna|sumup|stripe|adyen|hobex|zahlungsempf)/i;

/** The web address a booking text names for its merchant, as an https URL. */
export function bookingWebsite(text: string): string | undefined {
  const domain = WEB_ADDRESS.exec(text)?.[1]?.toLowerCase();
  if (!domain || SERVICE_DOMAIN.test(domain)) return undefined;
  return `https://${domain}/`;
}

/** "Beispiel GmbH" → "Beispiel", "Spotify AB" → "Spotify": the brand without its legal form. */
function withoutLegalForm(name: string) {
  return name.replace(/[\s,]+(?:&\s*co\.?\s*)?(?:gmbh|gesmbh|mbh|ag|kg|og|ltd\.?|limited|inc\.?|llc|pte|plc|s\.?a\.?|s\.?l\.?|srl|sarl|bv|ab|oy)(?=\s|$)/gi, "")
    .replace(/\s*&\s*co\.?\s*kg$/i, "").trim();
}
// Words that name a trade or region, not a brand; a logo saved under them would match strangers.
const GENERIC_WORDS = new Set([
  "baeckerei", "bäckerei", "backerei", "diskont", "bauernhof", "europa", "global", "austria", "international",
  "service", "services", "shop", "store", "online", "markt", "handel", "center", "zentrum", "gasthof",
  "gasthaus", "restaurant", "cafe", "hotel", "apotheke", "trafik", "tankstelle", "fil", "filiale",
  "farmacia", "pharmacy", "pharmacie", "pizzeria", "pizza", "kebab", "kebap", "caffe", "coffee", "bar", "pub", "bistro",
  "supermarket", "supermercado", "supermarkt", "kiosk", "kiosks", "taxi", "taxis", "parking", "parkhaus", "garage", "duty",
  "free", "hostel", "suites", "resort", "apartments", "camping", "souvenir", "souvenirs", "boutique", "market", "mercado",
  "bakery", "panaderia", "restaurante", "ristorante", "trattoria", "taverna", "imbiss", "snack", "fahrschule", "waschanlage",
  "airport", "flughafen", "bahnhof", "hauptbahnhof", "bargeldbehebung", "behebung", "sb", "atm", "city", "centre",
]);
const categoryNames = new Set(allCategories.map((category) => normalizeLocalLogoName(category)));
const withUmlauts = (text: string) => text.replace(/ae/gi, "ä").replace(/oe/gi, "ö").replace(/ue/gi, "ü");

/** Only trade, region or connecting words ("Bäckerei", "Hotel ON", "Farmacia"), or a category name: no brand. */
export function tradeWordName(name: string, { categories = true } = {}) {
  const normalized = normalizeLocalLogoName(name);
  if (categories && categoryNames.has(normalized)) return true;
  return normalized.split(" ").filter(Boolean).every((word) => STOP_WORDS.has(word) || GENERIC_WORDS.has(word));
}

/** A transfer from or to a person ("Auftraggeber: Max Muster", "To Max Muster"): initials, never a searched logo. */
export function personTransfer(row: Pick<Transaction, "description" | "rawDescription" | "rawDetails" | "merchantAlias">) {
  const names = findPersonNames([row.description, row.rawDescription ?? "", ...(row.rawDetails ?? [])].join("\n"))
    .map(normalizeLocalLogoName)
    .filter((name) => name.includes(" ") && !name.split(" ").some((word) => GENERIC_WORDS.has(word)));
  if (!names.length) return false;
  const subject = normalizeLocalLogoName(row.merchantAlias?.trim() || normalizeMerchantDescriptor(row.description));
  return !subject || names.some((name) => subject.includes(name) || name.includes(subject));
}

export function genericName(name: string) {
  if (tradeWordName(name)) return true;
  const words = normalizeLocalLogoName(name).split(" ").filter(Boolean);
  // "E Center": a trade word with a lone letter names no brand (only initials like "H M" do).
  const trade = (word: string) => STOP_WORDS.has(word) || GENERIC_WORDS.has(word);
  if (words.some(trade) && words.every((word) => trade(word) || word.length === 1)) return true;
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

/** The merchant a booking's logo is searched for, or none (people, generic words). */
export function logoTarget(row: Transaction): Omit<LogoTarget, "bookings"> | undefined {
  const alias = merchantLogoName(row)?.trim();
  if (!webTarget(row) && personTransfer(row)) return undefined;
  // A plain shop name without bank details (a Revolut card payment: "dm drogerie", "BP") is a shop as well.
  const plain = !alias && !row.rawDescription?.trim() && !row.rawDetails?.length && /\p{L}{2}/u.test(row.description) &&
    !PAYMENT_SERVICE.test(row.description);
  const card = webTarget(row) ?? (plain ? { key: "", name: row.description.trim().slice(0, 90) } : undefined);
  if (alias) {
    if (genericName(alias) || !logoFileName(alias)) return undefined;
    // A person or a PayPal payee is only ever looked up by its full name.
    const first = normalizeLocalLogoName(alias).split(" ")[0];
    const shorter = card
      ? logoQueries(alias).filter((query) => normalizeLocalLogoName(query).split(" ")[0] === first)
      : [];
    const company = COMPANY.test(alias);
    const brand = withoutLegalForm(alias);
    const website = bookingWebsite(`${alias} ${row.description} ${row.rawDescription ?? ""}`);
    return {
      key: normalizeLocalLogoName(alias),
      queries: [...new Set([alias, ...(brand && brand !== alias && logoFileName(brand) ? [brand] : []), ...shorter])], saveAs: alias,
      context: row.description.slice(0, 200), guessWebsite: !!card || company, ...(card?.place ? { place: card.place } : {}),
      ...(website ? { website } : {}),
    };
  }
  if (!card) return undefined;
  // "1234 SALZBURG": the place where the card was used is no merchant. Without a postcode the "place" is only
  // the last word, which may as well be the shop's own ("Pizzeria Nordlicht", "Gasthaus Seeblick").
  const city = card.place?.city ? normalizeLocalLogoName(card.place.city) : undefined;
  const named = card.place?.city && !card.place.postcode ? `${card.name} ${card.place.city}` : card.name;
  const queries = logoQueries(named).filter((query) => normalizeLocalLogoName(query) !== city);
  if (!queries.length) return undefined;
  const website = bookingWebsite(`${row.description} ${row.rawDescription ?? ""}`);
  return {
    key: normalizeLocalLogoName(queries.at(-1)!), queries, context: row.description.slice(0, 200), guessWebsite: true,
    ...(card.place ? { place: card.place } : {}), ...(website ? { website } : {}),
  };
}

/** Merchant key → earliest time to search again. */
type Misses = Record<string, number>;

// Misses of an older finder (or the old flat format) are forgotten: the improved search may find them now.
export async function readMisses(directory: string): Promise<Misses> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, LOGO_MISSES_FILE), "utf8")) as { version?: unknown; retry?: unknown };
    if (parsed?.version !== LOGO_FINDER_VERSION || !parsed.retry || typeof parsed.retry !== "object" || Array.isArray(parsed.retry)) return {};
    return Object.fromEntries(Object.entries(parsed.retry).filter(([, at]) => typeof at === "number")) as Misses;
  } catch {
    return {};
  }
}

async function writeMisses(directory: string, misses: Misses) {
  const entries = Object.entries(misses).sort((a, b) => b[1] - a[1]).slice(0, MAX_MISSES);
  const file = join(directory, LOGO_MISSES_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: LOGO_FINDER_VERSION, retry: Object.fromEntries(entries) }));
  await rename(temporary, file);
}

export type BookingLogo = NonNullable<MerchantPresentation["logo"]>;

/** The logo each booking shows in the app (null: initials), resolved exactly like `MerchantMark`. */
export async function bookingLogoMarks(
  store: AutomationStore, userId: string, rows: readonly Transaction[], request = new MerchantLogoRequest(store, userId),
): Promise<Map<string, BookingLogo | null>> {
  const bookingIds = [...new Set(rows.map((row) => merchantLogoBookingId(row)).filter((id): id is string => !!id))];
  const names = [...new Set(rows.map((row) => merchantLogoName(row)).filter((name): name is string => !!name))];
  const merchantIds = [...new Set(rows.map((row) => row.merchantId).filter((id): id is string => !!id))];
  const marks = new Map<string, BookingLogo | null>();
  for (let index = 0; index < bookingIds.length; index += BATCH)
    for (const mark of await accountMerchantBookingPresentations(store, bookingIds.slice(index, index + BATCH), userId, request))
      marks.set(merchantBookingMarkKey(mark.bookingId), mark.logo);
  for (let index = 0; index < names.length; index += BATCH)
    for (const mark of await accountMerchantNamePresentations(store, names.slice(index, index + BATCH), userId, request))
      marks.set(merchantNameMarkKey(mark.merchantName), mark.logo);
  for (let index = 0; index < merchantIds.length; index += BATCH)
    for (const mark of await accountMerchantPresentations(store, { merchantIds: merchantIds.slice(index, index + BATCH) }, userId, request))
      marks.set(mark.merchantId, mark.logo);
  return new Map(rows.map((row) => [row.id, merchantMarkFor(row, (key) => marks.get(key)) ?? null]));
}

// Bookings that would show a merchant mark but have none yet, grouped per merchant, most bookings first.
export async function missingLogoTargets(
  store: AutomationStore, userId: string, state: AppState,
): Promise<LogoTarget[]> {
  const rows = actualBookings(state).filter((row) => !isAtmBooking(row) && shouldShowMerchantMark(row, classify(row)));
  const marks = await bookingLogoMarks(store, userId, rows);
  const targets = new Map<string, LogoTarget>();
  for (const row of rows) {
    if (marks.get(row.id)) continue;
    const target = logoTarget(row);
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
  /** Only these merchants (the logo test run checks single ones). */
  only?: (target: LogoTarget) => boolean;
  /** Each merchant's outcome with the name that decided it, for the logo test run. */
  onTarget?: (target: LogoTarget, outcome: LogoOutcome, query: string) => void;
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
  const overrides = await readLogoOverrides(directory);
  const open = (await missingLogoTargets(store, userId, state))
    .filter((target) => !(now < (misses[target.key] ?? -Infinity)) && (!options.only || options.only(target)));
  const limit = Math.max(1, Math.min(options.limit ?? 5, 25));
  const saved: LogoSweepResult["saved"] = [];
  let checked = 0;
  let rateLimited = false;
  let changed = false;
  for (const target of open.slice(0, limit)) {
    if (options.signal?.aborted) break;
    checked++;
    let stop = false;
    let needsModel = false;
    // The user's override for this merchant, else a curated brand the name belongs to.
    const override = [target.key, target.saveAs ?? "", ...target.queries]
      .map((name) => overrides.get(normalizeLocalLogoName(name))).find(Boolean);
    for (const [index, query] of target.queries.entries()) {
      const shortened = shortenedQuery(target, query);
      // The web address in the booking text is asked once, with the most specific name.
      const hint = override ?? knownLogoBrand(query) ?? (index === 0 && target.website ? { website: target.website } : undefined);
      const outcome = await findMerchantLogo(query, target.context, {
        directory, signal: options.signal, fetcher: options.fetcher, ai: options.ai ?? {},
        guessWebsite: target.guessWebsite && !shortened, requireConfirmation: shortened && !hint,
        ...(target.place && !shortened ? { place: target.place } : {}), ...(hint ? { hint } : {}),
        throttleMs: options.throttleMs, saveAs: target.saveAs,
      });
      if (outcome.status === "saved") saved.push({ name: target.saveAs ?? query, file: outcome.file, source: outcome.source });
      if (outcome.status !== "not-found" || query === target.queries.at(-1) || outcome.transient) options.onTarget?.(target, outcome, query);
      if (outcome.status !== "not-found") break;
      if (outcome.needsModel) needsModel = true;
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
    misses[target.key] = now + (needsModel ? RETRY_MODEL_MS : RETRY_MISS_MS);
    changed = true;
  }
  if (changed) await writeMisses(directory, misses).catch(() => undefined);
  return { saved, checked, remaining: Math.max(0, open.length - checked), rateLimited };
}
