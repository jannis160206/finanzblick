import type { classify } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { isMerchantTransfer } from "@/lib/merchant-transfer";
import type { Transaction } from "@/lib/types";

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
) {
  return !(
    classification.isTransfer ||
    isMerchantTransfer(booking) ||
    transferCategories.includes(booking.category) ||
    transferCategories.includes(classification.category) ||
    (!booking.merchantAlias?.trim() &&
      isIncomeCategory(classification.category))
  );
}
