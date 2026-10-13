import { expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import {
  IMPORT_RESULT_WARNING_JSON_BUDGET, IMPORT_WARNING_DETAILS_OMITTED,
  MAX_IMPORT_RESULT_JSON_LENGTH, importResultSchema, type ImportResult,
} from "./result-schema";
import { completeImportResults, createStatementJobOutcome, reconcileImportResultReviews, retainImportResults } from "./results";

const uploadId = "da6d4f78-0092-46e0-8603-0d65316bf735";
const booking: Transaction = { id: "good", date: "2026-10-05", bank: "Raiffeisen",
  pocket: "Raiffeisen Giro", description: "SPAR", amount: -12, category: "Lebensmittel", includeInPlan: true };
const empty = (): AppState => ({ ...createSeed(), transactions: [], reviewQueue: [], fixedReceipts: [],
  financeRows: [], plannedOneOffs: [], plannedOneOffsSeeded: true });
const largeResult = (text = "X".repeat(2000)): ImportResult => ({
  uploadId, name: "warnings.csv", completedAt: Date.now(), status: "with-warnings",
  inserted: 1, updated: 2, duplicates: 3, review: 50, skipped: 50,
  issues: Array.from({ length: 100 }, (_, index) => ({
    id: `${uploadId}:${index}`, line: index + 2, message: text, evidence: text,
    ...(index < 50 ? { action: "correct" as const, reviewId: `review-${index}` }
      : { action: "reupload" as const, reason: "foreign-currency" as const }),
  })),
});
const identities = (result: ImportResult) => result.issues.map(({ id, line, action, reason, reviewId }) =>
  ({ id, line, action, reason, reviewId }));
const counts = (result: ImportResult) => ({
  inserted: result.inserted, updated: result.updated, duplicates: result.duplicates, review: result.review, skipped: result.skipped,
});

it.each(["X".repeat(2000), "\u0000".repeat(2000), "😀".repeat(1000)])(
  "budgets encoded warning text without dropping any issue, count, action, reason or review link (%#)", (text) => {
    const raw = largeResult(text);
    const original = structuredClone(raw);
    expect(JSON.stringify(raw).length).toBeGreaterThan(MAX_IMPORT_RESULT_JSON_LENGTH);
    const bounded = importResultSchema.parse(raw);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(IMPORT_RESULT_WARNING_JSON_BUDGET);
    expect(bounded.warningDetailsOmitted).toBe(true);
    expect(bounded.issues[0].message).toContain(IMPORT_WARNING_DETAILS_OMITTED);
    expect(identities(bounded)).toEqual(identities(raw));
    expect(counts(bounded)).toEqual(counts(raw));
    expect(raw).toEqual(original);
    expect(importResultSchema.parse(bounded)).toEqual(bounded);
  },
);

it("normalizes both finance results and checkpoint outcomes consistently before persistence", () => {
  const before = empty();
  const after = { ...before, transactions: [booking] };
  const raw = largeResult();
  const results = completeImportResults(before, after, [{
    uploadId, name: raw.name, source: "Raiffeisen", rows: [booking], skipped: 100,
    issues: raw.issues.map((issue) => ({ ...issue, action: "reupload" as const,
      reason: "foreign-currency" as const, reviewId: undefined })), repairDraftIds: [],
  }]);
  const state = { ...after, importResults: results };
  expect(results[0]).toMatchObject({ inserted: 1, review: 0, skipped: 100 });
  expect(results[0].issues).toHaveLength(100);
  expect(JSON.stringify(results[0]).length).toBeLessThanOrEqual(IMPORT_RESULT_WARNING_JSON_BUDGET);
  expect(appStateSchema.parse(state).transactions).toEqual([booking]);
  expect(appStateSchema.parse(state).importResults).toEqual(results);
  expect(createStatementJobOutcome(uploadId, state)).toEqual(results[0]);
});

it("normalizes retained and reconciled legacy results without changing their counts", () => {
  const raw = largeResult();
  const state: AppState = { ...empty(), importResults: [raw] };
  const retained = retainImportResults([raw]);
  const reconciled = reconcileImportResultReviews(state, state);
  expect(retained).toEqual(reconciled);
  expect(counts(retained[0])).toEqual(counts(raw));
  expect(JSON.stringify(retained[0]).length).toBeLessThanOrEqual(IMPORT_RESULT_WARNING_JSON_BUDGET);
});

it("keeps the explicit omitted-details hint after the first linked review is resolved", () => {
  const bounded = importResultSchema.parse(largeResult());
  const row = { ...booking, id: "review-0" };
  const before: AppState = { ...empty(), importResults: [bounded], reviewQueue: Array.from({ length: 50 }, (_, index) => ({
    kind: "booking", id: `review-${index}`, draft: { ...booking, id: `review-${index}` },
    importUploadId: uploadId, message: "Prüfen.",
  })) };
  const result = reconcileImportResultReviews(before, { ...before,
    reviewQueue: before.reviewQueue!.slice(1), transactions: [row] })[0];
  expect(result).toMatchObject({ inserted: 2, review: 49, skipped: 50, warningDetailsOmitted: true });
  expect(result.issues[0].reviewId).toBe("review-1");
  expect(result.issues[0].message).toContain(IMPORT_WARNING_DETAILS_OMITTED);
  expect(importResultSchema.parse(result)).toEqual(result);
});

it("keeps unusually long review links intact even when identity metadata exceeds the preferred text budget", () => {
  const raw = largeResult();
  raw.issues = raw.issues.map((issue) => ({ ...issue, action: "correct", reviewId: "R".repeat(2000) }));
  const bounded = importResultSchema.parse(raw);
  expect(JSON.stringify(bounded).length).toBeGreaterThan(IMPORT_RESULT_WARNING_JSON_BUDGET);
  expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(MAX_IMPORT_RESULT_JSON_LENGTH);
  expect(identities(bounded)).toEqual(identities(raw));
  expect(counts(bounded)).toEqual(counts(raw));
  expect(importResultSchema.parse(bounded)).toEqual(bounded);
});

it("rejects identity-only metadata that cannot fit the existing checkpoint limit rather than shortening review IDs", () => {
  const raw = largeResult();
  raw.issues = raw.issues.map((issue) => ({ ...issue, reviewId: "\"".repeat(2000) }));
  expect(importResultSchema.safeParse(raw).success).toBe(false);
  expect(raw.issues.every((issue) => issue.reviewId === "\"".repeat(2000))).toBe(true);
});
