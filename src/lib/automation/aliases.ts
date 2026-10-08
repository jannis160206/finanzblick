import {
  isSpecificMerchantKey,
  merchantAliasSourceKey,
  merchantRuleKey,
  storedMerchantKey,
  activeMerchantRules,
} from "@/lib/import/merchant-rules";
import type { AppState, Transaction } from "@/lib/types";

type Choice = NonNullable<AppState["merchantRules"]>[number];
export type AccountMerchantMatch =
  { kind: "matched"; choice: Choice } | { kind: "conflict" } | { kind: "none" };

// These rules live in the tenant snapshot, never in the global merchants table.
export function createAccountMerchantResolver(state: AppState) {
  const choices = new Map<string, Choice | null>();
  for (const rule of activeMerchantRules(state)) {
    const key = storedMerchantKey(rule.key);
    if (!isSpecificMerchantKey(key)) continue;
    const previous = choices.get(key);
    if (previous === null) continue;
    choices.set(
      key,
      rule.category === "Prüfen" ||
        (previous &&
          (previous.category !== rule.category ||
            previous.merchantAlias !== rule.merchantAlias))
        ? null
        : rule,
    );
  }
  return (row: Transaction): AccountMerchantMatch => {
    const source = { ...row, merchantAlias: undefined };
    const key = merchantAliasSourceKey(source) ?? merchantRuleKey(source);
    if (!choices.has(key)) return { kind: "none" };
    const choice = choices.get(key);
    return choice ? { kind: "matched", choice } : { kind: "conflict" };
  };
}
