import { classify } from "@/lib/calc";
import {
  transactionSchema,
  type AppState,
  type Transaction,
} from "@/lib/types";
import { MerchantIndex } from "./merchants";
import { isAutomationLocked } from "./locks";
import { createAccountMerchantResolver } from "./aliases";
import { isMerchantTransfer } from "@/lib/merchant-transfer";
import { isIncomeCategory } from "@/lib/fixed";
import { ambiguousMerchant } from "@/lib/import/merchant-description";
export { isAutomationLocked } from "./locks";

export function enrichTransaction(
  row: Transaction,
  index: MerchantIndex,
  resolveAccount?: ReturnType<typeof createAccountMerchantResolver>,
): Transaction {
  if (isAutomationLocked(row)) return { ...row, is_locked: true };
  const classified = classify(row);
  if (isMerchantTransfer(row)) return row;
  const refund =
    row.amount > 0 &&
    (!isIncomeCategory(classified.category) ||
      /\b(?:r[üu]ckerstattung|erstattung|refund|retoure|gutschrift)\b/i.test(
        row.description,
      ));
  if (row.amount > 0 && !refund) return row;
  if (ambiguousMerchant(row))
    return { ...row, requires_manual_review: true };
  const learned = resolveAccount?.(row);
  if (learned?.kind === "conflict")
    return { ...row, requires_manual_review: true };
  if (learned?.kind === "matched") {
    const { choice } = learned;
    const identity = choice.merchantAlias
      ? index.match(choice.merchantAlias)
      : undefined;
    const merchant =
      identity && !identity.requiresManualReview && identity.method !== "fuzzy"
        ? identity.merchant
        : undefined;
    return transactionSchema.parse({
      ...row,
      ...(choice.merchantAlias
        ? { merchantAlias: choice.merchantAlias, merchantId: merchant?.id }
        : {}),
      merchantLogo: !!merchant?.logo,
      merchantMatch: "rule",
      category: refund ? "Rückerstattungen" : choice.category,
      categoryOverride: true,
      ...(choice.fixedCost !== undefined &&
      !refund &&
      row.fixedCost === undefined
        ? { fixedCost: choice.fixedCost }
        : {}),
      requires_manual_review: false,
    });
  }
  const match = index.match(row.description);
  if (
    !match.merchant ||
    match.requiresManualReview ||
    match.method === "fuzzy" ||
    match.merchant.defaultCategory === null
  ) {
    return { ...row, requires_manual_review: true };
  }
  // A new index must not replace a previously safe, different identity.
  if (
    row.merchantId &&
    row.requires_manual_review === false &&
    row.merchantId !== match.merchant.id
  )
    return { ...row, requires_manual_review: true };
  // Existing safe assignments and contextual rules (e.g. lunch time) keep precedence.
  const contextual = classify({
    ...row,
    category: "Prüfen",
    categoryOverride: false,
  }).category;
  const category = refund
    ? "Rückerstattungen"
    : row.merchantId === match.merchant.id &&
        row.requires_manual_review === false &&
        row.category !== "Prüfen"
      ? row.category
      : contextual !== "Prüfen"
        ? contextual
        : match.merchant.defaultCategory;
  return transactionSchema.parse({
    ...row,
    merchantId: match.merchant.id,
    merchantAlias: match.merchant.canonicalName,
    merchantLogo: !!match.merchant.logo,
    merchantMatch: match.method === "regex" ? "rule" : "alias",
    category,
    categoryOverride: true,
    requires_manual_review: false,
  });
}

export function backfillBatch(
  state: AppState,
  ids: Set<string>,
  index: MerchantIndex,
): AppState {
  const resolveAccount = createAccountMerchantResolver(state);
  const updated = new Map<string, Transaction>();
  const update = (row: Transaction): Transaction => {
    if (!ids.has(row.id)) return row;
    const next = enrichTransaction(row, index, resolveAccount);
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
    (!isMerchantTransfer(row) && row.category === "Prüfen") ||
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
      merchantLogo: original.merchantLogo,
      merchantMatch: original.merchantMatch,
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
