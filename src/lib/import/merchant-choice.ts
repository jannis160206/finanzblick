import type { AppState } from "@/lib/types";

type MerchantRule = NonNullable<AppState["merchantRules"]>[number];
const sameName = (left: string, right: string) =>
  left
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("de-AT")
    .replace(/\s+/g, " ") ===
  right
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("de-AT")
    .replace(/\s+/g, " ");

export function mergeConfirmedMerchantChoices(
  previous: MerchantRule | undefined,
  next: MerchantRule,
): MerchantRule | null {
  if (
    (!next.identityOnly && next.category === "Prüfen") ||
    (previous && !previous.identityOnly && previous.category === "Prüfen")
  )
    return null;
  if (!previous) return next;
  if (
    (previous.merchantAlias &&
      next.merchantAlias &&
      !sameName(previous.merchantAlias, next.merchantAlias)) ||
    (!previous.identityOnly &&
      !next.identityOnly &&
      previous.category !== next.category) ||
    (previous.fixedCost !== undefined &&
      next.fixedCost !== undefined &&
      previous.fixedCost !== next.fixedCost)
  )
    return null;
  const category = !next.identityOnly ? next.category : previous.category;
  const identityOnly = !!(previous.identityOnly && next.identityOnly);
  return {
    ...previous,
    ...next,
    category,
    identityOnly: identityOnly || undefined,
    merchantAlias: next.merchantAlias ?? previous.merchantAlias,
    fixedCost: next.fixedCost ?? previous.fixedCost,
  };
}
