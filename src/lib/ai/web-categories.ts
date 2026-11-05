import { classify } from "@/lib/calc";
import { canonicalCategory, type Category } from "@/lib/categories";
import { hasCategoryChoice } from "@/lib/manual-category";
import { MAX_WEB_CATEGORIES, type AppState, type Transaction, type WebCategory } from "@/lib/types";
import { providerMerchant } from "./categorize";
import type { Industry, MerchantPlace } from "./industry";
import { isAiEligibleReview } from "./review-candidates";

export type WebTarget = { key: string; name: string; place?: MerchantPlace };
type Descriptor = Pick<Transaction, "description"> & Partial<Pick<Transaction, "rawDescription">>;

const TRANSFER = /(?<!\p{L})(?:IBAN|BIC|Empfänger|Zahlungsempfänger|Auftraggeber|Dauerauftrag|Online Banking|Lastschrift|Mandat|Gläubiger|Umbuchung)(?!\p{L})/iu;
const CARD_PURPOSE = /Verwendungszweck:\s*(.+?)\s+Zahlungsreferenz:\s*(?:POS|ePAYMENT)\b/i;
const CARD_REFERENCE = /Zahlungsreferenz:\s*(.+?)\s+D\d\s+\d{2}\.\d{2}\./i;
const PROVIDER = /^(?:paypal|klarna)\b/i;
const PREFIX = /^(?:sumup|sq|zettle|izettle|nyx|sp|pp|ec)\s*\*\s*|^sp\s+(?=\S+\s)/i;
// "KLAGENFURT AM 9020", "HOCHHEIM AM M 65239": cut-off city suffixes before the postcode.
const CITY_SUFFIX = /^(?:am|im|an|a|m|d|i|in|ob|bei|st|b|w|t|s)$/i;
const NOISE = /^(?:dankt|fil|filnr|filiale|kassa|gmbh|gesmbh|mbh|kg|og|eu|ag|co|inc|ltd|llc|sarl|srl|sl|sa|bv|nv|ohg|ug|e\.?u\.?)\.?$/i;
const compact = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const title = (value: string) => value.toLocaleLowerCase("de-AT").replace(/(^|[\s-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toLocaleUpperCase("de-AT"));

function webKey(name: string, place?: MerchantPlace) {
  return `${compact(name)}@${place?.postcode ?? compact(place?.city ?? "")}`.slice(0, 160);
}

// "MARTIN AUER ATRIOVIL VILLACH 9500" => Martin Auer Atriovil in Villach (9500).
export function parseDescriptor(text: string): WebTarget | undefined {
  const tokens = text.normalize("NFKC").replace(PREFIX, "").replace(/\*/g, " ").split(/\s+/)
    .map((token) => token.replace(/^(\p{L}{3,})\d+$/u, "$1"))
    .filter((token) => token && !/\d{3,}/.test(token.replace(/^\d{4,5}$/, "")) && !NOISE.test(token));
  let postcode: string | undefined;
  if (tokens.length && /^\d{4,5}$/.test(tokens.at(-1)!)) postcode = tokens.pop();
  const rest = tokens.filter((token) => !/^\d+$/.test(token));
  while (postcode && rest.length > 2 && CITY_SUFFIX.test(rest.at(-1)!)) rest.pop();
  let city: string | undefined;
  if (rest.length >= 2 && /^[\p{L}][\p{L}.\-/]{2,}$/u.test(rest.at(-1)!)) {
    city = rest.pop()!;
    while (rest.length > 1 && compact(rest.at(-1)!) === compact(city)) rest.pop();
  }
  const name = title(rest.join(" ").replace(/\s+/g, " ").trim()).slice(0, 90);
  if (compact(name).length < 3) return undefined;
  const place = city || postcode ? { ...(city ? { city: title(city) } : {}), ...(postcode ? { postcode } : {}) } : undefined;
  return { key: webKey(name, place), name, ...(place ? { place } : {}) };
}

// The shop worth looking up for a card payment; transfers name people, never shops.
export function webTarget(row: Descriptor): WebTarget | undefined {
  const description = row.description.trim();
  const raw = row.rawDescription ?? "";
  if (PROVIDER.test(description)) {
    const name = providerMerchant(description);
    return name && compact(name).length >= 3 ? { key: webKey(name), name } : undefined;
  }
  const card = CARD_PURPOSE.exec(raw)?.[1] ?? CARD_REFERENCE.exec(raw)?.[1];
  if (card) return parseDescriptor(card);
  if (TRANSFER.test(`${description} ${raw}`) || /Zahlungsreferenz:|Verwendungszweck:/i.test(raw)) return undefined;
  return parseDescriptor(description);
}

export function webTargetForReview(state: AppState, reviewId: string): WebTarget | undefined {
  const item = state.reviewQueue?.find((entry) => entry.id === reviewId);
  return item?.kind === "booking" && (item.draft.amount ?? 0) < 0 ? webTarget(item.draft) : undefined;
}

const RETRY_EMPTY_MS = 30 * 86_400_000;

// Open card payments at shops nobody looked up yet, one per shop.
export function pendingWebLookups(state: AppState, limit: number, skip: ReadonlySet<string> = new Set(), now = Date.now()): WebTarget[] {
  const targets = new Map<string, WebTarget>();
  for (const item of state.reviewQueue ?? []) {
    if (targets.size >= limit) break;
    if (!isAiEligibleReview(item) || (item.draft.amount ?? 0) >= 0) continue;
    const target = webTarget(item.draft);
    if (!target || skip.has(target.key) || targets.has(target.key) || !needsWebLookup(state, target, now)) continue;
    targets.set(target.key, target);
  }
  return [...targets.values()];
}

export function webEntry(state: AppState, target: WebTarget | undefined): WebCategory | undefined {
  return target ? state.webCategories?.find((entry) => entry.key === target.key) : undefined;
}

export function needsWebLookup(state: AppState, target: WebTarget, now = Date.now()) {
  const entry = webEntry(state, target);
  return !entry || (!entry.category && now - entry.at > RETRY_EMPTY_MS);
}

export function recordWebCategories(
  state: AppState, found: { target: WebTarget; industry?: Industry }[], now = Date.now(),
): AppState {
  if (!found.length) return state;
  const keys = new Set(found.map((item) => item.target.key));
  const entries: WebCategory[] = found.map(({ target, industry }) => ({
    key: target.key, name: target.name.slice(0, 100), at: now,
    ...(target.place ? { place: [target.place.postcode, target.place.city].filter(Boolean).join(" ").slice(0, 60) } : {}),
    ...(industry ? {
      category: industry.category, source: industry.source, label: industry.label.slice(0, 200),
      ...(industry.kind ? { kind: industry.kind.slice(0, 80) } : {}), ...(industry.strong ? { strong: true } : {}),
    } : {}),
  }));
  const kept = (state.webCategories ?? []).filter((entry) => !keys.has(entry.key));
  return { ...state, webCategories: [...kept, ...entries].slice(-MAX_WEB_CATEGORIES) };
}

// What the household picked for bookings at shops of the same OpenStreetMap type
// ("shop=bakery" => Mittagessen). One clear answer from at least two different shops overrides the default mapping.
export function webHabits(state: AppState): Map<string, Category> {
  const byKey = new Map((state.webCategories ?? []).filter((entry) => entry.kind).map((entry) => [entry.key, entry.kind!]));
  const votes = new Map<string, Map<Category, Set<string>>>();
  if (!byKey.size) return new Map();
  for (const row of state.transactions) {
    if (row.amount >= 0 || row.aiAssigned || !hasCategoryChoice(row)) continue;
    const key = webTarget(row)?.key ?? "";
    const kind = byKey.get(key);
    if (!kind) continue;
    const category = canonicalCategory(classify(row).category);
    if (category === "Prüfen") continue;
    const shops = votes.get(kind) ?? new Map<Category, Set<string>>();
    shops.set(category, (shops.get(category) ?? new Set()).add(key));
    votes.set(kind, shops);
  }
  const habits = new Map<string, Category>();
  for (const [kind, shops] of votes) {
    const [category, keys] = [...shops][0];
    if (shops.size === 1 && keys.size >= 2) habits.set(kind, category);
  }
  return habits;
}

export type WebEvidence = { category: Category; label: string; strong?: boolean };

export function webEvidence(entry: WebCategory | undefined, habits: Map<string, Category>): WebEvidence | undefined {
  if (!entry?.category) return undefined;
  const habit = entry.kind ? habits.get(entry.kind) : undefined;
  const label = `${entry.source ?? "Internet"}: ${entry.label ?? entry.name}`;
  if (habit) return { category: habit, label: `${label} – wie deine anderen ${entry.kind}`, strong: true };
  return { category: entry.category, label, ...(entry.strong ? { strong: true } : {}) };
}
