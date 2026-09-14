import type { Transaction } from "@/lib/types";

type Identity = Pick<Transaction, "date" | "bank" | "amount" | "description"> &
  Partial<Pick<Transaction, "pocket" | "bankReference" | "occurrence" | "rawDescription">>;
const clean = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const bankName = (bank: string) =>
  clean(bank).replace(/^american express$/, "amex");
export function legacyFingerprint(row: Identity) {
  return JSON.stringify([
    row.date.slice(0, 10),
    bankName(row.bank),
    row.amount.toFixed(2),
    clean(row.rawDescription ?? row.description).slice(0, 25),
  ]);
}
export function statementBaseKey(row: Identity) {
  return JSON.stringify([
    row.date.slice(0, 10),
    bankName(row.bank),
    row.pocket ?? "",
    row.amount.toFixed(2),
    row.bankReference ? `ref:${row.bankReference}` : clean(row.rawDescription ?? row.description),
  ]);
}
export function statementFingerprint(row: Identity) {
  return `${statementBaseKey(row)}|${row.bankReference ? 1 : (row.occurrence ?? 1)}`;
}
export function numberStatementRows<T extends Transaction>(rows: T[]): T[] {
  const counts = new Map<string, number>();
  return rows.map((row) => {
    const key = statementBaseKey(row);
    const occurrence = (counts.get(key) ?? 0) + 1;
    counts.set(key, occurrence);
    return {
      ...row,
      occurrence: row.occurrence ?? (row.bankReference ? 1 : occurrence),
    };
  });
}
