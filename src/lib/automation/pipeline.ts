import { classify } from "@/lib/calc";
import {
  transactionSchema,
  type AppState,
  type Transaction,
} from "@/lib/types";
import { createMerchantRuleApplier } from "@/lib/import/merchant-rules";
import { MerchantIndex } from "./merchants";
import { isAutomationLocked } from "./locks";
export { isAutomationLocked } from "./locks";

export function enrichTransaction(
  row: Transaction,
  index: MerchantIndex,
): Transaction {
  if (isAutomationLocked(row)) return { ...row, is_locked: true };
  const classified = classify(row);
  if (classified.isTransfer || row.amount >= 0) return row;
  const match = index.match(row.description);
  if (
    !match.merchant ||
    match.requiresManualReview ||
    match.method === "fuzzy"
  ) {
    return { ...row, requires_manual_review: true };
  }
  // Existing contextual rules (e.g. lunch time) keep precedence over defaults.
  const category =
    row.category === "Prüfen" ? match.merchant.defaultCategory : row.category;
  return transactionSchema.parse({
    ...row,
    merchantId: match.merchant.id,
    merchantAlias: match.merchant.canonicalName,
    category,
    requires_manual_review: false,
  });
}

export function backfillBatch(
  state: AppState,
  ids: Set<string>,
  index: MerchantIndex,
): AppState {
  const applyRule = createMerchantRuleApplier(state);
  const updated = new Map<string, Transaction>();
  const update = (row: Transaction): Transaction => {
    if (!ids.has(row.id)) return row;
    const next = enrichTransaction(
      isAutomationLocked(row) ? row : applyRule(row),
      index,
    );
    updated.set(row.id, next);
    return next;
  };
  const transactions = state.transactions.map(update);
  const fixedReceipts = state.fixedReceipts?.map((item) => {
    if (!item.booking || !ids.has(item.booking.id)) return item;
    const booking = update(item.booking);
    return { ...item, booking, category: booking.category };
  });
  const needsReview = (row: Transaction) =>
    row.category === "Prüfen" ||
    (row.requires_manual_review === true && !isAutomationLocked(row));
  const queue = (state.reviewQueue ?? []).flatMap((item) => {
    if (item.kind !== "booking" || !ids.has(item.draft.id)) return [item];
    const row = updated.get(item.draft.id);
    if (!row) return [];
    if (isAutomationLocked(row) && needsReview(row))
      return [{ ...item, draft: row }];
    return needsReview(row)
      ? [
          {
            ...item,
            draft: row,
            message: "Händlerzuordnung unsicher – bitte prüfen.",
          },
        ]
      : [];
  });
  const queued = new Set(queue.map((item) => item.id));
  for (const row of updated.values()) {
    if (!needsReview(row) || queued.has(row.id)) continue;
    queue.push({
      kind: "booking",
      id: row.id,
      draft: row,
      message: "Händlerzuordnung unsicher – bitte prüfen.",
    });
  }
  return {
    ...state,
    transactions,
    ...(fixedReceipts ? { fixedReceipts } : {}),
    reviewQueue: queue,
  };
}

export function retainLockedAssignments(
  previous: AppState,
  next: AppState,
): AppState {
  const locked = new Map(
    [
      ...previous.transactions,
      ...(previous.fixedReceipts ?? []).flatMap((item) =>
        item.booking ? [item.booking] : [],
      ),
    ]
      .filter(isAutomationLocked)
      .map((row) => [row.id, row]),
  );
  const restore = (row: Transaction): Transaction => {
    const original = locked.get(row.id);
    if (!original) return row;
    return {
      ...row,
      description: original.description,
      merchantAlias: original.merchantAlias,
      merchantId: original.merchantId,
      category: original.category,
      categoryOverride: original.categoryOverride,
      manualCategory: original.manualCategory,
      reviewed: original.reviewed,
      includeInPlan: original.includeInPlan,
      fixedCost: original.fixedCost,
      requires_manual_review: original.requires_manual_review,
      is_locked: true,
    };
  };
  return {
    ...next,
    transactions: next.transactions.map(restore),
    ...(next.fixedReceipts
      ? {
          fixedReceipts: next.fixedReceipts.map((item) =>
            item.booking
              ? {
                  ...item,
                  booking: restore(item.booking),
                  category:
                    locked.get(item.booking.id)?.category ?? item.category,
                }
              : item,
          ),
        }
      : {}),
    ...(next.reviewQueue
      ? {
          reviewQueue: next.reviewQueue.map((item) =>
            item.kind === "fixed"
              ? {
                  ...item,
                  change: {
                    ...item.change,
                    bookings: item.change.bookings.map(restore),
                  },
                }
              : item.draft.amount !== null && item.draft.date
                ? { ...item, draft: restore(item.draft as Transaction) }
                : item,
          ),
        }
      : {}),
  };
}
