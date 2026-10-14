import { classify } from "@/lib/calc";
import { canonicalCategory, isTravelCategory } from "@/lib/categories";
import { categorySchema, transactionSchema, type AppState, type ReviewItem, type Transaction } from "@/lib/types";
import { isIncomeCategory } from "@/lib/fixed";
import { ambiguousMerchant, unresolvedTerminal } from "./merchant-description";
import { isSpecificMerchantKey, merchantRuleKey, storedMerchantKey, type MerchantChoice } from "./merchant-rules";
import { statementFingerprint, legacyFingerprint } from "./identity";
import { appendStatementRows } from "./statements";
import { bookingReviewReason, type commitStatementImport } from "./review";
import { hasCategoryChoice, hasManualCategory } from "@/lib/manual-category";

type BookingReview = Extract<ReviewItem, { kind: "booking" }>;
type ReviewIndex = {
  byId: Map<string, Transaction>;
  merchants: Map<string, Transaction[]>;
  reviews: Map<string, BookingReview[]>;
  receipts: Set<string>;
  rules: Map<string, MerchantChoice>;
  conflictingRules: boolean;
  ambiguousIds: boolean;
};

// Provider states are immutable snapshots. A general edit/import creates a new
// snapshot; only this category-only path can carry its index to the next one.
const indexes = new WeakMap<AppState["transactions"], {
  reviewQueue: AppState["reviewQueue"];
  fixedReceipts: AppState["fixedReceipts"];
  merchantRules: AppState["merchantRules"];
  index: ReviewIndex;
}>();

function cacheIndex(state: AppState, index: ReviewIndex) {
  indexes.set(state.transactions, {
    reviewQueue: state.reviewQueue, fixedReceipts: state.fixedReceipts, merchantRules: state.merchantRules, index,
  });
}

function reviewIndex(state: AppState): ReviewIndex {
  const cached = indexes.get(state.transactions);
  if (cached && cached.reviewQueue === state.reviewQueue && cached.fixedReceipts === state.fixedReceipts &&
    cached.merchantRules === state.merchantRules) return cached.index;
  const index: ReviewIndex = {
    byId: new Map(), merchants: new Map(), reviews: new Map(), receipts: new Set(), rules: new Map(),
    conflictingRules: false, ambiguousIds: false,
  };
  for (const row of state.transactions) {
    if (index.byId.has(row.id)) index.ambiguousIds = true;
    index.byId.set(row.id, row);
    const key = merchantRuleKey(row);
    const group = index.merchants.get(key) ?? [];
    group.push(row);
    index.merchants.set(key, group);
  }
  const reviewIds = new Set<string>();
  for (const item of state.reviewQueue ?? []) {
    if (item.kind !== "booking") continue;
    if (reviewIds.has(item.draft.id)) index.ambiguousIds = true;
    reviewIds.add(item.draft.id);
    const key = merchantRuleKey(item.draft);
    const group = index.reviews.get(key) ?? [];
    group.push(item);
    index.reviews.set(key, group);
  }
  for (const receipt of state.fixedReceipts ?? []) {
    if (receipt.merchantKey) index.receipts.add(storedMerchantKey(receipt.merchantKey));
    if (receipt.booking) index.receipts.add(merchantRuleKey(receipt.booking));
  }
  for (const rule of state.merchantRules ?? []) {
    const key = storedMerchantKey(rule.key);
    if (index.rules.has(key) || canonicalCategory(rule.category) !== rule.category)
      index.conflictingRules = true;
    if (isSpecificMerchantKey(key)) index.rules.set(key, {
      category: canonicalCategory(rule.category),
      ...(rule.fixedCost !== undefined ? { fixedCost: rule.fixedCost } : {}),
      ...(rule.merchantAlias ? { merchantAlias: rule.merchantAlias } : {}),
    });
  }
  cacheIndex(state, index);
  return index;
}

const ordinary = (row: Transaction) => {
  const result = classify(row);
  return row.amount < 0 && !result.isTransfer && !isTravelCategory(result.category) &&
    !result.isFixedCost && !isIncomeCategory(result.category);
};

