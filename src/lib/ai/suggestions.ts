import type { AppState } from "@/lib/types";
import type { AiSuggestionDraft } from "./evidence";

export type AiSuggestion = NonNullable<AppState["aiSuggestions"]>[number];
export type AiSuggestionEntry = { reviewId: string; reason: string; suggestion?: AiSuggestionDraft };

// Keeps one proposal per open review; proposals of resolved reviews disappear.
export function recordAiSuggestions(state: AppState, entries: readonly AiSuggestionEntry[]): AppState {
  const open = new Set((state.reviewQueue ?? []).map((item) => item.id));
  const byId = new Map((state.aiSuggestions ?? []).filter((item) => open.has(item.id)).map((item) => [item.id, item]));
  for (const entry of entries) {
    if (!open.has(entry.reviewId)) continue;
    if (!entry.suggestion) {
      byId.delete(entry.reviewId);
      continue;
    }
    const { category, merchantAlias, source } = entry.suggestion;
    byId.set(entry.reviewId, {
      id: entry.reviewId, category, source, reason: entry.reason.slice(0, 200),
      ...(merchantAlias ? { merchantAlias: merchantAlias.slice(0, 100) } : {}),
    });
  }
  const next = [...byId.values()];
  const previous = state.aiSuggestions ?? [];
  if (next.length === previous.length && next.every((item, index) => JSON.stringify(item) === JSON.stringify(previous[index])))
    return state;
  return { ...state, aiSuggestions: next };
}

export function aiSuggestionFor(state: AppState, reviewId: string): AiSuggestion | undefined {
  return state.aiSuggestions?.find((item) => item.id === reviewId);
}
