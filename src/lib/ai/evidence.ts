import { createAccountMerchantResolver } from "@/lib/automation/aliases";
import { merchantAliasSourceKey, merchantRuleKey } from "@/lib/import/merchant-rules";
import { classify } from "@/lib/calc";
import { allCategories, canonicalCategory, knownMerchantCategory, merchantKeywords, type Category } from "@/lib/categories";
import { hasCategoryChoice } from "@/lib/manual-category";
import { isIncomeCategory } from "@/lib/fixed";
import { recurringLunchCategory } from "@/lib/recurring-purpose";
import type { AppState, Transaction } from "@/lib/types";
import { isRaphaelPayment } from "@/lib/shared-holiday";
import {
  amexEntertainmentCredit, amexReversalPair, isRefundableSpending, partnerContribution, paypalCreditPair, paypalRecurringMonths,
  returnedDebitPair, type MatcherDraft,
} from "./booking-matchers";
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
  // Transfer directions and currencies ("To EUR …", "From …") name no brand.
  "to", "from", "payment", "transfer", "von", "an", "eur", "usd", "gbp", "chf",
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

// A merchant credit for an earlier purchase there is its refund: the exact amount first,
// else (partial refund) the latest larger purchase of that brand.
export function refundOrigin(state: AppState, draft: BrandSource & Pick<Transaction, "id" | "amount" | "date">) {
  if (draft.amount <= 0 || isRaphaelPayment(draft)) return undefined;
  const brand = brandKey(draft);
  const date = Date.parse(draft.date);
  if (!brand || Number.isNaN(date)) return undefined;
  const open = openReviewIds(state);
  let exact: Transaction | undefined;
  let partial: Transaction | undefined;
  for (const row of state.transactions) {
    if (row.amount >= 0 || row.id === draft.id || row.aiAssigned || open.has(row.id)) continue;
    const age = date - Date.parse(row.date);
    if (!(age >= 0 && age <= 180 * DAY_MS) || brandKey(row) !== brand || !isRefundableSpending(row)) continue;
    if (Math.abs(row.amount + draft.amount) < 0.005) {
      if (!exact || row.date > exact.date) exact = row;
    } else if (-row.amount > draft.amount && (!partial || row.date > partial.date)) partial = row;
  }
  return exact ?? partial;
}

type KeywordRow = { id: string; amount: number; category: Category; keywords: string[] };
const keywordRows = new WeakMap<readonly Transaction[], KeywordRow[]>();

function confirmedKeywordRows(state: AppState): KeywordRow[] {
  const cached = keywordRows.get(state.transactions);
  if (cached) return cached;
  const rows = state.transactions.flatMap((row): KeywordRow[] => {
    // The user's own choice, or their learned rule: an override the automatic evidence did not produce.
    const learned = row.categoryOverride && row.automaticCategoryEvidence?.category !== row.category;
    if (row.aiAssigned || !(hasCategoryChoice(row) || learned)) return [];
    const category = canonicalCategory(row.category);
    if (category === "Prüfen") return [];
    const keywords = merchantKeywords([row.merchantAlias, row.rawDescription ?? row.description].filter(Boolean).join(" "));
    return keywords.length ? [{ id: row.id, amount: row.amount, category, keywords }] : [];
  });
  keywordRows.set(state.transactions, rows);
  return rows;
}

export type KeywordHabit = {
  /** Choices at a similar amount: a 4 € snack and a 70 € tank at a station differ. */
  similar: Map<Category, number>;
  /** Choices at any amount of the same sign, for contradiction checks. */
  any: Set<Category>;
};

// How the household itself filed shops that share a keyword-rule word ("Trafik", "OMV").
// A fixed keyword default is a guess for every household; this is the household's habit.
export function keywordHabit(state: AppState, draft: Pick<Transaction, "id" | "amount">, text: string): KeywordHabit {
  const habit: KeywordHabit = { similar: new Map(), any: new Set() };
  const words = new Set(merchantKeywords(text));
  if (!words.size) return habit;
  const open = openReviewIds(state);
  for (const row of confirmedKeywordRows(state)) {
    if (row.id === draft.id || open.has(row.id) || Math.sign(row.amount) !== Math.sign(draft.amount) ||
      !row.keywords.some((word) => words.has(word))) continue;
    habit.any.add(row.category);
    if (similarAmount(row.amount, draft.amount))
      habit.similar.set(row.category, (habit.similar.get(row.category) ?? 0) + 1);
  }
  return habit;
}

// One category at a similar amount, chosen at least twice and never contradicted there.
function habitualCategory(habit: KeywordHabit): Category | undefined {
  const [entry] = habit.similar;
  return habit.similar.size === 1 && entry[1] >= 2 ? entry[0] : undefined;
}

