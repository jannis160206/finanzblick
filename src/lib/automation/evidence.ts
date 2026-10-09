import {
  ambiguousMerchant,
  merchantCandidates,
  namedMerchantTexts,
  recoverMerchant,
} from "@/lib/import/merchant-description";
import type { Transaction } from "@/lib/types";
import { MerchantIndex, normalizeMerchantDescriptor } from "./merchants";

export function merchantEvidence(
  row: Transaction,
  index: MerchantIndex,
): { kind: "consistent"; text: string } | { kind: "conflict" } {
  const names = namedMerchantTexts(row);
  const candidates = names.length
    ? names
    : ambiguousMerchant(row)
      ? merchantCandidates(row)
      : [];
  if (candidates.length) {
    const normalized = new Set(candidates.map(normalizeMerchantDescriptor));
    if (normalized.has("")) return { kind: "conflict" };
    const matches = candidates.map((text) => index.match(text));
    if (
      normalized.size > 1 &&
      !matches.every(
        (match) =>
          match.merchant &&
          (match.method === "exact" || match.method === "regex") &&
          match.merchant.id === matches[0].merchant?.id,
      )
    )
      return { kind: "conflict" };
    if (names.length) {
      const description = index.match(row.description);
      const named = matches[0];
      if (
        description.merchant &&
        named.merchant &&
        description.merchant.id !== named.merchant.id
      )
        return { kind: "conflict" };
      if (
        description.requiresManualReview &&
        description.method !== "none" &&
        !description.merchant
      )
        return { kind: "conflict" };
    }
    return { kind: "consistent", text: candidates[0] };
  }
  return { kind: "consistent", text: recoverMerchant(row).description };
}
