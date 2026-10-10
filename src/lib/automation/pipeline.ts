import { classify } from "@/lib/calc";
import {
  transactionSchema,
  type AppState,
  type ReviewItem,
  type Transaction,
} from "@/lib/types";
import { MerchantIndex } from "./merchants";
import { isAutomationLocked } from "./locks";
import { createAccountMerchantResolver } from "./aliases";
import {
  hasMerchantRefundEvidence,
  isMerchantTransfer,
} from "@/lib/merchant-transfer";
import { isIncomeCategory } from "@/lib/fixed";
import { knownMerchantCategory } from "@/lib/categories";
import { hasCategoryChoice } from "@/lib/manual-category";
import { merchantEvidence, qualifiedCompany } from "./evidence";
import {
  bankOperation,
  bankOperationReviewMessage,
  bankTransferPurpose,
} from "@/lib/bank-operation";
export { isAutomationLocked } from "./locks";

export function enrichTransaction(
  row: Transaction,
  index: MerchantIndex,
  resolveAccount?: ReturnType<typeof createAccountMerchantResolver>,
): Transaction {
  if (isAutomationLocked(row)) return { ...row, is_locked: true };
  const operation = bankOperation(row);
  const classified = classify(row);
  if (operation?.kind === "ambiguous")
    return { ...row, requires_manual_review: true };
  if (operation?.kind === "internal-transfer")
    return transactionSchema.parse({
      ...row,
      category: operation.category,
      includeInPlan: false,
      fixedCost: false,
      merchantId: undefined,
      merchantAlias: undefined,
      merchantMatch: undefined,
      merchantLogo: false,
      requires_manual_review: false,
    });
  if (operation?.kind === "external-transfer") {
    if (
      classified.isTransfer ||
      (row.amount > 0 && isIncomeCategory(classified.category))
    )
      return row;
    const learned = resolveAccount?.(row);
    const choice =
      learned?.kind === "matched" &&
      !learned.normalized &&
      !learned.choice.identityOnly &&
      !(row.amount <= 0 && learned.choice.category === "Rückerstattungen")
        ? learned.choice
        : undefined;
    const category = choice?.category ?? bankTransferPurpose(row) ?? "Prüfen";
    return transactionSchema.parse({
      ...row,
      category,
      ...(category !== "Prüfen" ? { categoryOverride: true } : {}),
      ...(choice ? { fixedCost: choice.fixedCost ?? row.fixedCost } : {}),
      merchantId: undefined,
      merchantAlias: undefined,
      merchantMatch: undefined,
      merchantLogo: false,
      requires_manual_review: category === "Prüfen",
    });
  }
  if (isMerchantTransfer(row)) return row;
  const refund =
    row.amount > 0 &&
    (!isIncomeCategory(classified.category) || hasMerchantRefundEvidence(row));
  if (row.amount > 0 && !refund) return row;
  const evidence = merchantEvidence(row, index);
  if (evidence.kind === "conflict")
    return { ...row, requires_manual_review: true };
  const sourceText = [
    evidence.text,
    row.description,
    row.rawDescription,
    row.sourceCategory,
    ...(row.rawDetails ?? []),
  ].join(" ");
  const known = knownMerchantCategory(
    operation?.kind === "fee"
      ? sourceText.replace(/\batm[-\s]*fee\b/gi, "")
      : sourceText,
    row.amount,
  );
  const learned = resolveAccount?.(row);
  if (learned?.kind === "conflict")
    return { ...row, requires_manual_review: true };
  if (learned?.kind === "matched" && !learned.choice.identityOnly) {
    const { choice } = learned;
    if (!refund && choice.category === "Rückerstattungen")
      return { ...row, requires_manual_review: true };
    if (learned.normalized && known === "Prüfen")
      return { ...row, requires_manual_review: true };
    const identity = index.match(choice.merchantAlias ?? evidence.text);
    const merchant =
      identity.merchant &&
      identity.method !== "fuzzy" &&
      !qualifiedCompany(
        choice.merchantAlias ?? evidence.text,
        identity.merchant.canonicalName,
      )
        ? identity.merchant
        : undefined;
    if (
      learned.normalized &&
      !refund &&
      classified.category !== choice.category &&
      ((merchant?.defaultCategory &&
        merchant.defaultCategory !== choice.category) ||
        [
          "Mittagessen",
          "Urlaub",
          "Geschenke & Spenden",
          "Rückerstattungen",
        ].includes(choice.category))
    )
      return { ...row, requires_manual_review: true };
    return transactionSchema.parse({
      ...row,
      ...(choice.merchantAlias || merchant
        ? {
            merchantAlias: choice.merchantAlias ?? merchant?.canonicalName,
            merchantId: merchant?.id,
          }
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
      requires_manual_review: !(
        choice.merchantAlias ||
        merchant ||
        operation?.kind === "fee"
      ),
    });
  }
  if (operation?.kind === "fee") {
    const identity = index.match(evidence.text);
    if (
      known === "Prüfen" ||
      identity.method !== "none" ||
      (learned?.kind === "matched" && learned.choice.identityOnly)
    )
      return { ...row, requires_manual_review: true };
    return transactionSchema.parse({
      ...row,
      category: operation.category,
      categoryOverride: true,
      merchantId: undefined,
      merchantAlias: undefined,
      merchantMatch: undefined,
      merchantLogo: false,
      requires_manual_review: false,
    });
  }
  const confirmedName =
    learned?.kind === "matched" && learned.choice.identityOnly
      ? learned.choice.merchantAlias
      : undefined;
  const original = row;
  if (confirmedName)
    row = {
      ...row,
      merchantAlias: confirmedName,
      merchantId: undefined,
      merchantLogo: false,
      merchantMatch: "rule",
      merchantNameConfirmed: undefined,
    };
  const matchingText = confirmedName ?? evidence.text;
  const match = index.match(matchingText, original.merchantId);
  if (
    !match.merchant ||
    (match.method !== "exact" && match.method !== "regex")
  ) {
    return { ...row, requires_manual_review: true };
  }
  if (
    known === "Prüfen" ||
    (confirmedName &&
      knownMerchantCategory(`${sourceText} ${confirmedName}`, row.amount) ===
        "Prüfen")
  )
    return { ...row, requires_manual_review: true };
  // A new index must not replace a previously safe, different identity.
  if (
    original.merchantId &&
    original.requires_manual_review === false &&
    original.merchantId !== match.merchant.id
  )
    return { ...original, requires_manual_review: true };
  // Existing safe assignments and contextual rules (e.g. lunch time) keep precedence.
  const contextual = classify({
    ...row,
    description: matchingText,
    category: "Prüfen",
    categoryOverride: false,
  }).category;
  const defaultCategory = match.merchant.defaultCategory;
  const canonicalName = match.merchant.canonicalName;
  const broadCompatible =
    defaultCategory !== null &&
    ((contextual === "Mobilität" &&
      ["Tanken", "Öffentliche Verkehrsmittel", "Parken & Maut"].includes(
        defaultCategory,
      )) ||
      (contextual === "Wohnen & Haushalt" &&
        ["Möbel & Einrichtung", "Miete", "Energie & Nebenkosten"].includes(
          defaultCategory,
        )));
  const specialContext =
    contextual === "Mittagessen" || contextual === "Urlaub";
  if (
    [
      matchingText,
      evidence.text,
      row.description,
      row.rawDescription ?? "",
    ].some((text) => qualifiedCompany(text, canonicalName))
  )
    return { ...row, requires_manual_review: true };
  const mccValues = (row.rawDetails ?? []).flatMap((detail) => {
    const field = /^(?:mcc|merchant\s*category\s*code)\s*[:=]?\s*(.*)$/i.exec(
      detail.trim(),
    );
    return field ? [field[1].trim()] : [];
  });
  const fuelEvidence =
    mccValues.length > 0 && mccValues.every((code) => code === "5542");
  if (
    !refund &&
    (match.merchant.defaultCategory === null ||
      (match.merchant.requiresCategoryEvidence &&
        !(match.merchant.defaultCategory === "Tanken" && fuelEvidence)))
  )
    return transactionSchema.parse({
      ...row,
      merchantId: match.merchant.id,
      merchantAlias: confirmedName ?? match.merchant.canonicalName,
      merchantLogo: !!match.merchant.logo,
      merchantMatch:
        confirmedName || match.method === "regex" ? "rule" : "alias",
      requires_manual_review: true,
    });
  if (
    !refund &&
    contextual !== "Prüfen" &&
    contextual !== match.merchant.defaultCategory &&
    !broadCompatible &&
    !specialContext
  )
    return { ...row, requires_manual_review: true };
  const category = refund
    ? "Rückerstattungen"
    : row.merchantId === match.merchant.id &&
        row.requires_manual_review === false &&
        row.category !== "Prüfen"
      ? row.category
      : specialContext
        ? contextual
        : match.merchant.defaultCategory;
  return transactionSchema.parse({
    ...row,
    merchantId: match.merchant.id,
    merchantAlias: confirmedName ?? match.merchant.canonicalName,
    merchantLogo: !!match.merchant.logo,
    merchantMatch: confirmedName || match.method === "regex" ? "rule" : "alias",
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
    return {
      ...item,
      booking,
      category: isAutomationLocked(item.booking)
        ? item.category
        : booking.category,
    };
  });
  const needsReview = (row: Transaction) =>
    (!isMerchantTransfer(row) && row.category === "Prüfen") ||
    (row.requires_manual_review === true && !isAutomationLocked(row)) ||
    (row.merchantNameConfirmed === true &&
      !hasCategoryChoice(row) &&
      row.amount < 0 &&
      !isMerchantTransfer(row) &&
      !isIncomeCategory(row.category));
  const queue = (state.reviewQueue ?? []).flatMap<ReviewItem>((item) => {
    if (item.kind === "fixed")
      return [
        {
          ...item,
          change: {
            ...item.change,
            bookings: item.change.bookings.map((row) =>
              ids.has(row.id) && !isAutomationLocked(row)
                ? enrichTransaction(row, index, resolveAccount)
                : row,
            ),
          },
        },
      ];
    if (!ids.has(item.draft.id)) return [item];
    if (isAutomationLocked(item.draft)) return [item];
    const row = updated.get(item.draft.id);
    if (!row) {
      const draft = item.draft;
      if (
        isAutomationLocked(draft) ||
        draft.amount === null ||
        draft.amount === 0 ||
        !draft.date ||
        !draft.description
      )
        return [item];
      // Pending imports gain suggestions, never acceptance or fabricated facts.
      return [
        {
          ...item,
          draft: {
            ...enrichTransaction(
              transactionSchema.parse(draft),
              index,
              resolveAccount,
            ),
            requires_manual_review: true,
          },
        },
      ];
    }
    if (isAutomationLocked(row) && needsReview(row))
      return [{ ...item, draft: row }];
    return needsReview(row)
      ? [
          {
            ...item,
            draft: row,
            message:
              bankOperationReviewMessage(row) ??
              "Händlerzuordnung unsicher – bitte prüfen.",
          },
        ]
      : [];
  });
  const queued = new Set(
    queue.flatMap((item) =>
      item.kind === "booking"
        ? [item.draft.id]
        : item.change.bookings.map((row) => row.id),
    ),
  );
  for (const row of updated.values()) {
    if (!needsReview(row) || queued.has(row.id)) continue;
    queue.push({
      kind: "booking",
      id: row.id,
      draft: row,
      message:
        bankOperationReviewMessage(row) ??
        "Händlerzuordnung unsicher – bitte prüfen.",
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
  const receiptCategories = new Map(
    (previous.fixedReceipts ?? []).flatMap((item) =>
      item.booking && locked.has(item.booking.id)
        ? [
            [
              JSON.stringify([item.key, item.booking.id]),
              item.category,
            ] as const,
          ]
        : [],
    ),
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
      merchantNameConfirmed: original.merchantNameConfirmed,
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
                    receiptCategories.get(
                      JSON.stringify([item.key, item.booking.id]),
                    ) ??
                    locked.get(item.booking.id)?.category ??
                    item.category,
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
