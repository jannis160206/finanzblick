import type { classify } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { isMerchantTransfer } from "@/lib/merchant-transfer";
import type { Transaction } from "@/lib/types";
import { bankOperation } from "@/lib/bank-operation";
import { isAtmBooking } from "@/lib/atm-logo";

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
  if (isAtmBooking(booking)) return true;
  const operation = bankOperation(booking);
  return !(
    classification.isTransfer ||
    (!suppliedLogo &&
      (operation?.kind === "fee" ||
        operation?.kind === "interest" ||
        classification.category === "Bankgebühren" ||
        classification.category === "Rücklastschriftgebühren")) ||
    isMerchantTransfer(booking, classification) ||
    transferCategories.includes(booking.category) ||
    transferCategories.includes(classification.category) ||
    (!booking.merchantAlias?.trim() &&
      isIncomeCategory(classification.category) &&
      !suppliedLogo)
  );
}
