import { z } from "zod";
import { amexBalanceSnapshotSchema, type AppState } from "@/lib/types";
import { amexBookingKey, isAmexScreenshot } from "./identity";

export const amexBalanceRecoverySchema = z.object({
  snapshot: amexBalanceSnapshotSchema,
  bookingKeys: z.array(z.string().min(1).max(2000)).min(2).max(1000),
});
export const amexBalanceRecoveryResponseSchema = z.object({
  recoveries: z.array(amexBalanceRecoverySchema).max(20),
});
export type AmexBalanceRecovery = z.infer<typeof amexBalanceRecoverySchema>;

export function needsAmexBalanceRecovery(state: AppState) {
  const screenshots = [...state.transactions, ...(state.fixedReceipts ?? [])
    .flatMap((receipt) => receipt.booking ? [receipt.booking] : [])].filter(isAmexScreenshot);
  if (!screenshots.length) return false;
  const latest = screenshots.reduce((date, row) => row.date > date ? row.date : date, "");
  return !(state.amexBalanceSnapshots ?? []).some((snapshot) =>
    snapshot.periodStart <= latest && snapshot.date >= latest);
}

export function recoverAmexBalance(state: AppState, recoveries: AmexBalanceRecovery[]): AppState {
  const keys = new Set([...state.transactions, ...(state.fixedReceipts ?? [])
    .flatMap((receipt) => receipt.booking ? [receipt.booking] : [])]
    .filter(isAmexScreenshot).map(amexBookingKey).filter((key) => key !== null));
  const snapshots = [...state.amexBalanceSnapshots ?? []];
  for (const recovery of recoveries) {
    const { snapshot, bookingKeys } = recovery;
    if (snapshot.date > state.settings.asOf || snapshots.some((existing) =>
      existing.periodStart === snapshot.periodStart && existing.date >= snapshot.date)) continue;
    const matches = new Set(bookingKeys.filter((key) => keys.has(key)));
    if (matches.size >= 2) snapshots.push(snapshot);
  }
  return snapshots.length === (state.amexBalanceSnapshots?.length ?? 0)
    ? state : { ...state, amexBalanceSnapshots: snapshots };
}
