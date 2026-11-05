import { classify } from "@/lib/calc";
import { canonicalCategory, knownMerchantCategory, type Category } from "@/lib/categories";
import { hasCategoryChoice } from "@/lib/manual-category";
import { isIncomeCategory } from "@/lib/fixed";
import type { AppState, Transaction } from "@/lib/types";
import { providerMerchant, RULE_REFINEMENTS, type AiCategorization } from "./categorize";
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
  // "DM-FIL. A055" is branch "A055" of dm.
  const words = source.replace(/-(?:fil|filiale)\b\.?/gi, " ").split(/[\s|/]+/).filter((word) => !/\d{3,}/.test(word)).map(comparable)
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

export { providerMerchant };

export type BrandHistory = {
  brand?: string;
  categories: Map<Category, number>;
  confirmed: number;
  confirmedCategories: Set<Category>;
  aliases: Set<string>;
};

const openReviewIds = (state: AppState) =>
  new Set((state.reviewQueue ?? []).flatMap((item) => item.kind === "booking" ? [item.draft.id] : []));

// Ledger rows of the same brand with a similar amount that the user (or a rule
// learned from the user) categorized. Open reviews and AI decisions never count.
// confirmedCategories covers every amount of the same sign, for contradiction checks.
export function brandHistory(state: AppState, draft: BrandSource & Pick<Transaction, "id" | "amount">): BrandHistory {
  const brand = brandKey(draft);
  const history: BrandHistory = { brand, categories: new Map(), confirmed: 0, confirmedCategories: new Set(), aliases: new Set() };
  if (!brand) return history;
  const open = openReviewIds(state);
  for (const row of state.transactions) {
    if (row.id === draft.id || row.aiAssigned || open.has(row.id) || Math.sign(row.amount) !== Math.sign(draft.amount)) continue;
    if (brandKey(row) !== brand) continue;
    const category = canonicalCategory(classify(row).category);
    if (category === "Prüfen") continue;
    const confirmed = hasCategoryChoice(row);
    if (confirmed) history.confirmedCategories.add(category);
    if (!similarAmount(row.amount, draft.amount)) continue;
    history.categories.set(category, (history.categories.get(category) ?? 0) + 1);
    if (confirmed) history.confirmed++;
    if (row.merchantAlias?.trim()) history.aliases.add(row.merchantAlias.trim());
  }
  return history;
}

const DAY_MS = 86_400_000;

// A merchant credit for exactly the amount of an earlier purchase there is its refund.
export function refundOrigin(state: AppState, draft: BrandSource & Pick<Transaction, "id" | "amount" | "date">) {
  if (draft.amount <= 0) return undefined;
  const brand = brandKey(draft);
  const date = Date.parse(draft.date);
  if (!brand || Number.isNaN(date)) return undefined;
  const open = openReviewIds(state);
  let origin: Transaction | undefined;
  for (const row of state.transactions) {
    if (row.amount >= 0 || Math.abs(row.amount + draft.amount) >= 0.005 || row.id === draft.id || row.aiAssigned || open.has(row.id)) continue;
    const age = date - Date.parse(row.date);
    if (!(age >= 0 && age <= 180 * DAY_MS) || brandKey(row) !== brand) continue;
    if (canonicalCategory(classify(row).category) === "Prüfen") continue;
    if (!origin || row.date > origin.date) origin = row;
  }
  return origin;
}

export function categoryFitsSign(category: Category, amount: number) {
  if (category.startsWith("Transfer")) return true;
  return (isIncomeCategory(category) || category === "Rückerstattungen") === amount > 0;
}

// The fixed bank rule decides on its own when nothing the household confirmed contradicts it.
function usableRule(input: AiBookingInput, history: BrandHistory): Category | undefined {
  const known = knownMerchantCategory(input.text, input.amount);
  if (!known || known === "Prüfen") return undefined;
  const rule = canonicalCategory(known);
  if (!categoryFitsSign(rule, input.amount)) return undefined;
  // Small station receipts are snacks or car wash, not fuel.
  if ((rule === "Mobilität" || rule === "Tanken") && Math.abs(input.amount) < 15) return undefined;
  const fits = (category: Category) => category === rule || !!RULE_REFINEMENTS[rule]?.includes(category);
  if ([...history.categories.keys(), ...history.confirmedCategories].some((category) => !fits(category))) return undefined;
  return rule;
}

export type EvidenceSource = "Historie" | "Regel" | "Erstattung";
export type AiSuggestionDraft = { category: Category; merchantAlias?: string; source: "KI" | "Regel" | "Historie" };
export type EvidenceDecision =
  | { accepted: true; category: Category; merchantAlias?: string; source: EvidenceSource; detail?: string }
  | { accepted: false; reason: string; suggestion?: AiSuggestionDraft };

