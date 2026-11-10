import { actualPockets, synchronizeGoals } from "@/lib/calc";
import { initializeMotorcycleGoal } from "@/lib/goals";
import { queueLedgerReview } from "@/lib/import/review";
import { restoreLegacySourceCategories } from "@/lib/legacy-source";
import { initializePlannedOneOffs } from "@/lib/planned-one-offs";
import { refreshPlanning } from "@/lib/planning";
import { appStateSchema, type AppState } from "@/lib/types";

/** Normalizes a loaded finance state exactly like the provider's hydrate step; throws FixedPlanCapacityError. */
export function prepareLoadedState(data: AppState, reference?: AppState): AppState {
  const prepared = refreshPlanning(queueLedgerReview(initializePlannedOneOffs(restoreLegacySourceCategories(data, reference))));
  return appStateSchema.parse(synchronizeGoals(initializeMotorcycleGoal(prepared, actualPockets(prepared).Motorrad)));
}
