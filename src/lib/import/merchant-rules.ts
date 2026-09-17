import { classify } from "@/lib/calc";
import { type AppState, type Transaction } from "@/lib/types";
import { ambiguousMerchant, merchantKeyText, recoverMerchant, unresolvedTerminal } from "./merchant-description";
import { payrollCategory } from "@/lib/payroll";
import { canonicalCategory } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";

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
export function isSpecificMerchantKey(key: string): boolean {
  const merchant = key.slice(key.indexOf("|") + 1).trim();
  if (!merchant || unresolvedTerminal(merchant)) return false;
  const provider = merchant.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return !/^(?:paypal(?: europe)?(?: s a r l)?(?: et cie)?(?: s c a)?|revolut(?: epayment| ltd| payments)?|pos|terminal|zahlung|online banking)$/.test(provider);
}
type ClassifyBooking = (row: Transaction) => ReturnType<typeof classify>;
export type MerchantChoice = Pick<Transaction, "category" | "fixedCost">;

function merchantChoices(rows: Transaction[], classifyBooking: ClassifyBooking = classify) {
  const choices = new Map<string, MerchantChoice>();
  for (const row of rows) {
    if (!row.categoryOverride || row.category === "Prüfen" || payrollCategory(row)) continue;
    const key = merchantRuleKey(row);
    if (
      isSpecificMerchantKey(key) &&
      !ambiguousMerchant(row) &&
      !unresolvedTerminal(row.description) &&
      !classifyBooking(row).isTransfer
    ) choices.set(key, {
      ...choices.get(key),
      category: canonicalCategory(row.category),
      ...(row.fixedCost !== undefined && row.amount < 0 && !isIncomeCategory(classifyBooking(row).category)
        ? { fixedCost: row.fixedCost } : {}),
    });
  }
  return choices;
}

export function rememberMerchants(
  state: AppState,
  rows: Transaction[],
): AppState {
  const rules = new Map(
    (state.merchantRules ?? []).map(({ key, ...choice }) => [storedMerchantKey(key),
      { ...choice, category: canonicalCategory(choice.category) }] as const)
      .filter(([key]) => isSpecificMerchantKey(key)),
  );
  const choices = merchantChoices(rows);
  for (const [key, choice] of choices) rules.set(key, { ...rules.get(key), ...choice });
  const applyChoice = (row: Transaction): Transaction => {
    const category = choices.get(merchantRuleKey(row))?.category;
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
          const category = item.merchantKey ? choices.get(storedMerchantKey(item.merchantKey))?.category : undefined;
          return category ? { ...item, category, ...(item.booking ? { booking: applyChoice(item.booking) } : {}) } : item;
        }) } : {}),
        merchantRules: [...rules].map(([key, choice]) => ({ key, ...choice })),
      }
    : state.merchantRules?.length ? { ...state, merchantRules: [] } : state;
}
export function applyMerchantRules(state: AppState, rows: Transaction[]) {
  if (!rows.length) return [];
  return rows.map(createMerchantRuleApplier(state, classify, true));
}

// Build once per operation, including when repairing several legacy POS rows.
// No cross-update cache: newly learned choices must take effect immediately.
export function createMerchantRuleApplier(state: AppState, classifyBooking: ClassifyBooking = classify, applyFixedCost = false) {
  // Inferring rules must not apply them to a discarded copy of the entire ledger.
  const remembered = merchantChoices(state.transactions, classifyBooking);
  const inferred = new Map<string, MerchantChoice>(
    (state.fixedReceipts ?? []).flatMap((receipt) => {
      const key = receipt.merchantKey ? storedMerchantKey(receipt.merchantKey) : undefined;
      return key && isSpecificMerchantKey(key) ? [[key, { category: canonicalCategory(receipt.category) }] as const] : [];
    }),
  );
  const rules = new Map(
    [...remembered].map(([key, choice]) => [storedMerchantKey(key), choice] as const)
      .filter(([key]) => isSpecificMerchantKey(key)),
  );
  for (const rule of state.merchantRules ?? []) {
    const key = storedMerchantKey(rule.key);
    if (isSpecificMerchantKey(key)) rules.set(key, {
      category: canonicalCategory(rule.category),
      ...(rule.fixedCost !== undefined ? { fixedCost: rule.fixedCost } : {}),
    });
  }
  return (source: Transaction): Transaction => {
    const row = recoverMerchant(source);
    const detected = classifyBooking(row);
    if (payrollCategory(row) === detected.category) return { ...row, category: detected.category, includeInPlan: detected.includeInPlan };
    const key = merchantRuleKey(row);
    const choice =
      rules.get(key) ??
      (detected.category === "Prüfen" || detected.category === "Abonnements"
        ? inferred.get(key)
        : undefined);
    return choice && isSpecificMerchantKey(key) && !row.categoryOverride && !detected.isTransfer && !ambiguousMerchant(row) && !unresolvedTerminal(row.description)
      ? { ...row, category: choice.category, categoryOverride: true, includeInPlan: true,
          // Reload/repair must not apply a new booking's checkbox to old twins.
          ...(applyFixedCost && row.fixedCost === undefined && (row.amount < 0 || choice.fixedCost === false) && !isIncomeCategory(choice.category) &&
            choice.fixedCost !== undefined ? { fixedCost: choice.fixedCost } : {}),
        }
      : row;
  };
}
