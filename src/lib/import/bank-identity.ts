import { isRevolutMainAccount, normalizeAccount } from "@/lib/accounts";
import type { Transaction } from "@/lib/types";

export const BANK_REFERENCE_PREFIX = "xs2a:";

export function isBankSyncRow(row: Pick<Transaction, "bankReference">): boolean {
  return !!row.bankReference?.startsWith(BANK_REFERENCE_PREFIX);
}

/** Stable account identity for comparing synced rows with CSV/PDF rows of the same account. */
export function accountIdentity(row: Pick<Transaction, "bank" | "pocket">): string {
  const account = normalizeAccount({ bank: row.bank, pocket: row.pocket ?? null });
  if (isRevolutMainAccount(account)) return "revolut|main";
  return `${account.bank.trim().toLowerCase()}|${(account.pocket ?? "").trim().toLowerCase()}`;
}

/** Latest booking date per account that came from a non-bank-sync import (CSV, PDF, Excel). */
export function coveredUntilByAccount(existing: Pick<Transaction, "bank" | "pocket" | "date" | "bankReference">[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const row of existing) {
    if (isBankSyncRow(row)) continue;
    const key = accountIdentity(row);
    const date = row.date.slice(0, 10);
    if ((latest.get(key) ?? "") < date) latest.set(key, date);
  }
  return latest;
}
