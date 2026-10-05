import type { Transaction } from "@/lib/types";

type NamedBooking = Pick<Transaction, "description"> &
  Partial<Pick<Transaction, "rawDescription" | "merchantAlias">>;

export function isNamedTransfer(row: NamedBooking): boolean {
  // Merchant text only: cardholder headers in OCR details are not transfer names.
  return [row.description, row.rawDescription, row.merchantAlias].some((value) => {
    const text = (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return /einzahlung|transfer/.test(text) ||
      /\b(?:jannis bru(?:e)?hl|bru(?:e)?hl jannis)\b/.test(text);
  });
}

export function applyNamedTransfer<T extends NamedBooking & Partial<Pick<Transaction,
  "category" | "includeInPlan" | "fixedCost" | "sharedWithRaphael" | "sharedPaidManually">>>(row: T): T {
  if (!isNamedTransfer(row)) return row;
  if (row.category === "Transfer" && row.includeInPlan === false &&
    !row.fixedCost && !row.sharedWithRaphael && !row.sharedPaidManually) return row;
  return { ...row, category: "Transfer", includeInPlan: false,
    ...(row.fixedCost !== undefined ? { fixedCost: false } : {}),
    ...(row.sharedWithRaphael !== undefined ? { sharedWithRaphael: false } : {}),
    ...(row.sharedPaidManually !== undefined ? { sharedPaidManually: false } : {}),
  };
}
