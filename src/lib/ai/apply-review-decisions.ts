import { classify } from "@/lib/calc";
import { canonicalCategory, type Category } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";
import { approveReviewedBooking } from "@/lib/import/approve-review";
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

// Mirrors the review dialog's save path so an AI decision equals a human click.
export function applyAiReviewDecisions(state: AppState, decisions: AiReviewDecision[]): AiApplyResult {
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
      const draft = item.draft;
      const alias = decision.merchantAlias?.trim();
      const naming = alias && !draft.merchantAlias && !draft.merchantId && merchantAliasSourceKey(draft) !== undefined
        ? merchantAliasAssignment(draft, alias) : {};
      const classification = classify({
        ...draft, category, amount: draft.amount ?? 0, categoryOverride: true, manualCategory: true,
        includeInPlan: true, fixedCost: false,
      });
      const canMarkFixed = draft.amount !== null && draft.amount < 0 &&
        !classification.isTransfer && !isIncomeCategory(classification.category);
      const row = transactionSchema.parse({
        ...draft, ...naming, category, categoryOverride: true, manualCategory: true, reviewed: true,
        includeInPlan: true, fixedCost: canMarkFixed && draft.fixedCost === true,
      });
      let metadata: ImportMetadata = {};
      if (item.importUploadId) metadata = { reviewQueue: [{ ...item, draft: row }] };
      if (row.amexSource || isAmexScreenshot(row)) metadata = { ...metadata, amexReconciliation: { rows: [row] } };
      const approval = Object.keys(metadata).length ? undefined : approveReviewedBooking(next, row);
      const result = approval ?? commitStatementImport(next, [row], [], metadata);
      const candidate = approval ? result.state : queueLedgerReview(result.state);
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
  if (!applied.length) return { state, applied, skipped };
  return { state: appStateSchema.parse(refreshPlanning(markAiAssigned(next, marked))), applied, skipped };
}
