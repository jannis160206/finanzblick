import { autoAssignAndCount, autoAssignOpenReviews, type AutoAssignResult } from "@/lib/ai/auto-assign";
import type { Industry } from "@/lib/ai/industry";
import { recordWebCategories, type WebTarget } from "@/lib/ai/web-categories";
import { settleOpenReviews } from "@/lib/automation/settle-open";
import { calculateDashboard } from "@/lib/calc";
import { computeDashboardExtras } from "@/lib/dashboard-extras";
import { prepareLoadedState } from "@/lib/finance-hydrate";
import type { AppState } from "@/lib/types";
import type { FinanceWorkerRequest, FinanceWorkerResponse } from "@/lib/finance-worker";

// Runs the CPU-heavy, side-effect-free finance steps off the main thread; the logic is the same as on the main thread.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FinanceWorkerRequest>) => void) | null;
  postMessage: (message: FinanceWorkerResponse) => void;
};

const summary = (state: AppState, outcome: AutoAssignResult) =>
  outcome.state === state ? { changed: false as const, applied: outcome.applied } : { changed: true as const, state: outcome.state, applied: outcome.applied };

function run(request: FinanceWorkerRequest): unknown {
  switch (request.kind) {
    case "prepare": {
      const state = prepareLoadedState(request.data, request.reference);
      const dashboard = calculateDashboard(state);
      return JSON.stringify(state) === JSON.stringify(request.data) ? { unchanged: true, dashboard } : { unchanged: false, state, dashboard };
    }
    case "settle": {
      const state = settleOpenReviews(request.state);
      return state === request.state ? { changed: false } : { changed: true, state };
    }
    case "autoAssign": return summary(request.state, autoAssignOpenReviews(request.state));
    case "webAssign": {
      const found = request.found as { target: WebTarget; industry?: Industry }[];
      const recorded = recordWebCategories(request.state, found, request.now);
      return summary(request.state, autoAssignAndCount(recorded));
    }
    case "extras": return computeDashboardExtras(request.state);
  }
}

scope.onmessage = (event: MessageEvent<FinanceWorkerRequest>) => {
  const request = event.data;
  let response: FinanceWorkerResponse;
  try {
    response = { id: request.id, ok: true, result: run(request) };
  } catch (error) {
    response = { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  scope.postMessage(response);
};
