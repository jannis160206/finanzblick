import { isRaiffeisenBank } from "@/lib/accounts";
import { hasCategoryChoice, hasManualCategory } from "@/lib/manual-category";
import type { AppState, ReviewItem, Transaction } from "@/lib/types";
import {
  amexBookingKey,
  isAmexScreenshot,
  numberStatementRows,
  statementBaseKey,
  statementFingerprint,
} from "./identity";
import {
  hasTerminalText,
  sameTerminalBooking,
  unresolvedTerminal,
} from "./merchant-description";

// Facts that may be taken from the discarded copy. Assignments, plan flags and
// sharing decisions always stay with the surviving booking.
const descriptiveFields = [
  "time",
  "rawDescription",
  "rawDetails",
  "bankReference",
  "sourceCategory",
  "merchantAlias",
  "merchantId",
  "merchantLogo",
  "merchantMatch",
] as const satisfies readonly (keyof Transaction)[];

function decisionScore(row: Transaction): number {
  return (
    (hasManualCategory(row) ? 64 : 0) +
    (hasCategoryChoice(row) ? 32 : 0) +
    (row.is_locked ? 16 : 0) +
    (row.merchantNameConfirmed ? 8 : 0) +
    (row.sharedWithRaphael || row.sharedPaidManually ? 8 : 0) +
    (row.merchantAlias ? 4 : 0) +
    (row.categoryOverride ? 2 : 0) +
    (row.bankReference ? 2 : 0) +
    (!isAmexScreenshot(row) ? 2 : 0) +
    (unresolvedTerminal(row.description) ? 0 : 1)
  );
}

function mergeDuplicate(kept: Transaction, other: Transaction): Transaction {
  const [survivor, donor] =
    decisionScore(other) > decisionScore(kept) ? [other, kept] : [kept, other];
  const merged: Transaction = { ...survivor };
  for (const field of descriptiveFields)
    if (merged[field] === undefined && donor[field] !== undefined)
      Object.assign(merged, { [field]: donor[field] });
  if (
    !merged.merchantAlias &&
    unresolvedTerminal(merged.description) &&
    !unresolvedTerminal(donor.description)
  ) {
    merged.rawDescription ??= merged.description;
    merged.description = donor.description;
  }
  return merged;
}

function terminalKey(row: Transaction): string {
  return statementBaseKey({
    ...row,
    pocket: isRaiffeisenBank(row.bank) ? row.pocket : null,
    bankReference: undefined,
  });
}

function remapIds<T extends { id: string }>(
  rows: T[],
  replaced: ReadonlyMap<string, string>,
): T[] {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const id = replaced.get(row.id) ?? row.id;
    if (seen.has(id)) return [];
    seen.add(id);
    return [id === row.id ? row : { ...row, id }];
  });
}

function remapReviewQueue(
  queue: ReviewItem[],
  replaced: ReadonlyMap<string, string>,
): ReviewItem[] {
  return queue.flatMap((item): ReviewItem[] => {
    if (item.kind === "booking") return replaced.has(item.draft.id) ? [] : [item];
    const bookings = remapIds(item.change.bookings, replaced);
    if (!bookings.length) return [];
    const uploads = Object.fromEntries(
      Object.entries(item.importUploadIds ?? {}).map(([id, upload]) => [
        replaced.get(id) ?? id,
        upload,
      ]),
    );
    return [
      {
        ...item,
        change: { ...item.change, bookings },
        ...(item.importUploadIds ? { importUploadIds: uploads } : {}),
      },
    ];
  });
}

/**
 * Merges bookings that describe the same bank movement more than once:
 * identical account, date, amount, text/reference and occurrence, a legacy
 * POS copy of the same original text, or an Amex screenshot together with its
 * statement row. Genuinely repeated purchases keep distinct occurrence numbers
 * and are never merged. Returns the original state when nothing is duplicated.
 */
export function mergeDuplicateBookings(state: AppState): {
  state: AppState;
  merged: number;
} {
  const numbered = numberStatementRows(state.transactions);
  const byId = new Map<string, number>();
  const byFingerprint = new Map<string, number>();
  const byAmex = new Map<string, number[]>();
  const byTerminal = new Map<string, number[]>();
  const result: Transaction[] = [];
  const identities: Transaction[] = [];
  const replaced = new Map<string, string>();

  const index = (row: Transaction, position: number) => {
    byId.set(row.id, position);
    byFingerprint.set(statementFingerprint(row), position);
    const amex = amexBookingKey(row);
    if (amex) byAmex.set(amex, [...(byAmex.get(amex) ?? []), position]);
    if (hasTerminalText(row.rawDescription ?? row.description)) {
      const key = terminalKey(row);
      byTerminal.set(key, [...(byTerminal.get(key) ?? []), position]);
    }
  };
  const findDuplicate = (row: Transaction): number | undefined => {
    const direct = byId.get(row.id) ?? byFingerprint.get(statementFingerprint(row));
    if (direct !== undefined) return direct;
    const amex = amexBookingKey(row);
    const screenshot = amex
      ? byAmex.get(amex)?.find(
          (position) =>
            (isAmexScreenshot(identities[position]) || isAmexScreenshot(row)) &&
            identities[position].occurrence === row.occurrence,
        )
      : undefined;
    if (screenshot !== undefined) return screenshot;
    if (!hasTerminalText(row.rawDescription ?? row.description)) return undefined;
    return byTerminal.get(terminalKey(row))?.find((position) => {
      const old = identities[position];
      return (
        sameTerminalBooking(old, row) &&
        ((old.bankReference && row.bankReference) ||
          old.occurrence === row.occurrence)
      );
    });
  };

  state.transactions.forEach((original, position) => {
    const row = numbered[position];
    const duplicate = findDuplicate(row);
    if (duplicate === undefined) {
      result.push(original);
      identities.push(row);
      index(row, result.length - 1);
      return;
    }
    const kept = result[duplicate];
    const merged = mergeDuplicate(kept, original);
    result[duplicate] = merged;
    if (kept.id !== merged.id) replaced.set(kept.id, merged.id);
    if (original.id !== merged.id) replaced.set(original.id, merged.id);
  });

  const removed = state.transactions.length - result.length;
  if (!removed) return { state, merged: 0 };
  const resolve = (id: string): string => {
    let current = id;
    for (let hops = 0; replaced.has(current) && hops < replaced.size; hops++)
      current = replaced.get(current)!;
    return current;
  };
  const effective = new Map(
    [...replaced.keys()].map((id) => [id, resolve(id)] as const),
  );
  return {
    merged: removed,
    state: {
      ...state,
      transactions: result,
      ...(state.reviewQueue
        ? { reviewQueue: remapReviewQueue(state.reviewQueue, effective) }
        : {}),
      ...(state.fixedReceipts
        ? {
            fixedReceipts: state.fixedReceipts.map((receipt) =>
              receipt.booking && effective.has(receipt.booking.id)
                ? {
                    ...receipt,
                    booking: {
                      ...receipt.booking,
                      id: effective.get(receipt.booking.id)!,
                    },
                  }
                : receipt,
            ),
          }
        : {}),
      financeRows: state.financeRows.map((row) =>
        row.fixedSource?.bookingIds.some((id) => effective.has(id))
          ? {
              ...row,
              fixedSource: {
                ...row.fixedSource,
                bookingIds: [
                  ...new Set(
                    row.fixedSource.bookingIds.map((id) => effective.get(id) ?? id),
                  ),
                ],
              },
            }
          : row,
      ),
    },
  };
}
