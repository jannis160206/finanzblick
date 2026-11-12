import { appStateSchema, type AppState } from "@/lib/types";

/**
 * What only the assistant keeps: the chat, learned knowledge and phrasings and the log of its own changes. No figure depends on it.
 * Its memory is not part of this: a remembered buffer, payday or Giro balance feeds forecasts, net worth and hints.
 */
export const assistantStateKeys = [
  "assistantChat", "assistantKnowledge", "assistantPhrases", "assistantAliases", "assistantGaps", "assistantChanges",
] as const satisfies readonly (keyof AppState)[];

const assistantKeys = new Set<string>(assistantStateKeys);
const entries = (state: AppState) => Object.entries(state) as [keyof AppState, unknown][];

/** True when `after` holds exactly the same figures as `before`: everything outside the assistant's own data is unchanged. */
export function onlyAssistantChanged(before: AppState, after: AppState): boolean {
  if (before === after) return true;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof AppState)[]);
  for (const key of keys) if (!assistantKeys.has(key) && before[key] !== after[key]) return false;
  return true;
}

/** `figures` with the assistant's data taken from `assistant`, e.g. a result computed on an older state plus the chat written since. */
export function withAssistantState(figures: AppState, assistant: AppState): AppState {
  return Object.fromEntries([
    ...entries(figures).filter(([key]) => !assistantKeys.has(key)),
    ...entries(assistant).filter(([key, value]) => assistantKeys.has(key) && value !== undefined),
  ]) as AppState;
}

/** Validates only the assistant fields that differ from `before`; the rest was validated when it was stored. */
export function parseAssistantChanges(before: AppState, after: AppState): AppState {
  const parsed = entries(after).map(([key, value]) => key in appStateSchema.shape && assistantKeys.has(key) && value !== before[key] && value !== undefined
    ? [key, appStateSchema.shape[key].parse(value)] : [key, value]);
  return Object.fromEntries(parsed) as AppState;
}

const roots = new WeakMap<AppState, AppState>();

/** Records that `next` has the same figures as `previous`, so everything computed from them can be reused. */
export function shareFigures(next: AppState, previous: AppState) {
  if (next !== previous) roots.set(next, roots.get(previous) ?? previous);
}

/** The first state with these figures; caches of dashboards and ledger-wide results are keyed by it. */
export const figuresOf = (state: AppState): AppState => roots.get(state) ?? state;
