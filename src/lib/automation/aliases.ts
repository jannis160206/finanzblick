import {
  isSpecificMerchantKey,
  merchantAliasSourceKey,
  merchantRuleKey,
  storedMerchantKey,
  activeMerchantRules,
  createMerchantNameApplier,
} from "@/lib/import/merchant-rules";
import { canonicalCategory, type Category } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";
import { hasCategoryChoice } from "@/lib/manual-category";
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

export const unlearnableCategories: ReadonlySet<Category> = new Set([
  "Prüfen",
  "Sonstiges",
  "Rückerstattungen",
  "Transfer",
  "Transfer intern",
  "Urlaub",
]);

function historyKeys(row: Transaction): string[] {
  return [
    ...new Set(
      [merchantAliasSourceKey(row), merchantRuleKey(row)].filter(
        (key): key is string => key !== undefined && isSpecificMerchantKey(key),
      ),
    ),
  ];
}

// A descriptor the account has already settled the same way, without a
// contradicting booking, is evidence for further bookings of that descriptor.
// User decisions count double; earlier history inferences never count again.
export function createHistoryResolver(state: AppState) {
  const groups = new Map<string, { categories: Set<Category>; weight: number }>();
  for (const row of [
    ...state.transactions,
    ...(state.fixedReceipts ?? []).flatMap((item) => (item.booking ? [item.booking] : [])),
  ]) {
    const category = canonicalCategory(row.category);
    if (row.amount >= 0 || unlearnableCategories.has(category) || isIncomeCategory(category))
      continue;
    const weight = hasCategoryChoice(row)
      ? 2
      : row.requires_manual_review === false &&
          row.automaticCategoryEvidence &&
          ["merchant", "purpose", "mcc"].includes(row.automaticCategoryEvidence.method)
        ? 1
        : 0;
    if (!weight) continue;
    for (const key of historyKeys(row)) {
      const group = groups.get(key) ?? { categories: new Set<Category>(), weight: 0 };
      group.categories.add(category);
      group.weight += weight;
      groups.set(key, group);
    }
  }
  return (row: Transaction): Category | undefined => {
    const matched = historyKeys(row).flatMap((key) => groups.get(key) ?? []);
    const categories = new Set(matched.flatMap((group) => [...group.categories]));
    if (categories.size !== 1 || Math.max(0, ...matched.map((group) => group.weight)) < 2)
      return;
    return [...categories][0];
  };
}

// These rules live in the tenant snapshot, never in the global merchants table.
export function createAccountMerchantResolver(state: AppState) {
  const applyName = createMerchantNameApplier(state);
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
    const renamed = applyName(row);
    const source = { ...row, merchantAlias: undefined };
    const key = merchantAliasSourceKey(source) ?? merchantRuleKey(source);
    if (choices.has(key)) {
      const choice = choices.get(key);
      return choice ? {
        kind: "matched",
        choice: renamed !== row ? { ...choice, merchantAlias: renamed.merchantAlias } : choice,
      } : { kind: "conflict" };
    }
    const cleaned = normalizedKey(key);
    if (!cleaned || !normalized.has(cleaned)) return renamed !== row ? {
      kind: "matched",
      choice: { key, category: "Prüfen", identityOnly: true, merchantAlias: renamed.merchantAlias },
    } : { kind: "none" };
    const choice = normalized.get(cleaned);
    if (!choice) return { kind: "conflict" };
    return choice.merchantAlias
      ? {
        kind: "matched",
        choice: renamed !== row ? { ...choice, merchantAlias: renamed.merchantAlias } : choice,
        normalized: true,
      }
      : { kind: "none" };
  };
}