export function categoryFitsSign(category: Category, amount: number) {
  if (category.startsWith("Transfer")) return true;
  return (isIncomeCategory(category) || category === "Rückerstattungen") === amount > 0;
}

const FUEL_STATION = /\bshell\b|\bomv\b|\beni\b|tankstelle|\btanken\b/i;
const PAYMENT_APP = /\bpace\s*pay\b/i;
const HOTSPOT = /\bhotspot\b/i;

// The fixed bank rule, where its keyword plausibly means what the rule says.
function plausibleRule(input: AiBookingInput, draft: Pick<MatcherDraft, "description" | "date">): Category | undefined {
  const known = knownMerchantCategory(input.text, input.amount);
  if (!known || known === "Prüfen") return undefined;
  let rule = canonicalCategory(known);
  // "Hotspot" is the household's lunch place only under its exact name; "HOTSPOT 1234" is a kiosk of that chain.
  if (rule === "Mittagessen" && HOTSPOT.test(input.text)) {
    const lunch = draft.date ? recurringLunchCategory(draft.description, draft.date, input.amount) : undefined;
    if (!lunch) return undefined;
    rule = lunch;
  }
  if (!categoryFitsSign(rule, input.amount)) return undefined;
  // A meal does not cost less than a coffee; such a receipt is a tip, a deposit or a toilet.
  if (rule === "Restaurants" && Math.abs(input.amount) < 1.5) return undefined;
  return rule;
}

// The fixed bank rule decides on its own when nothing the household confirmed contradicts it.
function usableRule(
  input: AiBookingInput, draft: Pick<MatcherDraft, "description" | "date">, history: BrandHistory, habit: KeywordHabit,
): Category | undefined {
  const rule = plausibleRule(input, draft);
  if (!rule) return undefined;
  // Small station receipts are snacks or car wash, not fuel.
  if ((rule === "Mobilität" || rule === "Tanken") && Math.abs(input.amount) < 15) return undefined;
  const fits = (category: Category) => category === rule || !!RULE_REFINEMENTS[rule]?.includes(category);
  if ([...history.categories.keys(), ...history.confirmedCategories, ...habit.any].some((category) => !fits(category)))
    return undefined;
  // The household's usual refinement ("Tanken" for a full tank) beats the broad rule ("Mobilität").
  const [usual] = [...habit.similar].sort((left, right) => right[1] - left[1]);
  if (usual && usual[0] !== rule && fits(usual[0])) return usual[0];
  // "Mobilität" is the rule's broad name for a station; at a fuel-sized amount the station sold fuel.
  return rule === "Mobilität" && FUEL_STATION.test(input.text) && !PAYMENT_APP.test(input.text) ? "Tanken" : rule;
}

type OwnRules = { resolve: ReturnType<typeof createAccountMerchantResolver>; chosen: Map<string, Set<Category>> };
const ownRules = new WeakMap<AppState, OwnRules>();
const ruleSourceKey = (row: Pick<Transaction, "bank" | "description" | "rawDescription">) => {
  const source = { ...row, merchantAlias: undefined };
  return merchantAliasSourceKey(source) ?? merchantRuleKey(source);
};

// The household's own merchant rule for exactly this booking text. The import leaves a rule without a
// shop name (an ATM, a terminal) for review although the user decided it; the decision is still theirs –
// unless their own choices for that text disagree with it (groceries and lunch at the same supermarket).
function ownRule(state: AppState, draft: MatcherDraft): { category: Category; merchantAlias?: string } | undefined {
  if (!draft.bank || !state.merchantRules?.length) return undefined;
  let rules = ownRules.get(state);
  if (!rules) {
    const chosen = new Map<string, Set<Category>>();
    for (const row of state.transactions) {
      if (row.aiAssigned || !hasCategoryChoice(row)) continue;
      const key = ruleSourceKey(row);
      chosen.set(key, (chosen.get(key) ?? new Set()).add(canonicalCategory(row.category)));
    }
    rules = { resolve: createAccountMerchantResolver(state), chosen };
    ownRules.set(state, rules);
  }
  const booking = {
    id: draft.id, date: draft.date ?? "", bank: draft.bank, pocket: draft.pocket ?? null, description: draft.description,
    rawDescription: draft.rawDescription, rawDetails: draft.rawDetails, amount: draft.amount, category: "Prüfen" as const, includeInPlan: true,
  };
  const match = rules.resolve(booking);
  if (match.kind !== "matched" || match.normalized || match.choice.identityOnly) return undefined;
  const category = canonicalCategory(match.choice.category);
  if (category === "Prüfen" || !categoryFitsSign(category, draft.amount)) return undefined;
  if ([...(rules.chosen.get(ruleSourceKey(booking)) ?? [])].some((choice) => choice !== category)) return undefined;
  return { category, ...(match.choice.merchantAlias ? { merchantAlias: match.choice.merchantAlias } : {}) };
}

