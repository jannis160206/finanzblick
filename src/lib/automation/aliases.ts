import {
  isSpecificMerchantKey,
  merchantAliasSourceKey,
  merchantRuleKey,
  storedMerchantKey,
  activeMerchantRules,
} from "@/lib/import/merchant-rules";
import type { AppState, Transaction } from "@/lib/types";
import { normalizeMerchantDescriptor } from "./merchants";
import { mergeConfirmedMerchantChoices } from "@/lib/import/merchant-choice";

type Choice = NonNullable<AppState["merchantRules"]>[number];
export type AccountMerchantMatch =
  | { kind: "matched"; choice: Choice; normalized?: true }
  | { kind: "conflict" }
  | { kind: "none" };

function normalizedKey(key: string): string | undefined {
  const divider = key.indexOf("|");
  if (divider < 1) return;
  const text = normalizeMerchantDescriptor(key.slice(divider + 1));
  return text && isSpecificMerchantKey(`${key.slice(0, divider)}|${text}`)
    ? `${key.slice(0, divider)}|${text}`
    : undefined;
}

function addChoice(
  choices: Map<string, Choice | null>,
  key: string,
  rule: Choice,
): void {
  const previous = choices.get(key);
  if (previous === null) return;
  choices.set(key, mergeConfirmedMerchantChoices(previous, rule));
}

// These rules live in the tenant snapshot, never in the global merchants table.
export function createAccountMerchantResolver(state: AppState) {
  const choices = new Map<string, Choice | null>();
  const normalized = new Map<string, Choice | null>();
  for (const rule of activeMerchantRules(state)) {
    const key = storedMerchantKey(rule.key);
    if (!isSpecificMerchantKey(key)) continue;
    addChoice(choices, key, rule);
    const normalizedSource = normalizedKey(key);
    if (normalizedSource) addChoice(normalized, normalizedSource, rule);
  }
  return (row: Transaction): AccountMerchantMatch => {
    const source = { ...row, merchantAlias: undefined };
    const key = merchantAliasSourceKey(source) ?? merchantRuleKey(source);
    if (choices.has(key)) {
      const choice = choices.get(key);
      return choice ? { kind: "matched", choice } : { kind: "conflict" };
    }
    const cleaned = normalizedKey(key);
    if (!cleaned || !normalized.has(cleaned)) return { kind: "none" };
    const choice = normalized.get(cleaned);
    if (!choice) return { kind: "conflict" };
    return choice.merchantAlias
      ? { kind: "matched", choice, normalized: true }
      : { kind: "none" };
  };
}
