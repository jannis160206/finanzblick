import { classify } from "@/lib/calc";
import { canonicalCategory, type Category } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";
import { isAmexScreenshot } from "@/lib/import/identity";
import { merchantAliasSourceKey } from "@/lib/import/merchant-rules";
import { commitStatementImport, queueLedgerReview, type ImportMetadata } from "@/lib/import/review";
import { merchantAliasAssignment } from "@/lib/merchant-identity";
import { refreshPlanning } from "@/lib/planning";
import { appStateSchema, transactionSchema, type AppState, type Transaction } from "@/lib/types";
import { isAiEligibleReview } from "./review-candidates";

export type AiReviewDecision = { reviewId: string; category: Category; merchantAlias?: string };
export type AiApplyResult = { state: AppState; applied: string[]; skipped: string[] };

function markAiAssigned(state: AppState, ids: ReadonlySet<string>): AppState {
  const mark = (row: Transaction) => ids.has(row.id) && !row.aiAssigned ? { ...row, aiAssigned: true } : row;
  return {
    ...state,
    transactions: state.transactions.map(mark),
    ...(state.fixedReceipts ? {
      fixedReceipts: state.fixedReceipts.map((item) => item.booking ? { ...item, booking: mark(item.booking) } : item),
    } : {}),
  };
}

type ReviewItem = Extract<NonNullable<AppState["reviewQueue"]>[number], { kind: "booking" }>;

function decidedRow(item: ReviewItem, decision: AiReviewDecision, category: Category): Transaction {
  const draft = item.draft;
  const alias = decision.merchantAlias?.trim();
  // The AI names only this booking; a confirmed name would become a global rename rule.
  const naming = alias && !draft.merchantAlias && !draft.merchantId && merchantAliasSourceKey(draft) !== undefined
    ? { ...merchantAliasAssignment(draft, alias), merchantNameConfirmed: undefined } : {};
  const classification = classify({
    ...draft, category, amount: draft.amount ?? 0, categoryOverride: true, manualCategory: true,
    includeInPlan: true, fixedCost: false,
  });
  const canMarkFixed = draft.amount !== null && draft.amount < 0 &&
    !classification.isTransfer && !isIncomeCategory(classification.category);
  return transactionSchema.parse({
    ...draft, ...naming, category, categoryOverride: true, manualCategory: true, reviewed: true,
    includeInPlan: true, fixedCost: canMarkFixed && draft.fixedCost === true, aiAssigned: true,
  });
}

type Progress = { state: AppState; applied: string[]; skipped: string[]; marked: Set<string> };

// Many decisions at once: one import commit instead of one per booking (a full commit takes about a second on a large ledger).
// Returns undefined when any booking would land back in the review list; the careful one-by-one path decides then.
function applyBatch(state: AppState, decisions: AiReviewDecision[]): Progress | undefined {
  const picked: { item: ReviewItem; row: Transaction }[] = [];
  const skipped: string[] = [];
  for (const decision of decisions) {
    const item = state.reviewQueue?.find((entry) => entry.id === decision.reviewId);
    const category = canonicalCategory(decision.category);
    if (!item || !isAiEligibleReview(item) || category === "Prüfen" || picked.some((entry) => entry.item.id === item.id)) {
      skipped.push(decision.reviewId);
      continue;
    }
    try {
      const row = decidedRow(item, decision, category);
      picked.push({ item, row });
    } catch {
      skipped.push(decision.reviewId);
    }
  }
  if (!picked.length) return undefined;
  const queued = picked.filter(({ item }) => item.importUploadId).map(({ item, row }) => ({ ...item, draft: row }));
  try {
    const amex = picked.filter(({ row }) => row.amexSource || isAmexScreenshot(row)).map(({ row }) => row);
    const result = commitStatementImport(state, picked.map(({ row }) => row), [], {
      ...(queued.length ? { reviewQueue: queued } : {}), ...(amex.length ? { amexReconciliation: { rows: amex } } : {}) });
    const next = queueLedgerReview(result.state);
    if (picked.some(({ item }) => next.reviewQueue?.some((entry) => entry.id === item.id))) return undefined;
    return { state: next, applied: picked.map(({ item }) => item.id), skipped, marked: new Set(picked.map(({ row }) => row.id)) };
  } catch {
    return undefined;
  }
}

// Mirrors the review dialog's save path so an AI decision equals a human click.
export function applyAiReviewDecisions(state: AppState, decisions: AiReviewDecision[]): AiApplyResult {
  const result = (decisions.length > 1 ? applyBatch(state, decisions) : undefined) ?? applyEach(state, decisions);
  if (!result.applied.length) return { state, applied: result.applied, skipped: result.skipped };
  return { state: appStateSchema.parse(refreshPlanning(markAiAssigned(result.state, result.marked))), applied: result.applied, skipped: result.skipped };
}

function applyEach(state: AppState, decisions: AiReviewDecision[]): Progress {
  const applied: string[] = [];
  const skipped: string[] = [];
  const marked = new Set<string>();
  let next = state;
  for (const decision of decisions) {
    const item = next.reviewQueue?.find((entry) => entry.id === decision.reviewId);
    const category = canonicalCategory(decision.category);
    if (!item || !isAiEligibleReview(item) || category === "Prüfen") {
      skipped.push(decision.reviewId);
      continue;
    }
    try {
      const row = decidedRow(item, decision, category);
      let metadata: ImportMetadata = {};
      if (item.importUploadId) metadata = { reviewQueue: [{ ...item, draft: row }] };
      if (row.amexSource || isAmexScreenshot(row)) metadata = { ...metadata, amexReconciliation: { rows: [row] } };
      // Not approveReviewedBooking: that shortcut spreads the choice to merchant twins and stores a rule.
      const result = commitStatementImport(next, [row], [], metadata);
      const candidate = queueLedgerReview(result.state);
      if (candidate.reviewQueue?.some((entry) => entry.id === item.id)) {
        skipped.push(decision.reviewId);
        continue;
      }
      next = candidate;
      marked.add(row.id);
      applied.push(decision.reviewId);
    } catch {
      skipped.push(decision.reviewId);
    }
  }
  return { state: next, applied, skipped, marked };
}