export type EvidenceSource = "Historie" | "Regel" | "Erstattung" | "Branche";
export type AiSuggestionDraft = { category: Category; merchantAlias?: string; source: "KI" | "Regel" | "Historie" | "Branche" | "Abo" };
export type EvidenceDecision =
  | { accepted: true; category: Category; merchantAlias?: string; source: EvidenceSource; detail?: string }
  | { accepted: false; reason: string; suggestion?: AiSuggestionDraft };
// Extra, independent facts about the merchant (e.g. its industry from Wikidata or its web shop).
// strong: a specific shop type under this exact name at this place (OpenStreetMap), or the household's habit for that type.
export type EvidenceContext = { industry?: { category: Category; label: string; strong?: boolean } };

// Bank facts that settle a booking without any model: fixed pairs and the partner's notes.
function specialCase(state: AppState, draft: MatcherDraft): EvidenceDecision | undefined {
  const pair = amexEntertainmentCredit(draft) ?? returnedDebitPair(state, draft) ?? amexReversalPair(state, draft) ??
    paypalCreditPair(state, draft) ?? partnerContribution(state, draft);
  if (!pair) return undefined;
  return { accepted: true, category: pair.category, source: pair.refund ? "Erstattung" : "Regel", detail: pair.detail,
    ...(pair.merchantAlias && !draft.merchantAlias ? { merchantAlias: pair.merchantAlias } : {}) };
}

// The model reports ~95 % for right and wrong answers alike, so an answer is
// only applied when the household's own history or a fixed bank rule backs it.
export function decideWithEvidence(
  state: AppState,
  draft: MatcherDraft,
  input: AiBookingInput,
  answer: AiCategorization | undefined,
  context: EvidenceContext = {},
): EvidenceDecision {
  const special = specialCase(state, draft);
  if (special) return special;
  const rule = ownRule(state, draft);
  if (rule)
    return { accepted: true, category: rule.category, source: "Regel", detail: "eigene Händlerregel",
      ...(rule.merchantAlias && !draft.merchantAlias ? { merchantAlias: rule.merchantAlias } : {}) };
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
    const partial = Math.abs(origin.amount + draft.amount) >= 0.005;
    return { accepted: true, category: "Rückerstattungen", source: "Erstattung",
      detail: `${partial ? "Teil-Erstattung zum " : ""}Kauf vom ${origin.date} (${canonicalCategory(classify(origin).category)})`,
      ...(alias ? { merchantAlias: alias } : {}) };
  }
  const habit = keywordHabit(state, draft, input.text);
  const habitual = habitualCategory(habit);
  if (habitual && categoryFitsSign(habitual, input.amount) && seen.every((item) => item === habitual) &&
    [...history.confirmedCategories].every((item) => item === habitual)) {
    const alias = ownAlias() ?? (!draft.merchantAlias ? shopName : undefined);
    return { accepted: true, category: habitual, source: "Historie", detail: "wie ähnliche Geschäfte im Haushalt",
      ...(alias ? { merchantAlias: alias } : {}) };
  }
  const fixed = usableRule(input, draft, history, habit);
  if (fixed) {
    const refined = answer?.accepted && answer.category !== fixed && RULE_REFINEMENTS[fixed]?.includes(canonicalCategory(answer.category))
      ? canonicalCategory(answer.category) : fixed;
    const alias = draft.merchantAlias ? undefined : (answer?.accepted ? answer.merchant : undefined) ?? shopName;
    return { accepted: true, category: refined, source: "Regel", ...(alias ? { merchantAlias: alias } : {}) };
  }
  const reject = (reason: string): EvidenceDecision => {
    const suggestion = suggestCategory(state, draft, history, habit, input, answer, shopName, context);
    return { accepted: false, reason, ...(suggestion ? { suggestion } : {}) };
  };
  // A shop OpenStreetMap knows by name and place needs no model; the household's own choices still win.
  const web = context.industry?.strong ? canonicalCategory(context.industry.category) : undefined;
  if (web && !seen.some((item) => item !== web) && [...history.confirmedCategories].every((item) => item === web) &&
    categoryFitsSign(web, input.amount) && !(web === "Tanken" && Math.abs(input.amount) < 15) &&
    (!answer?.accepted || answer.category === "Prüfen" || canonicalCategory(answer.category) === web ||
      !!RULE_REFINEMENTS[web]?.includes(canonicalCategory(answer.category)) || answer.confidence < 50)) {
    const category = answer?.accepted && RULE_REFINEMENTS[web]?.includes(canonicalCategory(answer.category))
      ? canonicalCategory(answer.category) : web;
    return { accepted: true, category, source: "Branche", detail: context.industry!.label.slice(0, 80),
      ...(!draft.merchantAlias && shopName ? { merchantAlias: shopName } : {}) };
  }
  if (!answer) return reject("keine Antwort");
  if (!answer.accepted || answer.category === "Prüfen") return reject(answer.reason ?? "unsicher");
  const category = canonicalCategory(answer.category);
  if (seen.some((item) => item !== category)) return reject("widerspricht eigener Historie");
  // The merchant's own industry is independent of the model, so agreement of both is evidence.
  const industry = context.industry && canonicalCategory(context.industry.category);
  if (industry && [...history.confirmedCategories].every((item) => item === category) && categoryFitsSign(category, input.amount) &&
    (industry === category || RULE_REFINEMENTS[industry]?.includes(category))) {
    const alias = draft.merchantAlias ? undefined : answer.merchant ?? shopName;
    return { accepted: true, category, source: "Branche", detail: context.industry!.label.slice(0, 80),
      ...(alias ? { merchantAlias: alias } : {}) };
  }
  // The model echoing a keyword is no evidence where the keyword does not apply (a kiosk, a tip).
  const known = plausibleRule(input, draft);
  if (!known || (known !== category && !RULE_REFINEMENTS[known]?.includes(category)))
    return reject("keine Bestätigung durch Regel oder eigene Historie");
  return { accepted: true, category, source: "Regel", ...(answer.merchant ? { merchantAlias: answer.merchant } : {}) };
}

