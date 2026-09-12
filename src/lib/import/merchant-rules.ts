import { classify } from "@/lib/calc";
import { type AppState, type Transaction } from "@/lib/types";

// Retain merchant words and subscription identifiers. Do not learn a blanket
// "PayPal" rule that would silently assign unrelated merchants.
export function merchantRuleKey(
  row: Pick<Transaction, "bank" | "description">,
) {
  const text = row.description.normalize("NFKC").toLocaleLowerCase("de-AT");
  const mandate = /mandat(?:sreferenz)?:\s*([^,;\s]+)/i.exec(text)?.[1];
  const merchant = mandate
    ? `mandat:${mandate}`
    : text
        .replace(
          /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
          " ",
        )
        .replace(/\b(?:kartenzahlung|pos|zahlung|debit|sepa)\b/g, " ")
        .replace(/\b\d{5,}\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
  const bank = row.bank
    .trim()
    .toLowerCase()
    .replace(/^american express$/, "amex");
  return `${bank}|${merchant}`;
}
export function rememberMerchants(
  state: AppState,
  rows: Transaction[],
): AppState {
  const rules = new Map(
    (state.merchantRules ?? []).map((rule) => [rule.key, rule.category]),
  );
  for (const row of rows)
    if (
      row.categoryOverride &&
      row.category !== "Prüfen" &&
      !classify(row).isTransfer
    )
      rules.set(merchantRuleKey(row), row.category);
  return rules.size
    ? {
        ...state,
        merchantRules: [...rules].map(([key, category]) => ({ key, category })),
      }
    : state;
}
export function applyMerchantRules(state: AppState, rows: Transaction[]) {
  const remembered = rememberMerchants(
    { ...state, merchantRules: undefined },
    state.transactions,
  );
  const inferred = new Map(
    (state.fixedReceipts ?? []).flatMap((receipt) =>
      receipt.merchantKey
        ? [[receipt.merchantKey, receipt.category] as const]
        : [],
    ),
  );
  const rules = new Map(
    [...(remembered.merchantRules ?? []), ...(state.merchantRules ?? [])].map(
      (rule) => [rule.key, rule.category],
    ),
  );
  return rows.map((row) => {
    const detected = classify(row);
    const key = merchantRuleKey(row);
    const category =
      rules.get(key) ??
      (detected.category === "Prüfen" || detected.category === "PayPal Abo"
        ? inferred.get(key)
        : undefined);
    return category && !row.categoryOverride && !detected.isTransfer
      ? { ...row, category, categoryOverride: true, includeInPlan: true }
      : row;
  });
}
