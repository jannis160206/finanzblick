import { synchronizeGoals } from "@/lib/calc";
import { type AppState } from "@/lib/types";
import { applyVariableBudgets } from "@/lib/variable-budgets";
import { synchronizePlannedOneOffs } from "@/lib/planned-one-offs";

export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function synchronizePlan(state: AppState): AppState {
  return synchronizeGoals(applyVariableBudgets(synchronizePlannedOneOffs(state)));
}

export function refreshPlanning(
  state: AppState,
  today = localToday(),
): AppState {
  // The workbook's supported horizon and the actual-balance baseline remain authoritative.
  const asOf = [
    state.settings.baselineDate,
    today < "2026-01-01"
      ? "2026-01-01"
      : today > "2027-12-31"
        ? "2027-12-31"
        : today,
  ]
    .sort()
    .at(-1)!;
  return synchronizePlan({ ...state, settings: { ...state.settings, asOf } });
}
