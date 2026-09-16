import { classify } from "@/lib/calc";
import { type AppState, type Transaction } from "@/lib/types";
import { merchantKeyText, recoverMerchant, unresolvedTerminal } from "./merchant-description";
import { payrollCategory } from "@/lib/payroll";
import { canonicalCategory } from "@/lib/categories";

// Retain merchant words and subscription identifiers. Do not learn a blanket
// "PayPal" rule that would silently assign unrelated merchants.
export function merchantRuleKey(
  row: Pick<Transaction, "bank" | "description">,
) {
  const text = merchantKeyText(recoverMerchant(row).description);
  const mandate = /mandat(?:sreferenz)?:\s*([^,;\s]+)/i.exec(text)?.[1];
  const merchant = mandate
    ? `mandat:${mandate}`
    : text
        .replace(
          /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
          " ",
        )
        .replace(/\b(?:kartenzahlung|pos|zahlung|debit|sepa)\b/g, " ")
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
        .replace(/\b\d{5,}\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
  const bank = row.bank
    .trim()
    .toLowerCase()
    .replace(/^american express$/, "amex");
  return `${bank}|${merchant}`;
}
export function storedMerchantKey(key: string): string {
  const divider = key.indexOf("|");
  return divider < 0 ? key : merchantRuleKey({ bank: key.slice(0, divider), description: key.slice(divider + 1) });
}
export function rememberMerchants(
  state: AppState,
  rows: Transaction[],
): AppState {
  const rules = new Map(
    (state.merchantRules ?? []).map((rule) => [storedMerchantKey(rule.key), canonicalCategory(rule.category)]),
  );
  const choices = new Map<string, Transaction["category"]>();
  for (const row of rows)
    if (
      row.categoryOverride &&
      row.category !== "Prüfen" &&
      !payrollCategory(row) &&
      !unresolvedTerminal(row.description) &&
      !classify(row).isTransfer
    ) {
      rules.set(merchantRuleKey(row), canonicalCategory(row.category));
      choices.set(merchantRuleKey(row), canonicalCategory(row.category));
    }
  const applyChoice = (row: Transaction): Transaction => {
    const category = choices.get(merchantRuleKey(row));
    if (!category) return row;
    const updated = { ...row, category, categoryOverride: true, includeInPlan: true };
    const result = classify(updated);
    return { ...updated, category: result.category, includeInPlan: result.includeInPlan };
  };
  return rules.size
    ? {
        ...state,
        transactions: state.transactions.map(applyChoice),
        ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) => {
          const category = item.merchantKey ? choices.get(storedMerchantKey(item.merchantKey)) : undefined;
          return category ? { ...item, category, ...(item.booking ? { booking: applyChoice(item.booking) } : {}) } : item;
        }) } : {}),
        merchantRules: [...rules].map(([key, category]) => ({ key, category })),
      }
    : state;
}
export function applyMerchantRules(state: AppState, rows: Transaction[]) {
  if (!rows.length) return [];
  return rows.map(createMerchantRuleApplier(state));
}

// Build once per operation, including when repairing several legacy POS rows.
// No cross-update cache: newly learned choices must take effect immediately.
export function createMerchantRuleApplier(state: AppState) {
  const remembered = rememberMerchants(
    { ...state, merchantRules: undefined },
    state.transactions,
  );
  const inferred = new Map(
    (state.fixedReceipts ?? []).flatMap((receipt) =>
      receipt.merchantKey
        ? [[storedMerchantKey(receipt.merchantKey), canonicalCategory(receipt.category)] as const]
        : [],
    ),
  );
  const rules = new Map(
    [...(remembered.merchantRules ?? []), ...(state.merchantRules ?? [])].map(
      (rule) => [storedMerchantKey(rule.key), canonicalCategory(rule.category)],
    ),
  );
  return (source: Transaction): Transaction => {
    const row = recoverMerchant(source);
    const detected = classify(row);
    if (payrollCategory(row) === detected.category) return { ...row, category: detected.category, includeInPlan: detected.includeInPlan };
    const key = merchantRuleKey(row);
    const category =
      rules.get(key) ??
      (detected.category === "Prüfen" || detected.category === "Abonnements"
        ? inferred.get(key)
        : undefined);
    return category && !row.categoryOverride && !detected.isTransfer && !unresolvedTerminal(row.description)
      ? { ...row, category, categoryOverride: true, includeInPlan: true }
      : row;
  };
}
