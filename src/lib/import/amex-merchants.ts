import type { Category, Transaction } from "@/lib/types";

export function amexMerchantCategory(row: Pick<Transaction, "description" | "amount"> & Partial<Pick<Transaction, "bank">>): Category | undefined {
  if (!row.bank || !/^(?:amex|american express)$/i.test(row.bank.trim())) return;
  if (/^m(?:ü|ue)ller\s+\d+\b/i.test(row.description)) return "Drogerie";
  if (/^(?:mollie\s*[=/]\s*)?tapeso\b/i.test(row.description)) return "Wohnen & Haushalt";
  if (row.amount > 0 && /^entertainment\s+gutschrift\s*$/i.test(row.description)) return "Entertainment";
}
