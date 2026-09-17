import type { Transaction } from "@/lib/types";

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
  const key = (row: T, contract: string) => JSON.stringify([
    row.date, row.bank.trim().toLowerCase(), row.amount.toFixed(2), contract.toUpperCase(),
  ]);
  const legacy = new Map<string, { indices: number[]; next: number }>();
  rows.forEach((row, index) => {
    if (row.amount >= 0 || !/^xlsx-\d+$/.test(row.id) || row.pocket || row.bankReference) return;
    const contract = legacyContract.exec(row.description.normalize("NFKC").trim())?.[1];
    if (!contract || categoryOf(row) !== "Leasing") return;
    const identity = key(row, contract);
    const group = legacy.get(identity) ?? { indices: [], next: 0 };
    group.indices.push(index);
    legacy.set(identity, group);
  });
  if (!legacy.size) return rows;

  const represented = new Set<number>();
  const reconciled = rows.map((row): T => {
    if (row.amount >= 0 || (!row.bankReference && !row.pocket)) return row;
    const text = [row.description, row.rawDescription, ...(row.rawDetails ?? [])].filter(Boolean).join(" ").normalize("NFKC");
    if (!/\bporsche\s*bank\b/i.test(text)) return row;
    const contracts = [...new Set((text.match(vehicleIdentifier) ?? []).map((value) => value.toUpperCase()))];
    if (contracts.length !== 1 || categoryOf(row) !== "Leasing") return row;
    const group = legacy.get(key(row, contracts[0]));
    if (!group || group.next >= group.indices.length) return row;
    const index = group.indices[group.next++];
    represented.add(index);
    const original = rows[index];
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
