import { classify, round } from "@/lib/calc";
import { canonicalCategory, type Category } from "@/lib/categories";
import { suggestedDraft } from "@/lib/ai/review-groups";
import { isAiEligibleReview } from "@/lib/ai/review-candidates";
import { aiSuggestionFor } from "@/lib/ai/suggestions";
import { approveReviewedBooking } from "@/lib/import/approve-review";
import { commitStatementImport, queueLedgerReview, type ImportMetadata } from "@/lib/import/review";
import { cleanMerchantName, merchantKey } from "@/lib/merchant-display";
import { refreshPlanning } from "@/lib/planning";
import { appStateSchema, transactionSchema, type AppState, type ReviewItem, type Transaction } from "@/lib/types";

type BookingReview = Extract<ReviewItem, { kind: "booking" }>;
export type BulkReviewGroup = { key: string; label: string; category: Category; ids: string[]; count: number; total: number };
export type BulkReviewResult = { state: AppState; applied: string[]; skipped: string[] };

// Same exclusion as the review dialog: reviews that need a source re-upload stay single.
const reuploadOnly = (state: AppState, item: ReviewItem) => (state.importResults ?? []).some((result) =>
  result.issues.some((issue) => issue.reviewId === item.id && issue.action === "reupload"));

function bulkCandidates(state: AppState): BookingReview[] {
  return (state.reviewQueue ?? []).filter((item): item is BookingReview =>
    isAiEligibleReview(item) && !reuploadOnly(state, item));
}

// The category the review dialog pre-fills: AI/rule proposal, else the draft's own or classified category.
function suggestedCategory(state: AppState, item: BookingReview): Category {
  const draft = suggestedDraft(item.draft, aiSuggestionFor(state, item.id));
  if (draft.category !== "Prüfen") return canonicalCategory(draft.category);
  try {
    return classify({ ...draft, amount: draft.amount ?? 0 }).category;
  } catch {
    return "Prüfen";
  }
}

/** Open booking reviews of one readable merchant and direction (≥ 2 bookings); category = most common proposal. */
export function bulkReviewGroups(state: AppState): BulkReviewGroup[] {
  const groups = new Map<string, BulkReviewGroup & { votes: Map<Category, number> }>();
  for (const item of bulkCandidates(state)) {
    const name = item.draft.merchantAlias?.trim() || cleanMerchantName(item.draft.description);
    const category = suggestedCategory(state, item);
    const key = `${merchantKey(name)}|${Math.sign(item.draft.amount!)}`;
    const group = groups.get(key) ?? { key, label: name, category, ids: [] as string[], count: 0, total: 0, votes: new Map<Category, number>() };
    group.ids.push(item.id);
    group.count += 1;
    group.total = round(group.total + item.draft.amount!);
    group.votes.set(category, (group.votes.get(category) ?? 0) + 1);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.count >= 2)
    .map(({ votes, ...group }) => {
      const ranked = [...votes].sort((a, b) => Number(a[0] === "Prüfen") - Number(b[0] === "Prüfen") || b[1] - a[1]);
      return { ...group, category: ranked[0][0] };
    })
    .sort((a, b) => b.count - a.count || Math.abs(b.total) - Math.abs(a.total) || a.label.localeCompare(b.label, "de-AT"));
}

/**
 * Settles the given booking reviews with one category, exactly like the review dialog's
 * group save (statement-import.tsx `saveGroup`) followed by the provider's
 * `appendStatements` reducer: manual, reviewed category without fixed-cost marking,
 * committed via approveReviewedBooking (single row) or commitStatementImport.
 * Reviews that are not eligible or fail validation are skipped and stay open.
 */
export function applyBulkReview(state: AppState, ids: readonly string[], category: Category): BulkReviewResult {
  const chosen = canonicalCategory(category);
  const wanted = new Set(ids);
  const skipped = ids.filter((id) => !(state.reviewQueue ?? []).some((item) => item.id === id && isAiEligibleReview(item) &&
    !reuploadOnly(state, item)));
  if (chosen === "Prüfen") return { state, applied: [], skipped: [...ids] };
  const items = bulkCandidates(state).filter((item) => wanted.has(item.id));
  const rows: Transaction[] = [];
  const applied: string[] = [];
  const imported: ReviewItem[] = [];
  for (const item of items) {
    const draft = suggestedDraft(item.draft, aiSuggestionFor(state, item.id));
    const parsed = transactionSchema.safeParse({
      ...draft, category: chosen, categoryOverride: true, manualCategory: true, reviewed: true, includeInPlan: true, fixedCost: false,
    });
    if (!parsed.success) {
      skipped.push(item.id);
      continue;
    }
    const row = { ...parsed.data, includeInPlan: classify(parsed.data).includeInPlan };
    rows.push(row);
    applied.push(item.id);
    if (item.importUploadId) imported.push({ ...item, draft: row });
  }
  if (!rows.length) return { state, applied: [], skipped };
  const metadata: ImportMetadata = imported.length ? { reviewQueue: imported } : {};
  const approval = rows.length === 1 && !imported.length ? approveReviewedBooking(state, rows[0]) : undefined;
  const result = approval ?? commitStatementImport(state, rows, [], metadata);
  const next = approval ? refreshPlanning(result.state) : appStateSchema.parse(refreshPlanning(queueLedgerReview(result.state)));
  return { state: next, applied, skipped };
}
