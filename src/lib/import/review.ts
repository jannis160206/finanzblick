import {
  classify,
  actualBookings,
  accountHolidayRanges,
  classifyStatementRows,
  bookingMonth,
  monthKey,
  monthsForYear,
  round,
} from "@/lib/calc";
import {
  fixedCategories,
  durableCategories,
  transactionSchema,
  type AppState,
  type FinanceRow,
  type FixedReceipt,
  type PocketSnapshot,
  type Transaction,
  type FixedChange,
  type ReviewItem,
} from "@/lib/types";
export type { FixedChange, ReviewItem } from "@/lib/types";
import { isAmexScreenshot, legacyFingerprint, numberStatementRows } from "./identity";
import {
  matchingFixedRow as matchingGridRow,
  isIncomeCategory as isIncome,
} from "@/lib/fixed";
import {
  applyMerchantRules,
  createMerchantRuleApplier,
  merchantAliasSourceKey,
  merchantRuleKey,
  isSpecificMerchantKey,
  rememberMerchants,
  storedMerchantKey,
  applyMerchantNameRules,
  rememberMerchantRename,
} from "./merchant-rules";
import { recoverMerchant, sameTerminalBooking, unresolvedTerminal } from "./merchant-description";
import { payrollCategory } from "@/lib/payroll";
import { canonicalCategory, groupedContractCategories } from "@/lib/categories";
import { statementTime } from "@/lib/holidays-at-kaernten";
import { alwaysLunch, isSharedHoliday, reconcileSharedHoliday, type AccountedTransaction } from "@/lib/shared-holiday";
import { hasCategoryChoice, hasManualCategory } from "@/lib/manual-category";
import { bankOperationReviewMessage } from "@/lib/bank-operation";
import { applyNamedTransfer, isNamedTransfer } from "@/lib/transfers";
import { confirmedScreenshotDateMatcher, legacyScreenshotIssues, reconcileScreenshotReviews } from "./screenshot-review";
import { reconcileAmexImports, screenshotPendingBalance, type AmexReconciliation } from "./amex-reconciliation";
import { groupedScreenshotIssueKey, resolveGroupedScreenshotIssues } from "./amex-screenshot-reconciliation";
import {
  appendStatementRows,
  admitStatementRepairDrafts,
  deduplicateStatements,
  statementFingerprint,
} from "./statements";
import {
  completeImportResults,
  reconcileImportResultReviews,
  retainImportResults,
  reviewUploadId,
  type ImportSource,
  type UploadedStatementResult,
} from "./results";

export type ImportMetadata = {
  pocketSnapshots?: PocketSnapshot[];
  fixedReceipts?: FixedReceipt[];
  accountSnapshots?: AppState["accountSnapshots"];
  amexBalanceSnapshots?: AppState["amexBalanceSnapshots"];
  reviewQueue?: ReviewItem[];
  issues?: string[];
  reparsedFiles?: string[];
  merchantRepairs?: Transaction[];
  screenshotRepairs?: Transaction[];
  amexReconciliation?: AmexReconciliation;
  resolvedAmexScreenshotIssues?: string[];
  amexPendingRows?: { date: string; rows: Transaction[] };
  imports?: ImportSource[];
};
export type FixedDecision = { change: FixedChange; accept: boolean };

function fixedReviewSubset(item: Extract<ReviewItem, { kind: "fixed" }>, bookings: Transaction[]): ReviewItem {
  return { ...item, change: { ...item.change, bookings },
    ...(item.importUploadIds ? { importUploadIds: Object.fromEntries(bookings.flatMap((row) => {
      const uploadId = reviewUploadId(item, row.id);
      return uploadId ? [[row.id, uploadId]] : [];
    })) } : {}),
  };
}

function settlementPatch(row?: Transaction) {
  if (!row || (row.sharedRefundFor === undefined && row.sharedRefundUnlinked === undefined &&
    row.sharedRepaymentFor === undefined && row.sharedPaidAmount === undefined)) return {};
  return {
    sharedRefundFor: row.sharedRefundFor,
    sharedRefundUnlinked: row.sharedRefundUnlinked,
    sharedRepaymentFor: row.sharedRepaymentFor,
    sharedPaidAmount: row.sharedPaidAmount,
  };
}

function indexReviewRules(state: AppState) {
  const index = new Map<string, Set<string>>();
  for (const rule of state.merchantRules ?? []) {
    if (rule.identityOnly) continue;
    const key = storedMerchantKey(rule.key);
    if (!isSpecificMerchantKey(key)) continue;
    const categories = index.get(key) ?? new Set<string>();
    categories.add(rule.category);
    index.set(key, categories);
  }
  return index;
}

export function bookingReviewReason(state: AppState, row: AccountedTransaction, ruleIndex = indexReviewRules(state)): string | undefined {
  if (isAmexScreenshot(row) && !transactionSchema.safeParse(row).success)
    return "Buchungsdaten unvollständig – bitte Datum, Händler und Betrag prüfen.";
  if (isAmexScreenshot(row) && row.rawDetails?.includes("OCR-Händler unklar") &&
    !(row.reviewed && (hasManualCategory(row) || row.categoryOverride)))
    return "Amex-Screenshot: Händlertext unsicher erkannt – bitte mit dem Bild abgleichen.";
  const result = classify(row);
  if (isNamedTransfer(row)) return;
  if (hasManualCategory(row) && result.category !== "Prüfen") return;
  if (row.reviewed && row.categoryOverride && result.category !== "Prüfen") return;
  if (row.merchantNameConfirmed && row.amount < 0 && !result.isTransfer && !isIncome(result.category))
    return "Händlername bestätigt – Kategorie bitte noch bestätigen.";
  if (row.requires_manual_review && !row.is_locked)
    return bankOperationReviewMessage(row) ?? "Händlerzuordnung unsicher – bitte prüfen.";
  if (!row.merchantAlias && unresolvedTerminal(row.description)) return "POS-Händler fehlt: Auszug mit Verwendungszweck erneut ablegen.";
  if (result.category === "Prüfen") return "Kategorie noch offen oder widersprüchlich.";
  if (alwaysLunch(row.description) || isSharedHoliday(row) || row.holidayReimbursementFor || row.holidayRange) return;
  if (payrollCategory(row) === result.category) return;
  const categories = ruleIndex.get(merchantRuleKey(row));
  if (categories && (categories.size > 1 || !categories.has(result.category)))
    return "Widersprüchliche Händlerregel: Zuordnung prüfen.";
  if (row.categoryOverride || result.isTransfer) return;
  if (row.merchantId && row.requires_manual_review === false) return;
  if (classify({ ...row, category: "Prüfen", sourceCategory: undefined }).category === "Prüfen")
    return "Händler noch nicht sicher zugeordnet.";
}

