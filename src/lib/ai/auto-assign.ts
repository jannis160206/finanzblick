import type { AppState } from "@/lib/types";
import { applyAiReviewDecisions, type AiReviewDecision } from "./apply-review-decisions";
import { decideReviewWithEvidence } from "./evidence";
import { aiReviewCandidates } from "./review-candidates";
import { aiSuggestionFor, recordAiSuggestions, type AiSuggestionEntry } from "./suggestions";

export type AutoAssignResult = { state: AppState; applied: string[] };

// Rules, own history, refunds and fixed bank pairs need no model, so they run on every import.
export function autoAssignOpenReviews(state: AppState): AutoAssignResult {
  const decisions: AiReviewDecision[] = [];
  const suggestions: AiSuggestionEntry[] = [];
  for (const candidate of aiReviewCandidates(state, new Set(), 100_000)) {
    const decision = decideReviewWithEvidence(state, candidate.reviewId, candidate.input, undefined);
    if (decision.accepted)
      decisions.push({ reviewId: candidate.reviewId, category: decision.category, merchantAlias: decision.merchantAlias });
    // The model cannot name an anonymous PayPal shop either, so this proposal need not wait for it.
    else if (decision.suggestion?.source === "Abo" && !aiSuggestionFor(state, candidate.reviewId))
      suggestions.push({ reviewId: candidate.reviewId, reason: decision.reason, suggestion: decision.suggestion });
  }
  if (!decisions.length && !suggestions.length) return { state, applied: [] };
  const outcome = decisions.length ? applyAiReviewDecisions(state, decisions) : { state, applied: [] };
  return { state: recordAiSuggestions(outcome.state, suggestions), applied: outcome.applied };
}

export const MAX_AI_LEARNING = 200;

// Assigns what is certain right at import and records the share that needed no review.
export function assignAfterImport(state: AppState, uploadIds: readonly string[]): AppState {
  const uploadOf = new Map((state.reviewQueue ?? []).flatMap((item) =>
    item.kind === "booking" && item.importUploadId ? [[item.id, item.importUploadId] as const] : []));
  const { state: next, applied } = autoAssignOpenReviews(state);
  const entries = uploadIds.flatMap((uploadId) => {
    const result = state.importResults?.find((item) => item.uploadId === uploadId);
    const rows = result ? result.inserted + result.review : 0;
    if (!result || !rows) return [];
    return [{ id: uploadId, name: result.name, at: result.completedAt, rows, automatic: result.inserted,
      ai: applied.filter((id) => uploadOf.get(id) === uploadId).length }];
  });
  if (!entries.length) return next;
  const ids = new Set(entries.map((entry) => entry.id));
  const aiLearning = [...(next.aiLearning ?? []).filter((entry) => !ids.has(entry.id)), ...entries]
    .sort((left, right) => left.at - right.at).slice(-MAX_AI_LEARNING);
  return { ...next, aiLearning };
}

// Later model decisions on an import's reviews still count for that import.
export function countLaterAssignments(state: AppState, uploadIds: readonly string[]): AppState {
  if (!uploadIds.length || !state.aiLearning?.length) return state;
  const counts = new Map<string, number>();
  for (const id of uploadIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  if (!state.aiLearning.some((entry) => counts.has(entry.id))) return state;
  return { ...state, aiLearning: state.aiLearning.map((entry) => counts.has(entry.id)
    ? { ...entry, later: (entry.later ?? 0) + counts.get(entry.id)! } : entry) };
}

// applyAiReviewDecisions plus the learning-curve credit for the imports the reviews came from.
export function applyAndCount(state: AppState, decisions: AiReviewDecision[]) {
  const outcome = applyAiReviewDecisions(state, decisions);
  if (!outcome.applied.length) return outcome;
  const uploadOf = new Map((state.reviewQueue ?? []).flatMap((item) =>
    item.kind === "booking" && item.importUploadId ? [[item.id, item.importUploadId] as const] : []));
  const uploads = outcome.applied.flatMap((id) => uploadOf.get(id) ?? []);
  return { ...outcome, state: countLaterAssignments(outcome.state, uploads) };
}
