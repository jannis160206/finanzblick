import type { Transaction } from "@/lib/types";
import { isRaiffeisenBank, isRaiffeisenMainAccount, normalizeAccount } from "@/lib/accounts";
import { hasManualCategory, retainManualCategory } from "@/lib/manual-category";

const legacyContract = /^porsche\s*bank\s*[-–—:]?\s*leasing\s+([a-z]{1,3}\d{1,6}[a-z]{1,3})\s*$/i;
const vehicleIdentifier = /\b[a-z]{1,3}\d{1,6}[a-z]{1,3}\b/gi;

// The original workbook abbreviates a Porsche leasing debit to its vehicle
// identifier. A statement receipt has the full bank text/account/reference.
// Pair these representations one for one, never deduplicate by amount/month.
// This only changes the derived ledger; persisted bank facts remain untouched.
// Use the ledger's effective category: older saves may store this debit as
// Sonstiges even though its merchant is correctly classified as Leasing.
export function reconcileLeasingSources<T extends Transaction>(
  rows: T[],
  categoryOf: (row: T) => Transaction["category"],
): T[] {
  const sourceCategory = (row: T) => categoryOf(hasManualCategory(row)
    ? { ...row, category: "Sonstiges", categoryOverride: false, manualCategory: false } : row);
  const key = (row: T, contract: string) => {
    const account = normalizeAccount(row);
    return JSON.stringify([
      row.date, account.bank.trim().toLowerCase(), row.amount.toFixed(2), contract.toUpperCase(),
      isRaiffeisenBank(account.bank) ? account.pocket : null,
    ]);
  };
  const legacy = new Map<string, { indices: number[]; next: number }>();
  const legacyIndices = new Set<number>();
  rows.forEach((row, index) => {
    if (row.amount >= 0 || !/^xlsx-\d+$/.test(row.id) ||
      (row.pocket && !isRaiffeisenMainAccount(row)) || row.bankReference) return;
    const contract = legacyContract.exec(row.description.normalize("NFKC").trim())?.[1];
    if (!contract || sourceCategory(row) !== "Leasing") return;
    const identity = key(row, contract);
    const group = legacy.get(identity) ?? { indices: [], next: 0 };
    group.indices.push(index);
    legacyIndices.add(index);
    legacy.set(identity, group);
  });
  if (!legacy.size) return rows;

  const represented = new Set<number>();
  const reconciled = rows.map((row, rowIndex): T => {
    if (legacyIndices.has(rowIndex) || row.amount >= 0 || (!row.bankReference && !row.pocket)) return row;
    const text = [row.description, row.rawDescription, ...(row.rawDetails ?? [])].filter(Boolean).join(" ").normalize("NFKC");
    if (!/\bporsche\s*bank\b/i.test(text)) return row;
    const contracts = [...new Set((text.match(vehicleIdentifier) ?? []).map((value) => value.toUpperCase()))];
    if (contracts.length !== 1 || sourceCategory(row) !== "Leasing") return row;
    const group = legacy.get(key(row, contracts[0]));
    if (!group || group.next >= group.indices.length) return row;
    const index = group.indices[group.next++];
    represented.add(index);
    const original = rows[index];
    row = retainManualCategory(row, original);
    // Preserve per-booking choices made on the workbook representation first.
    return original.sharedWithRaphael || original.sharedPaidManually ||
      (row.fixedCost === undefined && original.fixedCost !== undefined) ? {
      ...row,
      ...(row.fixedCost === undefined && original.fixedCost !== undefined ? { fixedCost: original.fixedCost } : {}),
      ...(original.sharedWithRaphael ? { sharedWithRaphael: true } : {}),
      ...(original.sharedPaidManually ? { sharedPaidManually: true } : {}),
    } : row;
  });
  return reconciled.filter((_, index) => !represented.has(index));
}
