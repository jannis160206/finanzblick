import type { Transaction } from "@/lib/types";
import { isRaiffeisenBank, normalizeAccount } from "@/lib/accounts";

type Identity = Pick<Transaction, "date" | "bank" | "amount" | "description"> &
  Partial<Pick<Transaction, "pocket" | "bankReference" | "occurrence" | "rawDescription">>;
const clean = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const bankName = (bank: string) =>
  clean(normalizeAccount({ bank, pocket: null }).bank).replace(/^american express$/, "amex");

export function isAmexScreenshot(row: Pick<Transaction, "bank" | "rawDetails">): boolean {
  return bankName(row.bank) === "amex" && !!row.rawDetails?.includes("Amex-Screenshot");
}

export function amexBookingKey(row: Identity): string | null {
  if (bankName(row.bank) !== "amex") return null;
  if (!["", "amex", "amex jannis"].includes(clean(row.pocket ?? ""))) return null;
  // Retain order codes. Only common glyph confusions within a code are equivalent;
  // unrelated equal-price orders and named secondary cardholders stay distinct.
  const merchant = (row.rawDescription ?? row.description)
    .replace(/\b(AMAZON\.[A-Z.]+|AIRBNB)\s*\*\s*([A-Z0-9]+)/gi,
      (_, merchant: string, code: string) => `${merchant}*${code.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0")}`)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return merchant ? JSON.stringify([row.date.slice(0, 10), row.amount.toFixed(2), merchant]) : null;
}
export function legacyFingerprint(row: Identity) {
  return JSON.stringify([
    row.date.slice(0, 10),
    bankName(row.bank),
    row.amount.toFixed(2),
    clean(row.rawDescription ?? row.description).slice(0, 25),
  ]);
}
export function statementBaseKey(row: Identity) {
  const account = normalizeAccount({ bank: row.bank, pocket: row.pocket ?? null });
  return JSON.stringify([
    row.date.slice(0, 10),
    bankName(account.bank),
    account.pocket ?? "",
    row.amount.toFixed(2),
    row.bankReference ? `ref:${row.bankReference}` : clean(row.rawDescription ?? row.description),
  ]);
}
export function statementFingerprint(row: Identity) {
  return `${statementBaseKey(row)}|${row.bankReference ? 1 : (row.occurrence ?? 1)}`;
}
export function normalizeStatementKey(key: string): string {
  const match = key.match(/^(\[[\s\S]*\])(\|[1-9]\d*)?$/);
  if (!match) return key;
  try {
    const parts: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parts) || !parts.every((part) => typeof part === "string")) return key;
    if (!isRaiffeisenBank(parts[1] ?? "")) return key;
    if (parts.length === 5 && match[2]) {
      const account = normalizeAccount({ bank: parts[1], pocket: parts[2] || null });
      parts[1] = bankName(account.bank);
      parts[2] = account.pocket ?? "";
    } else if (parts.length === 4 && !match[2]) {
      parts[1] = bankName(parts[1]);
    } else return key;
    return JSON.stringify(parts) + (match[2] ?? "");
  } catch (error) {
    if (error instanceof SyntaxError) return key;
    throw error;
  }
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