export function openReviewCount(items: ReviewItem[]): number {
  return items.reduce((total, item) => total + (item.kind === "fixed" ? item.change.bookings.length : 1), 0);
}

export function repairMerchantBookings(state: AppState, candidates: Transaction[] = []): AppState {
  state = applyMerchantNameRules(state);
  if (state.merchantRules) state = { ...state, merchantRules: state.merchantRules.map((rule) =>
    !rule.identityOnly && isNamedTransfer({ description: rule.key.slice(rule.key.indexOf("|") + 1), merchantAlias: rule.merchantAlias })
      ? { ...rule, category: "Transfer", ...(rule.fixedCost !== undefined ? { fixedCost: false } : {}) } : rule) };
  const recovered = candidates.map(recoverMerchant).filter((row) => row.rawDescription && !unresolvedTerminal(row.description));
  // Rule inference, rule application and repair inspect the same immutable rows.
  // Share results only for this pass; the next edit always gets a fresh cache.
  const classifications = new WeakMap<Transaction, ReturnType<typeof classify>>();
  const classifyBooking = (row: Transaction) => {
    let result = classifications.get(row);
    if (!result) {
      result = classify(row);
      classifications.set(row, result);
    }
    return result;
  };
  let applyRule: ReturnType<typeof createMerchantRuleApplier> | undefined;
  const repair = (row: Transaction): Transaction => {
    if (row.is_locked || row.merchantNameConfirmed) return row;
    let updated = recoverMerchant(row);
    if (unresolvedTerminal(updated.description)) {
      const matches = recovered.filter((candidate) => sameTerminalBooking(row, candidate));
      if (new Set(matches.map((candidate) => candidate.description)).size === 1) {
        const match = matches[0];
        updated = { ...row, description: match.description, rawDescription: row.rawDescription ?? row.description,
          rawDetails: match.rawDetails ?? row.rawDetails, bankReference: row.bankReference ?? match.bankReference };
      }
    }
    const time = statementTime(updated.time, updated.rawDescription, updated.description, ...(updated.rawDetails ?? []));
    if (time && time !== updated.time) updated = { ...updated, time };
    if (updated.category === "Prüfen" && !updated.categoryOverride && !updated.includeInPlan)
      updated = { ...updated, includeInPlan: true };
    applyRule ??= createMerchantRuleApplier(state, classifyBooking);
    const learned = applyNamedTransfer(applyRule(updated));
    const result = classifyBooking(learned);
    return learned.category === result.category && learned.includeInPlan === result.includeInPlan ? learned
      : { ...learned, category: result.category, includeInPlan: result.includeInPlan };
  };
  return { ...state,
    transactions: state.transactions.map(repair),
    ...(state.reviewQueue ? { reviewQueue: state.reviewQueue.flatMap((item): ReviewItem[] => {
      if (item.kind === "booking")
        return item.sourceRepair ? [item] : [{ ...item, draft: item.draft.amount === null ? applyNamedTransfer(recoverMerchant(item.draft)) : repair(item.draft as Transaction) }];
      const transfers = item.change.bookings.filter(isNamedTransfer);
      const bookings = item.change.bookings.filter((row) => !isNamedTransfer(row));
      return [
        ...(bookings.length ? [fixedReviewSubset(item, bookings)] : []),
        ...transfers.map((row): ReviewItem => ({ kind: "booking", id: row.id, draft: applyNamedTransfer(row),
          message: "Transfer erkannt", ...(reviewUploadId(item, row.id) ? { importUploadId: reviewUploadId(item, row.id) } : {}) })),
      ];
    }) } : {}),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) => {
      if (!item.booking) return item;
      const booking = repair(item.booking);
      if (isNamedTransfer(booking))
        return { ...item, booking, category: booking.category, rowId: undefined, merchantKey: merchantRuleKey(booking) };
      return booking === item.booking ? item : { ...item, booking, category: booking.category, merchantKey: merchantRuleKey(booking) };
    }) } : {}),
  };
}

function repairPayrollBookings(state: AppState): AppState {
  const repair = (row: Transaction): Transaction => {
    if (row.is_locked) return row;
    const payroll = payrollCategory(row);
    if (!payroll || classify(row).category !== payroll || row.category === payroll) return row;
    return { ...row, category: payroll, includeInPlan: false };
  };
  return { ...state,
    transactions: state.transactions.map(repair),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) => {
      if (!item.booking) return item;
      const booking = repair(item.booking);
      const category = classify(booking).category;
      if (!payrollCategory(booking) || category !== payrollCategory(booking)) return item;
      return { ...item, booking, category, rowId: matchingGridRow(state, category)?.id };
    }) } : {}),
    ...(state.reviewQueue ? { reviewQueue: state.reviewQueue.flatMap((item): ReviewItem[] => {
      if (item.kind === "fixed" && ["Gehalt", "Rufbereitschaft"].includes(item.change.category))
        return item.change.bookings.map((row) => ({ kind: "booking", id: row.id, draft: repair(row),
          message: "Einkommenszuordnung prüfen.", ...(reviewUploadId(item, row.id) ? { importUploadId: reviewUploadId(item, row.id) } : {}) }));
      if (item.kind === "booking" && !item.sourceRepair && item.draft.amount !== null)
        return [{ ...item, draft: repair(item.draft as Transaction) }];
      return [item];
    }) } : {}),
  };
}