// Return undefined when bank facts or accounting scope need the full import
// pipeline. This path only changes reviewed ordinary spending and its exact
// merchant twins; it does not change transfers, contracts or holiday matching.
export function approveReviewedBooking(
  state: AppState,
  selected: Transaction,
): ReturnType<typeof commitStatementImport> | undefined {
  if (!selected.categoryOverride || !categorySchema.safeParse(selected.category).success || selected.category === "Prüfen" ||
    !ordinary(selected)) return;
  const item = state.reviewQueue?.find((entry): entry is BookingReview =>
    entry.kind === "booking" && entry.draft.id === selected.id);
  if (!item || item.draft.amount === null || !item.draft.date || item.importIssues?.length) return;
  if (selected.merchantAlias || item.draft.merchantAlias) return;
  const key = merchantRuleKey(item.draft);
  if (!isSpecificMerchantKey(key) || ambiguousMerchant(item.draft) || unresolvedTerminal(item.draft.description)) return;
  const index = reviewIndex(state);
  if (index.receipts.has(key) || index.conflictingRules || index.ambiguousIds) return;
  const source = index.byId.get(selected.id) ?? transactionSchema.parse(item.draft);
  if (index.byId.has(selected.id) ? merchantRuleKey(selected) !== key
    : statementFingerprint(source) !== statementFingerprint(selected)) return;
  const reviews = index.reviews.get(key) ?? [];
  if (reviews.some((entry) => entry.draft.amount === null || !entry.draft.date || entry.importIssues?.length)) return;
  const affected = new Map([[source.id, source], ...(index.merchants.get(key) ?? []).map((row) => [row.id, row] as const)]);
  for (const review of reviews)
    if (!affected.has(review.draft.id)) affected.set(review.draft.id, transactionSchema.parse(review.draft));
  const updated = new Map<string, Transaction>();
  const selectedFingerprint = statementFingerprint(selected);
  for (const row of affected.values()) {
    if (row.id !== selected.id && hasCategoryChoice(row)) continue;
    if (!ordinary(row) || ambiguousMerchant(row) || unresolvedTerminal(row.description)) return;
    const candidate = transactionSchema.parse({ ...row, category: selected.category, categoryOverride: true, includeInPlan: true,
      ...(row.id === selected.id && selected.manualCategory !== undefined ? { manualCategory: selected.manualCategory } : {}),
      ...(row.id === selected.id && selected.reviewed !== undefined ? { reviewed: selected.reviewed } : {}),
      ...(selected.fixedCost !== undefined && (row.id === selected.id || statementFingerprint(row) === selectedFingerprint)
        ? { fixedCost: selected.fixedCost } : {}) });
    if (!ordinary(candidate)) return;
    const result = classify(candidate);
    updated.set(row.id, { ...candidate, category: result.category, includeInPlan: result.includeInPlan });
  }
  const incoming = [...updated.values()].filter((row) => !index.byId.has(row.id));
  // Adding a new booking can change cross-booking holiday/refund matching.
  // Keep those cases on the original reconciler.
  if (incoming.length && (state.holidayRanges?.length || incoming.some((row) => row.sharedWithRaphael))) return;
  if (incoming.length) {
    const ignored = new Set(state.ignoredStatementKeys ?? []);
    if (incoming.some((row) => ignored.has(statementFingerprint(row)) || ignored.has(legacyFingerprint(row)))) return;
  }
  const rules = new Map(index.rules);
  rules.set(key, { ...rules.get(key), category: canonicalCategory(selected.category),
    ...(selected.fixedCost !== undefined ? { fixedCost: selected.fixedCost } : {}) });
  if (rules.size > 100_000) return;
  let next: AppState = {
    ...state,
    transactions: state.transactions.map((row) => updated.get(row.id) ?? row),
    merchantRules: [...rules].map(([key, choice]) => ({ key, ...choice })),
  };
  // Preserve an explicit selection when duplicate pending source drafts exist.
  const incomingByKey = new Map<string, Transaction>();
  const selectedIncoming = updated.get(selected.id);
  if (selectedIncoming && !index.byId.has(selected.id))
    incomingByKey.set(statementFingerprint(selectedIncoming), selectedIncoming);
  for (const review of reviews) {
    const row = updated.get(review.draft.id);
    if (row && !index.byId.has(row.id) && (!incomingByKey.has(statementFingerprint(row)) ||
      !hasManualCategory(incomingByKey.get(statementFingerprint(row))!)))
      incomingByKey.set(statementFingerprint(row), row);
  }
  const uniqueIncoming = [...incomingByKey.values()];
  const appended = incoming.length ? appendStatementRows(next, uniqueIncoming) : { state: next, added: 0, duplicates: 0 };
  next = appended.state;
  const ruleIndex = new Map([...rules].map(([key, choice]) => [key, new Set([choice.category])]));
  const queue = (state.reviewQueue ?? []).flatMap((entry): ReviewItem[] => {
    if (entry.kind !== "booking") return [entry];
    const row = updated.get(entry.draft.id);
    if (!row) return [entry];
    const draft = { ...entry.draft, ...row };
    const message = bookingReviewReason(next, draft, ruleIndex, index.byId.has(draft.id));
    return message ? [{ ...entry, draft, message }] : [];
  });
  next = {
    ...next,
    reviewQueue: queue,
    ...(state.importStatus ? { importStatus: { ...state.importStatus, imported: state.importStatus.imported + appended.added } } : {}),
  };
  const byId = new Map(index.byId);
  for (const row of updated.values()) if (byId.has(row.id)) byId.set(row.id, row);
  const addedRows = next.transactions.slice(state.transactions.length);
  for (const row of addedRows) byId.set(row.id, row);
  const merchants = new Map(index.merchants);
  merchants.set(key, [...(index.merchants.get(key) ?? []).map((row) => byId.get(row.id)!), ...addedRows]);
  const nextReviews = new Map(index.reviews);
  nextReviews.set(key, queue.filter((entry): entry is BookingReview => entry.kind === "booking" && updated.has(entry.draft.id)));
  cacheIndex(next, { ...index, byId, merchants, reviews: nextReviews, rules });
  return { state: next, added: appended.added, duplicates: appended.duplicates, changes: [] };
}
