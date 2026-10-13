import { transactionSchema, type AppState, type ReviewItem, type Transaction } from "@/lib/types";
import type { StatementResult } from "./statements";
import { statementFingerprint } from "./identity";
import { IMPORT_RESULT_RETENTION_MS, MAX_IMPORT_RESULTS, importResultSchema, type ImportResult } from "./result-schema";
import type { AutomationErrorCode } from "@/lib/automation/errors";
export { importResultSchema, type ImportResult } from "./result-schema";

export type ImportSource = {
  uploadId: string;
  name: string;
  source: StatementResult["source"];
  rows: Transaction[];
  skipped: number;
  issues: ImportResult["issues"];
  repairDraftIds: string[];
  failureCode?: AutomationErrorCode;
};
export type UploadedStatementResult = StatementResult & { uploadId?: string; failureCode?: AutomationErrorCode };

export function createStatementJobOutcome(uploadId: string, state: Pick<AppState, "importResults">): ImportResult {
  const result = state.importResults?.find((item) => item.uploadId === uploadId);
  if (!result) throw new Error("Kein bestätigtes Ergebnis für diesen Upload vorhanden.");
  return importResultSchema.parse(result);
}

function bookings(state: AppState) {
  return [...new Map([
    ...state.transactions,
    ...(state.fixedReceipts ?? []).flatMap((item) => item.booking ? [item.booking] : []),
  ].map((row) => [statementFingerprint(row), row])).values()];
}

const reviewRows = (item: ReviewItem) => item.kind === "booking" ? [item.draft] : item.change.bookings;
export const reviewUploadId = (item: ReviewItem, bookingId: string) =>
  (item.kind === "fixed" ? item.importUploadIds?.[bookingId] : undefined) ?? item.importUploadId;
const sameFacts = (a: Transaction, b: Transaction) => JSON.stringify(a) === JSON.stringify(b);

export function retainImportResults(results: ImportResult[], now = Date.now()): ImportResult[] {
  return [...new Map(results.map((result) => [result.uploadId, result])).values()]
    .filter((result) => now - result.completedAt < IMPORT_RESULT_RETENTION_MS)
    .sort((a, b) => b.completedAt - a.completedAt).slice(0, MAX_IMPORT_RESULTS)
    .map((result) => importResultSchema.parse(result));
}

export function completeImportResults(
  before: AppState,
  after: AppState,
  sources: ImportSource[],
  matchedIds = new Map<string, string>(),
  now = Date.now(),
): ImportResult[] {
  const previous = bookings(before);
  const current = bookings(after);
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const previousByKey = new Map(previous.map((row) => [statementFingerprint(row), row]));
  const currentById = new Map(current.map((row) => [row.id, row]));
  const currentByKey = new Map(current.map((row) => [statementFingerprint(row), row]));
  const pending = after.reviewQueue ?? [];
  const pendingById = new Map(pending.map((item) => [item.id, item]));
  const previousPendingRows = new Set((before.reviewQueue ?? []).flatMap((item) => reviewRows(item).map((row) => row.id)));
  const previousPendingKeys = new Set((before.reviewQueue ?? []).flatMap((item) =>
    item.kind === "booking" && item.sourceRepair ? [] : reviewRows(item).flatMap((row) =>
      row.amount !== null && row.date ? [statementFingerprint({ ...row, amount: row.amount })] : [])));
  const pendingByRow = new Map<string, ReviewItem>();
  const pendingByKey = new Map<string, ReviewItem>();
  for (const item of pending) for (const draft of reviewRows(item)) {
    pendingByRow.set(draft.id, item);
    if (!(item.kind === "booking" && item.sourceRepair) && draft.amount !== null && draft.date)
      pendingByKey.set(statementFingerprint({ ...draft, amount: draft.amount }), item);
  }
  // One persisted booking can be claimed by at most one row in this batch.
  const claimed = new Set<string>();
  const claimedReviews = new Set<string>();
  return sources.map((source): ImportResult => {
    let inserted = 0, updated = 0, duplicates = 0, review = 0, discarded = 0;
    const draftIds = new Set<string>();
    for (const row of source.rows) {
      const key = statementFingerprint(row);
      const matchId = matchedIds.get(row.id) ?? row.id;
      const saved = currentById.get(matchId) ?? currentByKey.get(key);
      const open = pendingByRow.get(row.id) ?? pendingByKey.get(key);
      if (open) {
        const identity = `${open.id}:${key}`;
        const alreadyPending = previousPendingRows.has(row.id) || previousPendingKeys.has(key);
        if (alreadyPending || claimedReviews.has(identity)) {
          if (saved) duplicates++;
          else discarded++;
        }
        else review++;
        claimedReviews.add(identity);
        draftIds.add(row.id);
      } else if (saved && !claimed.has(saved.id)) {
        const old = previousById.get(saved.id) ?? previousByKey.get(statementFingerprint(saved));
        if (!old) inserted++;
        else if (!sameFacts(old, saved)) updated++;
        else duplicates++;
        claimed.add(saved.id);
      } else if (saved) {
        duplicates++;
      } else {
        discarded++;
      }
    }
    const issues = source.issues.filter((issue) =>
      !issue.reviewId || pendingById.has(issue.reviewId));
    for (const issue of issues) {
      if (!issue.reviewId || draftIds.has(issue.reviewId)) continue;
      const item = pendingById.get(issue.reviewId);
      if (item) {
        review += reviewRows(item).length;
        draftIds.add(issue.reviewId);
      }
    }
    for (const id of source.repairDraftIds) {
      if (!draftIds.has(id) && pendingById.has(id)) {
        review++;
        draftIds.add(id);
      }
    }
    const repairDrafts = new Set(source.repairDraftIds);
    const skipped = Math.max(0, source.skipped - repairDrafts.size) + discarded;
    return importResultSchema.parse({
      uploadId: source.uploadId, name: source.name.slice(0, 255), completedAt: now,
      status: source.failureCode ? "failed" : source.source === null ? "unsupported" : issues.length || review || skipped ? "with-warnings" : "imported",
      ...(source.failureCode ? { errorCode: source.failureCode } : {}),
      inserted, updated, duplicates, review, skipped, issues,
    });
  });
}