export function queueLedgerReview(state: AppState): AppState {
  const beforeReview = state;
  if (state.reviewQueue) state = { ...state,
    reviewQueue: reconcileScreenshotReviews(state.reviewQueue, actualBookings(state)) };
  state = repairPayrollBookings(repairMerchantBookings(state));
  const rules = indexReviewRules(state);
  const pending = (state.reviewQueue ?? []).flatMap((item) =>
    item.kind === "booking" && !item.sourceRepair && transactionSchema.safeParse(item.draft).success ? [item.draft as Transaction] : []);
  let ledger = actualBookings(state);
  if (pending.length) {
    const accounted = accountHolidayRanges(reconcileSharedHoliday([...ledger, ...pending], state.settings.asOf, state.plannedOneOffs).bookings, state.holidayRanges, state.settings.asOf);
    const safePending = accounted.slice(accounted.length - pending.length).filter((row) =>
      !bookingReviewReason(state, row, rules));
    if (safePending.length) {
      state = appendStatementRows(state, safePending.map((row) => {
        if (row.holidayReimbursementFor || row.holidayRange) return row;
        const result = classify(row);
        return { ...row, category: result.category, includeInPlan: result.includeInPlan };
      })).state;
      ledger = actualBookings(state);
    }
  }
  const byId = new Map(ledger.map((row) => [row.id, row]));
  const keys = new Set(ledger.map(statementFingerprint));
  const reviewed = ledger.filter((row) => row.reviewed && row.categoryOverride && !bookingReviewReason(state, row, rules));
  const reviewedIds = new Set(reviewed.map((row) => row.id));
  for (const receipt of state.fixedReceipts ?? [])
    if (reviewedIds.has(receipt.key) && receipt.booking) reviewedIds.add(receipt.booking.id);
  const queue = (state.reviewQueue ?? []).flatMap((item): ReviewItem[] => {
    if (item.kind === "fixed") {
      const bookings = item.change.bookings.filter((row) =>
        !reviewedIds.has(row.id) && !reviewedIds.has(statementFingerprint(row)));
      return bookings.length ? [fixedReviewSubset(item, bookings)] : [];
    }
    return item.sourceRepair || (!byId.has(item.draft.id) && (item.draft.amount === null || !keys.has(statementFingerprint(item.draft as Transaction)))) ? [item] : [];
  });
  const linkedIssues = new Map((state.reviewQueue ?? []).flatMap((item) =>
    item.kind === "booking" && item.importIssues ? [[item.draft.id, item.importIssues] as const] : [],
  ));
  const linkedUploads = new Map((state.reviewQueue ?? []).flatMap((item) =>
    (item.kind === "booking" ? [item.draft] : item.change.bookings).flatMap((row) => {
      const uploadId = reviewUploadId(item, row.id);
      return uploadId ? [[row.id, uploadId] as const] : [];
    })));
  for (const draft of ledger) {
    const message = bookingReviewReason(state, draft, rules);
    if (!message) continue;
    const importIssues = linkedIssues.get(draft.id);
    const importUploadId = linkedUploads.get(draft.id);
    queue.push({ kind: "booking", id: draft.id, draft, message, ...(importIssues ? { importIssues } : {}),
      ...(importUploadId ? { importUploadId } : {}) });
  }
  const updated = { ...state, reviewQueue: queue };
  return beforeReview.importResults
    ? { ...updated, importResults: retainImportResults(reconcileImportResultReviews(beforeReview, updated)) }
    : updated;
}

function receipt(row: Transaction, rowId?: string): FixedReceipt {
  return {
    key: statementFingerprint(row),
    merchantKey: merchantRuleKey(row),
    date: row.date,
    category: row.category,
    amount: row.amount,
    booking: row,
    ...(rowId ? { rowId } : {}),
  };
}
function mergeMetadata(state: AppState, metadata: ImportMetadata): AppState {
  const amexBalances = new Map((state.amexBalanceSnapshots ?? []).map((item) =>
    [`${item.periodStart}|${item.date}`, item]));
  for (const item of metadata.amexBalanceSnapshots ?? []) amexBalances.set(`${item.periodStart}|${item.date}`, item);
  const snapshots = new Map(
    (state.pocketSnapshots ?? []).map((item) => [
      `${item.pocket}|${item.date}`,
      item,
    ]),
  );
  for (const item of metadata.pocketSnapshots ?? [])
    snapshots.set(`${item.pocket}|${item.date}`, item);
  const receipts = new Map(
    (state.fixedReceipts ?? []).map((item) => [item.key, item]),
  );
  for (const item of metadata.fixedReceipts ?? []) {
    const legacyKey = item.booking ? legacyFingerprint(item.booking) : item.key;
    const existing = receipts.get(item.key) ?? receipts.get(legacyKey);
    if (legacyKey !== item.key) receipts.delete(legacyKey);
    receipts.set(
      item.key,
      existing
        ? {
            ...item,
            ...existing,
            key: item.key,
            booking: existing.booking ?? item.booking,
          }
        : item,
    );
  }
  const accounts = new Map(
    (state.accountSnapshots ?? []).map((item) => [
      `${item.name}|${item.date}`,
      item,
    ]),
  );
  for (const item of metadata.accountSnapshots ?? [])
    accounts.set(`${item.name}|${item.date}`, item);
  return {
    ...state,
    ...(amexBalances.size ? { amexBalanceSnapshots: [...amexBalances.values()] } : {}),
    ...(accounts.size ? { accountSnapshots: [...accounts.values()] } : {}),
    ...(snapshots.size
      ? {
          pocketSnapshots: [...snapshots.values()].sort(
            (a, b) =>
              a.date.localeCompare(b.date) || a.pocket.localeCompare(b.pocket),
          ),
        }
      : {}),
    ...(receipts.size ? { fixedReceipts: [...receipts.values()] } : {}),
  };
}

