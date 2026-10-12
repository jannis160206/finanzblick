import type { classify } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { isMerchantTransfer } from "@/lib/merchant-transfer";
import type { Transaction } from "@/lib/types";
import { bankOperation } from "@/lib/bank-operation";

export type MarkClassification = Pick<
  ReturnType<typeof classify>,
  "category" | "isTransfer"
>;

const transferCategories = [
  "Transfer",
  "Transfer intern",
  "Kontoüberweisung",
  "Interne Umbuchung",
];

export function shouldShowMerchantMark(
  booking: Transaction,
  classification: MarkClassification,
  suppliedLogo = false,
) {
  return !(
    classification.isTransfer ||
    bankOperation(booking)?.kind === "fee" ||
    bankOperation(booking)?.kind === "interest" ||
    isMerchantTransfer(booking) ||
    transferCategories.includes(booking.category) ||
    transferCategories.includes(classification.category) ||
    (!booking.merchantAlias?.trim() &&
      isIncomeCategory(classification.category) &&
      !suppliedLogo)
  );
}
