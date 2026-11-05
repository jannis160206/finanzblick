import type { AppState } from "@/lib/types";
import { applyAiReviewDecisions, type AiReviewDecision } from "./apply-review-decisions";
import { decideReviewWithEvidence, type EvidenceContext } from "./evidence";
import { aiReviewCandidates } from "./review-candidates";
import { aiSuggestionFor, recordAiSuggestions, type AiSuggestionEntry } from "./suggestions";
import { webEntry, webEvidence, webHabits, webTarget } from "./web-categories";

export type AutoAssignResult = { state: AppState; applied: string[] };

// The shop of a review as the internet described it earlier, adjusted to the household's habits.
export function webContextFor(state: AppState, reviewId: string, habits = webHabits(state)): EvidenceContext {
  if (!state.webCategories?.length) return {};
  const item = state.reviewQueue?.find((entry) => entry.id === reviewId);
  if (item?.kind !== "booking" || (item.draft.amount ?? 0) >= 0) return {};
  const industry = webEvidence(webEntry(state, webTarget(item.draft)), habits);
  return industry ? { industry } : {};
}

// Rules, own history, refunds, fixed bank pairs and shops known from the internet need no model,
// so they run on every import.
export function autoAssignOpenReviews(state: AppState): AutoAssignResult {
  const decisions: AiReviewDecision[] = [];
  const suggestions: AiSuggestionEntry[] = [];
  const habits = state.webCategories?.length ? webHabits(state) : new Map();
  for (const candidate of aiReviewCandidates(state, new Set(), 100_000)) {
    const decision = decideReviewWithEvidence(state, candidate.reviewId, candidate.input, undefined,
      webContextFor(state, candidate.reviewId, habits));
    if (decision.accepted)
      decisions.push({ reviewId: candidate.reviewId, category: decision.category, merchantAlias: decision.merchantAlias });
    // The model cannot name an anonymous PayPal shop either, so this proposal need not wait for it.
    else if ((decision.suggestion?.source === "Abo" || decision.suggestion?.source === "Branche") && !aiSuggestionFor(state, candidate.reviewId))
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

// autoAssignOpenReviews plus the learning-curve credit for the imports the reviews came from.
export function autoAssignAndCount(state: AppState): AutoAssignResult {
  const outcome = autoAssignOpenReviews(state);
  if (!outcome.applied.length) return outcome;
  const uploadOf = new Map((state.reviewQueue ?? []).flatMap((item) =>
    item.kind === "booking" && item.importUploadId ? [[item.id, item.importUploadId] as const] : []));
  return { ...outcome, state: countLaterAssignments(outcome.state, outcome.applied.flatMap((id) => uploadOf.get(id) ?? [])) };
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