export function splitFixedBookings(state: AppState, candidates: Transaction[]) {
  // Editing an existing ledger assignment does not import any new bookings.
  if (!candidates.length) return { rows: [], receipts: [], changes: [], duplicates: 0 };
  // An explicit legacy choice still identifies its original contract. Preserve
  // that intent before classification collapses it into a broader category.
  const legacyChoices = new Map(candidates.filter((row) => row.categoryOverride &&
    canonicalCategory(row.category) !== row.category).map((row) => [row.id, row.category]));
  // A provider and matching amount alone do not identify an Apple Care contract.
  const gridFor = (row: Transaction) => matchingGridRow(state,
    legacyChoices.get(row.id) ?? row.category, row, merchantRuleKey(row));
  const ignored = new Set([
    ...(state.ignoredStatementKeys ?? []),
    ...(state.fixedReceipts ?? []).map((item) => item.key),
  ]);
  const classified = classifyStatementRows(
    applyMerchantRules(state, candidates),
    state.transactions,
  );
  const existing = actualBookings(state);
  const accounted = reconcileSharedHoliday([...existing, ...classified], state.settings.asOf, state.plannedOneOffs).bookings.slice(existing.length);
  const hasScreenshot = candidates.some(isAmexScreenshot);
  const screenshotReceipts = (state.fixedReceipts ?? []).flatMap((item) =>
    item.booking && (isAmexScreenshot(item.booking) || (hasScreenshot && /^(?:amex|american express)$/i.test(item.booking.bank))) ? [item.booking] : []);
  const deduped = deduplicateStatements(accounted, [...state.transactions, ...screenshotReceipts]);
  const rows: Transaction[] = [];
  const receipts: FixedReceipt[] = [];
  const changes = new Map<string, FixedChange>();
  let duplicates = deduped.duplicates;
  const monthly = new Map<string, Transaction>();
  const scope = (row: Transaction) => {
    const category = canonicalCategory(row.category);
    return groupedContractCategories.includes(category)
      ? `${category}|${gridFor(row)?.id ?? merchantRuleKey(row)}`
      : category;
  };
  for (const row of state.transactions)
    if (row.fixedCost === undefined || isIncome(classify(row).category))
      monthly.set(`${bookingMonth(row)}|${scope({ ...row, category: classify(row).category })}`, row);
  for (const row of deduped.rows) {
    const category = row.category;
    const classification = classify(row);
    const isFixed =
      classification.isFixedCost ||
      (!classification.isTransfer && isIncome(category) && row.amount > 0);
    if (
      ignored.has(statementFingerprint(row)) ||
      ignored.has(legacyFingerprint(row))
    ) {
      const grid = isFixed ? gridFor(row) : undefined;
      if (isFixed && (row.fixedCost !== true || isIncome(category) || grid))
        receipts.push(receipt(row, grid?.id));
      duplicates++;
      continue;
    }
    if (!isFixed) {
      rows.push(row);
      continue;
    }
    // A booking marker is not a recurring contract or a price-change decision.
    if (row.fixedCost !== undefined && !isIncome(category)) {
      rows.push(row);
      const grid = gridFor(row);
      if (classification.isFixedCost && grid) receipts.push(receipt(row, grid.id));
      continue;
    }
    const month = bookingMonth(row);
    const key = `${month}|${scope(row)}`;
    const grid = gridFor(row);
    const booked = monthly.get(key);
    const previous =
      grid?.values[month] ?? (booked ? Math.abs(booked.amount) : null);
    if (previous === null) {
      rows.push(row);
      receipts.push(receipt(row, grid?.id));
      monthly.set(key, row);
      continue;
    }
    const amount = Math.abs(row.amount);
    const remembered = [...(state.fixedAmountDecisions ?? [])]
      .reverse()
      .find(
        (item) =>
          canonicalCategory(item.category) === category &&
          item.merchantKey === merchantRuleKey(row) &&
          item.month <= month,
      );
    if (remembered?.amount === amount) {
      receipts.push(receipt(row, grid?.id));
      duplicates++;
      continue;
    }
    if (Math.abs(round(amount - previous)) <= 0.05) {
      receipts.push(receipt(row, grid?.id));
      duplicates++;
      continue;
    }
    if (!durableCategories.includes(category)) {
      rows.push(row);
      receipts.push(receipt(row, grid?.id));
      continue;
    }
    const id = `${key}|${amount.toFixed(2)}`;
    const change = changes.get(id) ?? {
      id,
      category,
      month,
      previous,
      amount,
      rowId: grid?.id,
      bookings: [],
    };
    change.bookings.push(row);
    changes.set(id, change);
  }
  return {
    rows,
    receipts,
    changes: [...changes.values()].sort((a, b) =>
      a.month.localeCompare(b.month),
    ),
    duplicates,
  };
}