// The model reports ~95 % for right and wrong answers alike, so an answer is
// only applied when the household's own history or a fixed bank rule backs it.
export function decideWithEvidence(
  state: AppState,
  draft: BrandSource & Pick<Transaction, "id" | "amount"> & Partial<Pick<Transaction, "date">>,
  input: AiBookingInput,
  answer: AiCategorization | undefined,
): EvidenceDecision {
  const history = brandHistory(state, draft);
  const seen = [...history.categories.keys()];
  const shopName = providerMerchant(input.text);
  const ownAlias = () => history.aliases.size === 1 && !draft.merchantAlias ? [...history.aliases][0] : undefined;
  // A confirmed choice for this brand and amount range, with nothing contradicting it.
  if (seen.length === 1 && history.confirmed >= 1) {
    const alias = ownAlias() ?? (!draft.merchantAlias ? shopName : undefined);
    return { accepted: true, category: seen[0], source: "Historie", ...(alias ? { merchantAlias: alias } : {}) };
  }
  const origin = draft.date ? refundOrigin(state, { ...draft, date: draft.date }) : undefined;
  if (origin) {
    const alias = !draft.merchantAlias ? origin.merchantAlias ?? shopName : undefined;
    return { accepted: true, category: "Rückerstattungen", source: "Erstattung",
      detail: `Kauf vom ${origin.date} (${canonicalCategory(classify(origin).category)})`, ...(alias ? { merchantAlias: alias } : {}) };
  }
  const rule = usableRule(input, history);
  if (rule) {
    const refined = answer?.accepted && answer.category !== rule && RULE_REFINEMENTS[rule]?.includes(canonicalCategory(answer.category))
      ? canonicalCategory(answer.category) : rule;
    const alias = draft.merchantAlias ? undefined : (answer?.accepted ? answer.merchant : undefined) ?? shopName;
    return { accepted: true, category: refined, source: "Regel", ...(alias ? { merchantAlias: alias } : {}) };
  }
  const reject = (reason: string): EvidenceDecision => {
    const suggestion = suggestCategory(history, input, answer, shopName);
    return { accepted: false, reason, ...(suggestion ? { suggestion } : {}) };
  };
  if (!answer) return reject("keine Antwort");
  if (!answer.accepted || answer.category === "Prüfen") return reject(answer.reason ?? "unsicher");
  const category = canonicalCategory(answer.category);
  if (seen.some((item) => item !== category)) return reject("widerspricht eigener Historie");
  const known = knownMerchantCategory(input.text, input.amount);
  if (!known || known === "Prüfen" || (known !== category && !RULE_REFINEMENTS[known]?.includes(category)))
    return reject("keine Bestätigung durch Regel oder eigene Historie");
  return { accepted: true, category, source: "Regel", ...(answer.merchant ? { merchantAlias: answer.merchant } : {}) };
}

// What the review dialog pre-fills: the household's own majority, else the bank rule, else the model.
function suggestCategory(
  history: BrandHistory, input: AiBookingInput, answer: AiCategorization | undefined, shopName: string | undefined,
): AiSuggestionDraft | undefined {
  const name = answer?.merchant && !isPaymentProviderName(answer.merchant) ? answer.merchant : shopName;
  const withName = (suggestion: AiSuggestionDraft): AiSuggestionDraft => name ? { ...suggestion, merchantAlias: name } : suggestion;
  const majority = [...history.categories].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (majority && categoryFitsSign(majority, input.amount)) return withName({ category: majority, source: "Historie" });
  const known = knownMerchantCategory(input.text, input.amount);
  if (known && known !== "Prüfen" && categoryFitsSign(canonicalCategory(known), input.amount))
    return withName({ category: canonicalCategory(known), source: "Regel" });
  if (answer && answer.category !== "Prüfen" && answer.confidence >= 50) {
    const category = canonicalCategory(answer.category);
    if (categoryFitsSign(category, input.amount)) return withName({ category, source: "KI" });
  }
  return undefined;
}

const isPaymentProviderName = (name: string) => /^(?:paypal|klarna|sumup|stripe|adyen)\b/i.test(name.trim());

export function decideReviewWithEvidence(
  state: AppState, reviewId: string, input: AiBookingInput, answer: AiCategorization | undefined,
): EvidenceDecision {
  const item = state.reviewQueue?.find((entry) => entry.id === reviewId);
  if (item?.kind !== "booking" || item.draft.amount === null) return { accepted: false, reason: "Prüfung nicht mehr offen" };
  return decideWithEvidence(state, { ...item.draft, amount: item.draft.amount }, input, answer);
}
