import type { AppState } from "@/lib/types";

// Removes every booking and everything derived from the bank statements.
// Rules, aliases, plan, goals, balances and settings stay for the re-import.
export function clearAllBookings(state: AppState): AppState {
  const cleared: AppState = {
    ...state,
    transactions: [],
    reviewQueue: [],
    fixedReceipts: [],
    financeRows: state.financeRows.map((row) =>
      row.fixedSource
        ? { ...row, fixedSource: { ...row.fixedSource, bookingIds: [] } }
        : row,
    ),
  };
  delete cleared.importStatus;
  delete cleared.importResults;
  delete cleared.ignoredStatementKeys;
  return cleared;
}