export function reconcileImportResultReviews(before: AppState, after: AppState): ImportResult[] {
  const pending = new Set((after.reviewQueue ?? []).map((item) => item.id));
  const saved = bookings(after);
  const previous = bookings(before);
  const previousById = new Map(previous.map((row) => [row.id, row]));
  const previousByKey = new Map(previous.map((row) => [statementFingerprint(row), row]));
  const savedById = new Map(saved.map((row) => [row.id, row]));
  const savedByKey = new Map(saved.map((row) => [statementFingerprint(row), row]));
  const pendingRowIds = new Set((after.reviewQueue ?? []).flatMap((item) => reviewRows(item).map((draft) => draft.id)));
  const removed = (before.reviewQueue ?? []).flatMap((item): ReviewItem[] => {
    if (item.kind === "booking") return pendingRowIds.has(item.draft.id) ? [] : [item];
    const bookings = item.change.bookings.filter((row) => !pendingRowIds.has(row.id));
    return bookings.length ? [{ ...item, change: { ...item.change, bookings } }] : [];
  });
  return (before.importResults ?? []).map((result) => {
    const linkedIds = new Set(result.issues.flatMap((issue) => issue.reviewId ? [issue.reviewId] : []));
    const resolved = removed.flatMap((item) => reviewRows(item).flatMap((draft) => {
      const uploadId = reviewUploadId(item, draft.id);
      return (uploadId === result.uploadId || (linkedIds.has(item.id) &&
        (item.kind === "booking" || !item.importUploadIds))) ? [draft] : [];
    }));
    if (!resolved.length) return importResultSchema.parse(result);
    let inserted = 0, updated = 0, duplicates = 0, skipped = 0;
    for (const draft of resolved) {
      const facts = transactionSchema.safeParse(draft);
      const row = savedById.get(draft.id) ?? (facts.success ? savedByKey.get(statementFingerprint(facts.data)) : undefined);
      if (!row) { skipped++; continue; }
      const old = previousById.get(row.id) ?? previousByKey.get(statementFingerprint(row));
      if (!old) inserted++;
      else if (!sameFacts(old, row)) updated++;
      else duplicates++;
    }
    const count = resolved.length;
    const issues = result.issues.filter((issue) => !issue.reviewId || pending.has(issue.reviewId));
    const hadReview = result.review > 0;
    return importResultSchema.parse({ ...result, review: Math.max(0, result.review - count),
      inserted: result.inserted + (hadReview ? inserted : 0), updated: result.updated + (hadReview ? updated : 0),
      duplicates: result.duplicates + (hadReview ? duplicates : 0),
      skipped: result.skipped + (hadReview ? skipped : 0), issues,
      status: result.status === "unsupported" || result.status === "failed" ? result.status :
        issues.length || result.review > count || result.skipped || (hadReview && skipped) ? "with-warnings" : "imported" });
  });
}

export function importResultLabel(result: ImportResult) {
  return result.status === "failed" ? "Import fehlgeschlagen" : result.status === "unsupported" ? "Nicht unterstützt" :
    result.status === "with-warnings" ? "Abgeschlossen mit Hinweisen" : "Abgeschlossen";
}
