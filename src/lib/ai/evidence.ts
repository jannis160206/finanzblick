import { classify } from "@/lib/calc";
import { canonicalCategory, knownMerchantCategory, type Category } from "@/lib/categories";
import { hasCategoryChoice } from "@/lib/manual-category";
import type { AppState, Transaction } from "@/lib/types";
import { RULE_REFINEMENTS, type AiCategorization } from "./categorize";
import type { AiBookingInput } from "./review-candidates";

type BrandSource = Pick<Transaction, "description"> & Partial<Pick<Transaction, "merchantAlias">>;

// Words that name a kind of business or a bank operation, not a brand.
const GENERIC_WORDS = new Set([
  "hotel", "hotels", "restaurant", "restaurante", "ristorante", "cafe", "café", "caffe", "bar", "bistro", "imbiss",
  "gasthaus", "gasthof", "backerei", "bäckerei", "baeckerei", "bakery", "blumen", "shop", "store", "apotheke",
  "tankstelle", "pizzeria", "trafik", "kiosk", "markt", "filiale", "fil", "garage", "parkgarage", "parking",
  "the", "la", "le", "il", "el", "das", "der", "die", "zum", "zur", "am", "st", "sankt", "online", "sepa", "pos",
  "kartenzahlung", "zahlung", "gutschrift", "lastschrift", "überweisung", "ueberweisung", "dauerauftrag",
]);
const PAYMENT_WORDS = /^(?:paypal|klarna|sumup|stripe|adyen|mollie|curve|revolut|wise|google|apple)$/;
const PROVIDER_PREFIX = /^(?:paypal|sumup|sq|zettle|klarna)\s*\*\s*/i;
const comparable = (value: string) => value.toLocaleLowerCase("de-AT").replace(/[^\p{L}\p{N}]/gu, "");

// The brand a booking names, comparable across banks ("OMV 2595 VILLACH" and alias "OMV" => "omv").
export function brandKey(row: BrandSource): string | undefined {
  const source = (row.merchantAlias?.trim() || row.description).normalize("NFKC")
    .replace(PROVIDER_PREFIX, "").replace(/^www\./i, "")
    .replace(/\.(?:com|at|de|net|org|eu|me|co\.uk|ch|it)\b/gi, "");
  const words = source.split(/[\s|/]+/).filter((word) => !/\d{3,}/.test(word)).map(comparable)
    .filter((word) => word.length > 0);
  const first = words[0];
  if (!first || PAYMENT_WORDS.test(first)) return undefined;
  if (GENERIC_WORDS.has(first) || first.length < 2) {
    const second = words[1];
    return second && second.length >= 2 && !GENERIC_WORDS.has(second) ? `${first} ${second}` : undefined;
  }
  return first;
}

// A snack for 4 € and a full tank for 70 € at the same station are different purposes.
export function similarAmount(left: number, right: number) {
  if (Math.sign(left) !== Math.sign(right)) return false;
  const a = Math.abs(left);
  const b = Math.abs(right);
  return Math.abs(a - b) <= 10 || Math.max(a, b) <= 2.5 * Math.min(a, b);
}

export type BrandHistory = {
  brand?: string;
  categories: Map<Category, number>;
  confirmed: number;
  aliases: Set<string>;
};

// Ledger rows of the same brand with a similar amount that the user (or a rule
// learned from the user) categorized. Open reviews and AI decisions never count.
export function brandHistory(state: AppState, draft: BrandSource & Pick<Transaction, "id" | "amount">): BrandHistory {
  const brand = brandKey(draft);
  const history: BrandHistory = { brand, categories: new Map(), confirmed: 0, aliases: new Set() };
  if (!brand) return history;
  const open = new Set((state.reviewQueue ?? []).flatMap((item) => item.kind === "booking" ? [item.draft.id] : []));
  for (const row of state.transactions) {
    if (row.id === draft.id || row.aiAssigned || open.has(row.id) || !similarAmount(row.amount, draft.amount)) continue;
    if (brandKey(row) !== brand) continue;
    const category = canonicalCategory(classify(row).category);
    if (category === "Prüfen") continue;
    history.categories.set(category, (history.categories.get(category) ?? 0) + 1);
    if (hasCategoryChoice(row)) history.confirmed++;
    if (row.merchantAlias?.trim()) history.aliases.add(row.merchantAlias.trim());
  }
  return history;
}

export type EvidenceDecision =
  | { accepted: true; category: Category; merchantAlias?: string; source: "Historie" | "Regel" }
  | { accepted: false; reason: string };

// The model reports ~95 % for right and wrong answers alike, so an answer is
// only applied when the household's own history or a fixed bank rule backs it.
export function decideWithEvidence(
  state: AppState,
  draft: BrandSource & Pick<Transaction, "id" | "amount">,
  input: AiBookingInput,
  answer: AiCategorization | undefined,
): EvidenceDecision {
  const history = brandHistory(state, draft);
  const seen = [...history.categories.keys()];
  const total = [...history.categories.values()].reduce((sum, count) => sum + count, 0);
  if (seen.length === 1 && total >= 2 && history.confirmed >= 1) {
    const alias = history.aliases.size === 1 && !draft.merchantAlias ? [...history.aliases][0] : undefined;
    return { accepted: true, category: seen[0], source: "Historie", ...(alias ? { merchantAlias: alias } : {}) };
  }
  if (!answer) return { accepted: false, reason: "keine Antwort" };
  if (!answer.accepted || answer.category === "Prüfen") return { accepted: false, reason: answer.reason ?? "unsicher" };
  const category = canonicalCategory(answer.category);
  if (seen.some((item) => item !== category)) return { accepted: false, reason: "widerspricht eigener Historie" };
  const rule = knownMerchantCategory(input.text, input.amount);
  if (!rule || rule === "Prüfen" || (rule !== category && !RULE_REFINEMENTS[rule]?.includes(category)))
    return { accepted: false, reason: "keine Bestätigung durch Regel oder eigene Historie" };
  return { accepted: true, category, source: "Regel", ...(answer.merchant ? { merchantAlias: answer.merchant } : {}) };
}

export function decideReviewWithEvidence(
  state: AppState, reviewId: string, input: AiBookingInput, answer: AiCategorization | undefined,
): EvidenceDecision {
  const item = state.reviewQueue?.find((entry) => entry.id === reviewId);
  if (item?.kind !== "booking" || item.draft.amount === null) return { accepted: false, reason: "Prüfung nicht mehr offen" };
  return decideWithEvidence(state, { ...item.draft, amount: item.draft.amount }, input, answer);
}
