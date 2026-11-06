import type { AppState } from "@/lib/types";

/**
 * Marks bookings as ignored (or counts them again). Ignored bookings stay in the ledger and in
 * account balances, but classify() treats them like transfers, so they drop out of every
 * statistic, budget, insight and agent answer. Statement receipts (fixedReceipts) are keyed by id.
 */
export function setBookingsIgnored(state: AppState, ids: Iterable<string>, ignored: boolean): AppState {
  const targets = new Set(ids);
  if (!targets.size) return state;
  const flag = <T extends { ignored?: boolean }>(row: T): T => {
    if (!!row.ignored === ignored) return row;
    if (ignored) return { ...row, ignored: true };
    const { ignored: _removed, ...rest } = row;
    void _removed;
    return rest as T;
  };
  const stored = new Set(state.transactions.map((row) => row.id));
  return {
    ...state,
    transactions: state.transactions.map((row) => targets.has(row.id) ? flag(row) : row),
    ...(state.fixedReceipts?.some((item) => targets.has(item.key) && !stored.has(item.key)) ? {
      fixedReceipts: state.fixedReceipts.map((item) => targets.has(item.key) && !stored.has(item.key)
        ? { ...item, booking: flag(item.booking ?? {
          id: item.key, date: item.date, amount: item.amount, bank: "Auszugsbeleg", pocket: null,
          description: item.category, category: item.category, includeInPlan: false,
        }) } : item),
    } : {}),
    // Nothing left to check on a booking that no longer counts: drop its ledger review.
    ...(ignored && state.reviewQueue ? {
      reviewQueue: state.reviewQueue.filter((item) =>
        !(item.kind === "booking" && targets.has(item.draft.id) && stored.has(item.draft.id))),
    } : {}),
  };
}
