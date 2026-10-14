import type { AppState } from "@/lib/types";
import { openReviewCount } from "@/lib/import/review";
import { MerchantIndex, seedMerchants } from "./merchants";
import { backfillBatch } from "./pipeline";

let index: MerchantIndex | undefined;

// Applies the current recognition rules to already open assignments without
// waiting for the server worker. Locked and manual assignments are skipped by
// the pipeline; the result is only kept when it actually closes entries.
export function settleOpenReviews(state: AppState): AppState {
  const queue = state.reviewQueue ?? [];
  const ids = new Set(
    queue.flatMap((item) =>
      item.kind === "booking"
        ? [item.draft.id]
        : item.change.bookings.map((row) => row.id),
    ),
  );
  if (!ids.size) return state;
  index ??= new MerchantIndex(seedMerchants);
  const next = backfillBatch(state, ids, index);
  return openReviewCount(next.reviewQueue ?? []) < openReviewCount(queue)
    ? next
    : state;
}