export function prepareStatementImport(
  results: UploadedStatementResult[],
  state: AppState,
) {
  results = results.map((result) => ({ ...admitStatementRepairDrafts(result), uploadId: result.uploadId ?? crypto.randomUUID(),
    rows: numberStatementRows(result.rows.map(recoverMerchant)) }));
  const candidates = results.flatMap((result) => result.rows);
  const sources: ImportSource[] = results.map((result) => ({
    uploadId: result.uploadId!, name: result.file, source: result.source,
    rows: result.rows, skipped: result.skipped, issues: [], repairDraftIds: [],
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
  }));
  const sourceByRow = new Map(sources.flatMap((source) =>
    source.rows.map((row) => [row.id, source.uploadId] as const)));
  const grouped = results.filter((result) => result.amexScreenshot?.layout === "grouped");
  const groupedIssues = resolveGroupedScreenshotIssues(results);
  const capture = grouped.map((result) => result.amexScreenshot!).filter((item) => item.balance !== undefined)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
  const previousSnapshot = capture ? [...(state.amexBalanceSnapshots ?? [])].filter((item) => item.date <= capture.capturedAt)
    .sort((a, b) => b.date.localeCompare(a.date))[0] : undefined;
  const currentRows = capture ? deduplicateStatements(grouped.filter((result) =>
    result.amexScreenshot?.capturedAt === capture.capturedAt).flatMap((result) => result.rows), []).rows : [];
  const earliest = currentRows.map((row) => row.date).filter(Boolean).sort()[0];
  const periodStart = capture?.periodStart ??
    (previousSnapshot && (!earliest || previousSnapshot.date >= earliest) ? previousSnapshot.periodStart : earliest);
  const groupedSnapshot = capture && periodStart ? [{
    periodStart, date: capture.capturedAt, balance: capture.balance!,
    ...(capture.balanceIncludesPending ? {} : { pendingBalance: round(currentRows
      .filter((row) => row.amexStatus === "pending")
      .reduce((sum, row) => sum - row.amount, 0)) }),
  }] : [];
  const amexReconciliation: AmexReconciliation = { rows: candidates,
    ...(groupedSnapshot.length && currentRows.length >= 2 && (!previousSnapshot || capture!.capturedAt >= previousSnapshot.date)
      ? { validationDate: capture!.capturedAt } : {}) };
  const reconciled = reconcileAmexImports(state, amexReconciliation);
  state = reconciled.state;
  if (groupedSnapshot.length && !capture!.balanceIncludesPending) {
    groupedSnapshot[0].pendingBalance = screenshotPendingBalance(state, currentRows, reconciled.matchedIds, capture!.capturedAt);
  }
  if (state.reviewQueue) state = { ...state,
    reviewQueue: reconcileScreenshotReviews(state.reviewQueue, [...actualBookings(state), ...candidates]) };
  state = repairPayrollBookings(repairMerchantBookings(state, candidates));
  const split = splitFixedBookings(
    {
      ...state,
      transactions: [
        ...state.transactions,
        ...(state.reviewQueue ?? []).flatMap((item) =>
          item.kind === "fixed"
            ? item.change.bookings
            : transactionSchema.safeParse(item.draft).success
              ? [item.draft as Transaction]
              : [],
        ),
      ],
    },
    reconciled.rows,
  );
  const automatic: Transaction[] = [];
  const review: ReviewItem[] = [...reconciled.review, ...split.changes.map((change): ReviewItem => ({
    kind: "fixed", id: change.id, change,
    importUploadIds: Object.fromEntries(change.bookings.flatMap((row) => {
      const uploadId = sourceByRow.get(row.id);
      return uploadId ? [[row.id, uploadId]] : [];
    })),
  }))];
  const rules = indexReviewRules(state);
  for (const row of split.rows) {
    const message = bookingReviewReason(state, row, rules);
    if (message)
      review.push({
        kind: "booking",
        id: row.id,
        draft: row,
        message,
      });
    else automatic.push(row);
  }
  const screenshotIssueKey = (draft: Extract<ReviewItem, { kind: "booking" }>["draft"]) =>
    JSON.stringify([draft.date, draft.amount, draft.description, draft.rawDetails]);
  const screenshotIssues = new Map(
    (state.reviewQueue ?? []).flatMap((item) => item.kind === "booking" && isAmexScreenshot(item.draft)
      ? [[screenshotIssueKey(item.draft), item] as const] : []),
  );
  const updatedReviews = new Map<string, ReviewItem>();
  const legacyIssues = legacyScreenshotIssues(state.reviewQueue ?? [], state.importStatus?.issues ?? []);
  const confirmedDate = confirmedScreenshotDateMatcher(actualBookings(state));
  const issues: string[] = [];
  for (const [resultIndex, result] of results.entries()) for (const [issueIndex, issue] of result.issues.entries()) {
    if (issue.draft && groupedIssues.ids.has(issue.draft.id)) continue;
    if (issue.draft && isAmexScreenshot(issue.draft) && confirmedDate(issue.draft)) continue;
    const sourceIssue = `${issue.file}${issue.line ? `, Zeile ${issue.line}` : ""}: ${issue.message}`;
    issues.push(sourceIssue);
    const source = sources[resultIndex];
    const structured = {
      id: `${source.uploadId}:${issueIndex}`, ...(issue.line ? { line: issue.line } : {}),
      message: issue.message.slice(0, 2000),
      action: issue.action ?? (issue.draft ? "correct" as const : "reupload" as const),
      ...(issue.reason ? { reason: issue.reason } : {}),
      ...(issue.evidence ? { evidence: issue.evidence } : {}),
    };
    if (!issue.draft) {
      source.issues.push(structured);
      continue;
    }
    if (!isAmexScreenshot(issue.draft)) {
      const id = `${source.uploadId}:${issue.draft.id}`;
      review.push({ kind: "booking", id, draft: { ...issue.draft, id },
        message: issue.message, sourceRepair: true, importUploadId: source.uploadId,
        importIssues: [sourceIssue] });
      source.issues.push({ ...structured, reviewId: id });
      source.repairDraftIds.push(id);
      continue;
    }
    const key = screenshotIssueKey(issue.draft);
    const existing = screenshotIssues.get(key);
    if (existing) {
      const updated = { ...existing, importIssues: [...new Set([
        ...(existing.importIssues ?? []), ...(legacyIssues.get(existing.id) ?? []), sourceIssue,
      ])] };
      screenshotIssues.set(key, updated);
      updatedReviews.set(updated.id, updated);
      source.issues.push({ ...structured, reviewId: updated.id });
      source.repairDraftIds.push(updated.id);
      continue;
    }
    const item: Extract<ReviewItem, { kind: "booking" }> = {
      kind: "booking", id: issue.draft.id, draft: issue.draft, message: issue.message,
      importIssues: [sourceIssue], importUploadId: source.uploadId,
    };
    screenshotIssues.set(key, item);
    review.push(item);
    source.issues.push({ ...structured, reviewId: item.id });
    source.repairDraftIds.push(item.id);
  }
  for (let index = 0; index < review.length; index++) {
    const item = review[index];
    if (item.kind === "fixed") continue;
    const row = item.draft;
    const importUploadId = item.importUploadId ?? (row && sourceByRow.get(row.id));
    if (importUploadId) review[index] = { ...item, importUploadId };
  }
  for (const source of sources) source.issues = source.issues.slice(0, 100);
  return {
    automatic,
    review,
    duplicates: split.duplicates + reconciled.duplicates,
    issues,
    metadata: {
      merchantRepairs: candidates.filter((row) => !!row.rawDescription),
      // Reconciliation still needs evidence when every new row was a duplicate.
      screenshotRepairs: candidates.filter(isAmexScreenshot),
      amexReconciliation,
      resolvedAmexScreenshotIssues: groupedIssues.keys,
      ...(capture && !capture.balanceIncludesPending ? { amexPendingRows: { date: capture.capturedAt, rows: currentRows } } : {}),
      reviewQueue: [...new Map([...review, ...updatedReviews.values()].map((item) => [item.id, item])).values()],
      issues,
      reparsedFiles: [...new Set(results.filter((result) => result.source !== null).map((result) => result.file))],
      accountSnapshots: results.flatMap(
        (result) => result.accountSnapshots ?? [],
      ),
      amexBalanceSnapshots: [...results.flatMap((result) => result.amexBalanceSnapshots ?? []), ...groupedSnapshot],
      pocketSnapshots: results.flatMap(
        (result) => result.pocketSnapshots ?? [],
      ),
      fixedReceipts: split.receipts,
      imports: sources,
    } satisfies ImportMetadata,
  };
}

