import { classify } from "@/lib/calc";
import type { Transaction } from "@/lib/types";

export function isMerchantTransfer(row: Transaction): boolean {
  if (classify(row).isTransfer) return true;
  if (
    row.amount > 0 &&
    /\b(?:r[üu]ckerstattung|erstattung|refund|retoure|gutschrift)\b/i.test(
      row.description,
    )
  )
    return false;
  return (
    /\b(?:konto(?:[uü]|ue)berweisung|sepa[-\s]*(?:[uü]|ue)berweisung|bank[-\s]*transfer|(?:[uü]|ue)berweisung\s+(?:an|von))\b/i.test(
      `${row.description} ${row.rawDescription ?? ""} ${row.sourceCategory ?? ""}`,
    ) ||
    /^(?:(?:[uü]|ue)berweisung|bank transfer|transfer)$/i.test(
      row.sourceCategory ?? "",
    )
  );
}