// What the review dialog pre-fills: the household's own majority, else the bank rule,
// else a recurring PayPal amount, else the merchant's industry, else the model.
function suggestCategory(
  state: AppState, draft: MatcherDraft, history: BrandHistory, habit: KeywordHabit,
  input: AiBookingInput, answer: AiCategorization | undefined, shopName: string | undefined, context: EvidenceContext,
): AiSuggestionDraft | undefined {
  const name = answer?.merchant && !isPaymentProviderName(answer.merchant) ? answer.merchant : shopName;
  const withName = (suggestion: AiSuggestionDraft): AiSuggestionDraft => name ? { ...suggestion, merchantAlias: name } : suggestion;
  const majority = [...history.categories].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (majority && categoryFitsSign(majority, input.amount)) return withName({ category: majority, source: "Historie" });
  const usual = [...habit.similar].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (usual && categoryFitsSign(usual, input.amount)) return withName({ category: usual, source: "Historie" });
  const known = knownMerchantCategory(input.text, input.amount);
  if (known && known !== "Prüfen" && categoryFitsSign(canonicalCategory(known), input.amount))
    return withName({ category: canonicalCategory(known), source: "Regel" });
  if (paypalRecurringMonths(state, draft) >= 3) return { category: "Abonnements", source: "Abo" };
  const industry = context.industry && canonicalCategory(context.industry.category);
  if (industry && categoryFitsSign(industry, input.amount)) return withName({ category: industry, source: "Branche" });
  if (answer && answer.category !== "Prüfen" && answer.confidence >= 50) {
    const category = canonicalCategory(answer.category);
    if (categoryFitsSign(category, input.amount)) return withName({ category, source: "KI" });
  }
  return undefined;
}

const isPaymentProviderName = (name: string) => /^(?:paypal|klarna|sumup|stripe|adyen)\b/i.test(name.trim());

// The shop whose industry is worth looking up: the model's name, else the one behind PayPal/Klarna.
export function industryLookupName(input: AiBookingInput, answer: AiCategorization | undefined) {
  const name = answer?.merchant && !isPaymentProviderName(answer.merchant) ? answer.merchant : providerMerchant(input.text);
  return name && name.trim().length >= 3 ? name.trim().slice(0, 90) : undefined;
}

export function industryContext(value: { category?: string; label?: string; strong?: boolean } | undefined): EvidenceContext {
  if (!value?.category || !(allCategories as readonly string[]).includes(value.category)) return {};
  return { industry: { category: value.category as Category, label: value.label ?? "", ...(value.strong ? { strong: true } : {}) } };
}

export function decideReviewWithEvidence(
  state: AppState, reviewId: string, input: AiBookingInput, answer: AiCategorization | undefined,
  context: EvidenceContext = {},
): EvidenceDecision {
  const item = state.reviewQueue?.find((entry) => entry.id === reviewId);
  if (item?.kind !== "booking" || item.draft.amount === null) return { accepted: false, reason: "Prüfung nicht mehr offen" };
  return decideWithEvidence(state, { ...item.draft, amount: item.draft.amount }, input, answer, context);
}