export function applyFixedDecisions(
  state: AppState,
  decisions: FixedDecision[],
): AppState {
  const ignored = new Set(state.ignoredStatementKeys ?? []);
  let financeRows = state.financeRows;
  const fixedAmountDecisions = [...(state.fixedAmountDecisions ?? [])];
  for (const { change: original, accept } of [...decisions].sort((a, b) =>
    a.change.month.localeCompare(b.change.month),
  )) {
    const bookings = original.bookings.filter((row) => !isNamedTransfer(row));
    if (!bookings.length) continue;
    const change = { ...original, bookings };
    change.bookings.forEach((row) => ignored.add(statementFingerprint(row)));
    for (const booking of change.bookings) {
      const merchantKey = merchantRuleKey(booking);
      if (
        !fixedAmountDecisions.some(
          (item) =>
            item.month === change.month &&
            item.merchantKey === merchantKey &&
            item.category === change.category &&
            item.amount === change.amount &&
            item.accept === accept,
        )
      )
        fixedAmountDecisions.push({
          merchantKey,
          category: change.category,
          amount: change.amount,
          month: change.month,
          accept,
        });
    }
    if (
      !accept ||
      !durableCategories.includes(change.category) ||
      change.bookings.some((row) =>
        /13\.?\s*(?:gehalt|lohn)|bonus|sonderzahlung|rufbereitschaft|urlaub|holiday/i.test(
          row.description,
        ),
      )
    )
      continue;
    const existing =
      financeRows.find((row) => row.id === change.rowId) ??
      matchingGridRow({ ...state, financeRows }, change.category, change.bookings[0]);
    const row: FinanceRow = existing ?? {
      id: crypto.randomUUID(),
      kind: isIncome(change.category) ? "income" : "fixed",
      label: groupedContractCategories.includes(change.category)
        ? change.bookings[0].description.slice(0, 100) : change.category,
      planCategory: change.category,
      values: {},
    };
    const values = { ...row.values };
    for (const month of [...monthsForYear(2026), ...monthsForYear(2027)])
      if (month >= change.month) values[month] = change.amount;
    const updated = { ...row, values };
    financeRows = existing
      ? financeRows.map((item) => (item.id === row.id ? updated : item))
      : [...financeRows, updated];
  }
  return {
    ...state,
    financeRows,
    ...(fixedAmountDecisions.length ? { fixedAmountDecisions } : {}),
    ...(ignored.size ? { ignoredStatementKeys: [...ignored] } : {}),
  };
}

