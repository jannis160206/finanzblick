import { classify } from "@/lib/calc";
import type { Transaction } from "@/lib/types";
import { bankOperation } from "@/lib/bank-operation";

export function hasMerchantRefundEvidence(row: Transaction): boolean {
  return /\b(?:r(?:ü|ue|u)ck(?:erstattung|verguetung|vergütung)|erstattung|refund|retoure)\b/i.test(
    [
      row.description,
      row.rawDescription,
      row.sourceCategory,
      ...(row.rawDetails ?? []),
    ].join(" "),
  );
}

export function isMerchantTransfer(row: Transaction): boolean {
  const operation = bankOperation(row);
  if (operation?.kind === "fee" || operation?.kind === "interest") return false;
  if (operation?.kind === "internal-transfer" || operation?.kind === "external-transfer") return true;
  if (classify(row).isTransfer) return true;
  if (row.amount > 0 && hasMerchantRefundEvidence(row)) return false;
  return (
    /\b(?:konto(?:[uü]|ue)berweisung|sepa[-\s]*(?:[uü]|ue)berweisung|bank[-\s]*transfer|(?:[uü]|ue)berweisung\s+(?:an|von))\b/i.test(
      `${row.description} ${row.rawDescription ?? ""} ${row.sourceCategory ?? ""}`,
    ) ||
    /^(?:(?:[uü]|ue)berweisung|bank transfer|transfer)$/i.test(
      row.sourceCategory ?? "",
    )
  );
}
