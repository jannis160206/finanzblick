import { hasCategoryChoice } from "@/lib/manual-category";
import type { AppState, ReviewItem, Transaction } from "@/lib/types";

type Assignment = Partial<
  Pick<
    Transaction,
    | "is_locked"
    | "manualCategory"
    | "reviewed"
    | "categoryOverride"
    | "merchantAlias"
    | "merchantId"
    | "merchantMatch"
  >
>;

export function isAutomationLocked(row: Assignment): boolean {
  return (
    row.is_locked === true ||
    hasCategoryChoice(row) ||
    (!!row.merchantAlias && !row.merchantId && !row.merchantMatch)
  );
}

export function lockManualAssignments(state: AppState): AppState {
  const lock = <T extends Assignment>(row: T): T =>
    isAutomationLocked(row) && !row.is_locked
      ? { ...row, is_locked: true }
      : row;
  return {
    ...state,
    transactions: state.transactions.map(lock),
    ...(state.fixedReceipts
      ? {
          fixedReceipts: state.fixedReceipts.map((item) =>
            item.booking ? { ...item, booking: lock(item.booking) } : item,
          ),
        }
      : {}),
    ...(state.reviewQueue
      ? {
          reviewQueue: state.reviewQueue.map((item): ReviewItem =>
            item.kind === "booking"
              ? { ...item, draft: lock(item.draft) }
              : {
                  ...item,
                  change: {
                    ...item.change,
                    bookings: item.change.bookings.map(lock),
                  },
                },
          ),
        }
      : {}),
  };
}
