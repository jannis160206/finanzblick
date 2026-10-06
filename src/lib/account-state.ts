import { createSeed } from "@/lib/seed";
import { emptyPockets, type AppState } from "@/lib/types";
import { localToday } from "@/lib/planning";

export function createEmptyAccountState(): AppState {
  const seed = createSeed();
  const today = localToday();
  return {
    ...seed,
    settings: {
      ...seed.settings,
      asOf: today,
      baselineDate: today,
      balances: emptyPockets(),
      emergencyTarget: 0,
      vacationTarget: 0,
      savingsTarget: 0,
      bikeTarget: 0,
    },
    savingsGoals: [],
    bikeOnlyGoalApplied: true,
    plannedOneOffs: [],
    plannedOneOffsSeeded: true,
    holidayRanges: [],
    transactions: [],
    financeRows: [],
    months: {},
  };
}