// Recheck against the reducer's latest state, not the state captured before file parsing.
export function commitStatementImport(
  state: AppState,
  rows: Transaction[],
  decisions: FixedDecision[] = [],
  metadata: ImportMetadata = {},
) {
  const beforeImport = state;
  let matchedIds = new Map<string, string>();
  const renames = [...rows, ...decisions.flatMap(({ change }) => change.bookings)]
    .filter((row) => row.merchantNameConfirmed && row.merchantAlias)
    .map((row) => ({
      source: state.transactions.find((item) => item.id === row.id) ??
        state.fixedReceipts?.find((item) => item.booking?.id === row.id)?.booking ??
        state.reviewQueue?.flatMap((item) => item.kind === "booking" ? [item.draft] : item.change.bookings)
          .find((item) => item.id === row.id) ?? { ...row, merchantAlias: undefined },
      merchantAlias: row.merchantAlias!,
    }))
    .filter(({ source, merchantAlias }) => source.merchantAlias !== merchantAlias);
  const previousQueue = state.reviewQueue ?? [];
  if (metadata.resolvedAmexScreenshotIssues?.length && state.reviewQueue) {
    const resolved = new Set(metadata.resolvedAmexScreenshotIssues);
    state = { ...state, reviewQueue: state.reviewQueue.filter((item) => item.kind !== "booking" ||
      item.draft.reviewed || item.draft.manualCategory || item.draft.categoryOverride ||
      item.draft.fixedCost !== undefined || item.draft.merchantAlias ||
      !resolved.has(groupedScreenshotIssueKey(item.draft))) };
  }
  if (metadata.amexReconciliation) {
    const evidence = metadata.amexReconciliation;
    const reconciled = reconcileAmexImports(state, evidence);
    matchedIds = reconciled.matchedIds;
    state = reconciled.state;
    if (metadata.amexPendingRows) {
      const pending = metadata.amexPendingRows;
      const pendingBalance = screenshotPendingBalance(state, pending.rows, reconciled.matchedIds, pending.date);
      metadata = { ...metadata, amexBalanceSnapshots: metadata.amexBalanceSnapshots?.map((snapshot) =>
        snapshot.date === pending.date && snapshot.pendingBalance !== undefined ? { ...snapshot, pendingBalance } : snapshot) };
    }
    const evidenceIds = new Set(evidence.rows.map((row) => row.id));
    const allowedIds = new Set(reconciled.rows.map((row) => row.id));
    rows = rows.flatMap((row) => {
      const matchedId = reconciled.matchedIds.get(row.id);
      if (matchedId && row.reviewed && (row.manualCategory || row.categoryOverride))
        return [{ ...row, id: matchedId }];
      return !evidenceIds.has(row.id) || allowedIds.has(row.id) ? [row] : [];
    });
  }
  rows = [...rows.map(applyNamedTransfer), ...decisions.flatMap(({ change }) =>
    change.bookings.filter(isNamedTransfer).map(applyNamedTransfer))];
  decisions = decisions.flatMap(({ change, accept }) => {
    const bookings = change.bookings.filter((row) => !isNamedTransfer(row));
    return bookings.length ? [{ change: { ...change, bookings }, accept }] : [];
  });
  const screenshotRepairs = [...actualBookings(state), ...(metadata.screenshotRepairs ?? [])];
  if (state.reviewQueue) state = { ...state,
    reviewQueue: reconcileScreenshotReviews(state.reviewQueue, screenshotRepairs) };
  state = repairPayrollBookings(repairMerchantBookings(state, metadata.merchantRepairs));
  const queueMap = new Map(
    (state.reviewQueue ?? []).map((item) => [item.id, item]),
  );
  for (const item of metadata.reviewQueue ?? []) {
    const previous = queueMap.get(item.id);
    const inherited = previous?.importUploadId && !item.importUploadId
      ? { ...item, importUploadId: previous.importUploadId } : item;
    const mergedBookings = inherited.kind === "fixed" && previous?.kind === "fixed"
      ? [...new Map([...inherited.change.bookings, ...previous.change.bookings].map((row) => [row.id, row])).values()]
      : undefined;
    queueMap.set(item.id, inherited.kind === "fixed" && previous?.kind === "fixed"
      ? fixedReviewSubset({ ...inherited, importUploadIds: {
        ...inherited.importUploadIds,
        ...Object.fromEntries(previous.change.bookings.flatMap((row) => {
          const uploadId = reviewUploadId(previous, row.id);
          return uploadId ? [[row.id, uploadId]] : [];
        })),
      } }, mergedBookings!)
      : inherited);
  }
  const queue = reconcileScreenshotReviews([...queueMap.values()], screenshotRepairs);
  const related = queue.flatMap((item) => {
    if (item.kind !== "fixed") return [];
    const decision = decisions.find(
      ({ change }) =>
        change.category === item.change.category &&
        (!change.rowId || !item.change.rowId || change.rowId === item.change.rowId) &&
        change.amount === item.change.amount &&
        change.bookings.some((row) =>
          item.change.bookings.some(
            (other) => merchantRuleKey(row) === merchantRuleKey(other) ||
              (merchantAliasSourceKey(row) !== undefined && merchantAliasSourceKey(row) === merchantAliasSourceKey(other)),
          ),
        ),
    );
    return decision ? [{ change: item.change, accept: decision.accept }] : [];
  });
  decisions = [
    ...new Map(
      [...related, ...decisions].map((item) => [item.change.id, item]),
    ).values(),
  ];
  const settlements = [...rows, ...decisions.flatMap(({ change }) => change.bookings)]
    .filter((row) => Object.keys(settlementPatch(row)).length > 0);
  const settlementById = new Map(settlements.map((row) => [row.id, row]));
  const settlementByKey = new Map(numberStatementRows(settlements).map((row) => [statementFingerprint(row), row]));
  const preserveSettlement = (row: Transaction) => {
    const choice = settlementById.get(row.id) ?? settlementByKey.get(statementFingerprint(row));
    return choice ? { ...row, ...settlementPatch(choice) } : row;
  };
  if (settlements.length) state = { ...state,
    transactions: state.transactions.map(preserveSettlement),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) => item.booking
      ? { ...item, booking: preserveSettlement(item.booking) } : item) } : {}),
  };
  const aliases = new Map(decisions.flatMap(({ change }) => change.bookings.flatMap((row) =>
    row.merchantAlias ? [[statementFingerprint(row), row.merchantAlias] as const] : [])));
  if (aliases.size) {
    const rename = (row: Transaction): Transaction => {
      const merchantAlias = aliases.get(statementFingerprint(row));
      return merchantAlias && merchantAlias !== row.merchantAlias ? { ...row, merchantAlias } : row;
    };
    // A reviewed ledger row or receipt must also receive its explicitly edited name.
    state = { ...state, transactions: state.transactions.map(rename),
      ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) => {
        if (!item.booking) return item;
        const booking = rename(item.booking);
        return booking === item.booking ? item : { ...item, booking, merchantKey: merchantRuleKey(booking) };
      }) } : {}) };
  }
  const choices = new Map(
    rows
      .filter((row) => (row.categoryOverride || hasManualCategory(row)) && row.category !== "Prüfen" && isSpecificMerchantKey(merchantRuleKey(row)))
      .map((row) => [merchantRuleKey(row), row.category]),
  );
  const directChoices = new Map(rows.filter((row) => row.categoryOverride || hasManualCategory(row) || row.fixedCost !== undefined).map((row) => [row.id, row]));
  const fingerprintChoices = new Map(numberStatementRows([...directChoices.values()]).map((row) => [statementFingerprint(row), row]));
  const directChoice = (row: Transaction) => directChoices.get(row.id) ?? fingerprintChoices.get(statementFingerprint(row));
  const selected = new Map(
    numberStatementRows(rows).map((row) => [statementFingerprint(row), row]),
  );
  for (const item of queue) {
    if (item.kind !== "booking" || item.draft.amount === null || !transactionSchema.safeParse(item.draft).success) continue;
    const direct = directChoices.get(item.draft.id);
    if (item.sourceRepair && !direct) continue;
    if (hasCategoryChoice(item.draft) && !direct) continue;
    if (!direct && isAmexScreenshot(item.draft) && item.draft.rawDetails?.includes("OCR-Händler unklar") &&
      !(item.draft.reviewed && (item.draft.manualCategory || item.draft.categoryOverride))) continue;
    const category = direct?.category ?? choices.get(merchantRuleKey(item.draft as Transaction));
    if (category) {
      const row = {
        ...item.draft,
        ...settlementPatch(settlementById.get(item.draft.id)),
        amount: item.draft.amount,
        category,
        categoryOverride: true,
        ...(direct?.manualCategory !== undefined ? { manualCategory: direct.manualCategory } : {}),
        ...(direct?.reviewed !== undefined ? { reviewed: direct.reviewed } : {}),
        ...(direct?.merchantAlias !== undefined ? { merchantAlias: direct.merchantAlias } : {}),
        includeInPlan: true,
        ...(directChoice(item.draft as Transaction)?.fixedCost !== undefined
          ? { fixedCost: directChoice(item.draft as Transaction)!.fixedCost }
          : {}),
      };
      const key = statementFingerprint(row);
      if (!selected.has(key) || direct || !hasManualCategory(selected.get(key)!)) selected.set(key, row);
    }
  }
  rows = [...selected.values()];
  // Queue twins share the category, not the selected booking's future mode.
  const learned = rememberMerchants(state, [
    ...rows.filter(
      (row) => row.amount < 0 || fixedCategories.includes(row.category),
    ).map((row) => ({ ...row, fixedCost: directChoice(row)?.fixedCost })),
    ...decisions.flatMap(({ change }) => change.bookings),
  ]);
  let current = applyFixedDecisions({ ...learned,
    transactions: learned.transactions.map((row) => {
      const choice = directChoice(row);
      const direct = directChoices.get(row.id);
      if (hasCategoryChoice(row) && !direct) return row;
      const category = choice?.category ?? choices.get(merchantRuleKey(row));
      if (!category) return row;
      const updated = { ...row, category, categoryOverride: true, includeInPlan: true,
        ...(direct?.manualCategory !== undefined ? { manualCategory: direct.manualCategory } : {}),
        ...(direct?.reviewed !== undefined ? { reviewed: direct.reviewed } : {}),
        ...(choice?.merchantAlias !== undefined ? { merchantAlias: choice.merchantAlias } : {}),
        ...(choice?.fixedCost !== undefined ? { fixedCost: choice.fixedCost } : {}) };
      const result = classify(updated);
      return { ...updated, category: result.category, includeInPlan: result.includeInPlan };
    }),
  }, decisions);
  const promoted: Transaction[] = [];
  if (current.fixedReceipts?.length) {
    const ledgerKeys = new Set(current.transactions.map(statementFingerprint));
    const fixedReceipts = current.fixedReceipts.flatMap((item): FixedReceipt[] => {
      const choice = directChoices.get(item.key) ?? (item.booking && directChoice(item.booking));
      if (!choice || (choice.fixedCost === undefined && !hasManualCategory(choice)) || !item.booking) return [item];
      const updated = { ...item.booking, id: choice.id, category: choice.category,
        categoryOverride: true, includeInPlan: true,
        ...(choice.fixedCost !== undefined ? { fixedCost: choice.fixedCost } : {}),
        ...(choice.manualCategory !== undefined ? { manualCategory: choice.manualCategory } : {}),
        ...(choice.reviewed !== undefined ? { reviewed: choice.reviewed } : {}),
        ...(choice.merchantAlias !== undefined ? { merchantAlias: choice.merchantAlias } : {}) };
      const result = classify(updated);
      const booking = { ...updated, category: result.category, includeInPlan: result.includeInPlan };
      if (!ledgerKeys.has(statementFingerprint(booking))) {
        promoted.push(booking);
        ledgerKeys.add(statementFingerprint(booking));
      }
      const grid = result.isFixedCost ? matchingGridRow(current, result.category, booking, merchantRuleKey(booking)) : undefined;
      return grid ? [receipt(booking, grid.id)] : isIncome(result.category) ? [{ ...item, booking }] : [];
    });
    current = { ...(promoted.length ? appendStatementRows(current, promoted).state : current), fixedReceipts };
  }
  const ledgerIds = new Set(current.transactions.map((row) => row.id));
  // Existing ledger reviews edit in place; never append a second spend or fixed receipt.
  const split = splitFixedBookings(current, rows.filter((row) => !ledgerIds.has(row.id)));
  const appended = split.rows.length ? appendStatementRows(current, split.rows)
    : { state: current, added: 0, duplicates: 0 };
  for (const row of split.rows) {
    const category = classify(row).category;
    const month = bookingMonth(row);
    const grid = matchingGridRow(appended.state, category, row, merchantRuleKey(row));
    if (
      durableCategories.includes(category) &&
      row.fixedCost === undefined &&
      grid?.values[month] == null &&
      (isIncome(category) ? row.amount > 0 : row.amount < 0)
    ) {
      appended.state = applyFixedDecisions(appended.state, [
        {
          accept: true,
          change: {
            id: `initial-${row.id}`,
            category,
            month,
            previous: 0,
            amount: Math.abs(row.amount),
            rowId: grid?.id,
            bookings: [row],
          },
        },
      ]);
    }
  }
  const resolved = new Set(rows.map(statementFingerprint));
  const resolvedIds = new Set(rows.map((row) => row.id));
  const resolvedChanges = new Set(decisions.map(({ change }) => change.id));
  const pending = queue.flatMap((item): ReviewItem[] => {
    if (item.kind === "fixed") {
      if (resolvedChanges.has(item.id)) return [];
      const bookings = item.change.bookings.filter((row) => !resolvedIds.has(row.id) && !resolved.has(statementFingerprint(row)));
      return bookings.length ? [fixedReviewSubset(item, bookings)] : [];
    }
    return !resolvedIds.has(item.draft.id) && (item.draft.amount === null ||
      !resolved.has(statementFingerprint(item.draft as Transaction))) ? [item] : [];
  });
  const uploadByBooking = new Map(queue.flatMap((item) =>
    (item.kind === "booking" ? [item.draft] : item.change.bookings).flatMap((row) => {
      const uploadId = reviewUploadId(item, row.id);
      return uploadId ? [[row.id, uploadId] as const] : [];
    })));
  for (const change of split.changes)
    if (!pending.some((item) => item.id === change.id))
      pending.push({ kind: "fixed", id: change.id, change,
        importUploadIds: Object.fromEntries(change.bookings.flatMap((row) => {
          const uploadId = uploadByBooking.get(row.id);
          return uploadId ? [[row.id, uploadId]] : [];
        })),
      });
  const merged = mergeMetadata(appended.state, {
    ...metadata,
    fixedReceipts: [
      ...(metadata.fixedReceipts ?? []),
      ...split.receipts,
      ...decisions.flatMap(({ change }) =>
        change.bookings.map((row) => receipt(row, change.rowId)),
      ),
    ].filter((item) => {
      const choice = directChoices.get(item.key) ?? (item.booking && directChoice(item.booking));
      return choice?.fixedCost === undefined || (item.booking?.fixedCost === choice.fixedCost &&
        (choice.fixedCost || isIncome(item.category)));
    }),
  });
  const importedCount = metadata.issues !== undefined || state.importStatus
    ? actualBookings(merged).length - actualBookings(state).length : 0;
  const pendingIssues = new Set(pending.flatMap((item) => item.kind === "booking" ? item.importIssues ?? [] : []));
  const pendingIds = new Set(pending.map((item) => item.id));
  const legacyIssues = legacyScreenshotIssues(previousQueue, state.importStatus?.issues ?? []);
  const resolvedIssues = new Set([...previousQueue, ...(metadata.reviewQueue ?? [])].flatMap((item) =>
    item.kind === "booking" && !pendingIds.has(item.id)
      ? [...(item.importIssues ?? []), ...(legacyIssues.get(item.id) ?? [])].filter((issue) => !pendingIssues.has(issue)) : [],
  ));
  const importResults = retainImportResults([
    ...reconcileImportResultReviews(beforeImport, { ...merged, reviewQueue: pending }),
    ...completeImportResults(beforeImport, { ...merged, reviewQueue: pending }, metadata.imports ?? [], matchedIds),
  ]);
  return {
    ...appended,
    state: renames.reduce<AppState>((current, { source, merchantAlias }) =>
      rememberMerchantRename(current, source, merchantAlias), {
      ...merged,
      ...(importResults.length || beforeImport.importResults ? { importResults } : {}),
      ...(pending.length || state.reviewQueue ? { reviewQueue: pending } : {}),
      ...(metadata.issues !== undefined || state.importStatus
        ? {
            importStatus: {
              imported:
                (state.importStatus?.imported ?? 0) +
                Math.max(0, importedCount),
              issues: [
                ...new Set([
                  ...(state.importStatus?.issues ?? []).filter((issue) =>
                    !resolvedIssues.has(issue),
                  ),
                  ...(metadata.issues ?? []).filter((issue) => !resolvedIssues.has(issue)),
                ]),
              ],
            },
          }
        : {}),
    }),
    duplicates: appended.duplicates + split.duplicates,
    changes: split.changes,
  };
}
