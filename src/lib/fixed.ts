import {
  fixedCategories,
  type AppState,
  type Category,
  type FinanceRow,
  type Transaction,
} from "@/lib/types";
import { canonicalCategory, groupedContractCategories, suggestCategory } from "@/lib/categories";
import { normalizeAccount } from "@/lib/accounts";
import { merchantAliasSourceKey, merchantRuleKey } from "@/lib/import/merchant-rules";

const patterns: [Category, RegExp][] = [
  ["Gehalt", /gehalt|lohn/i],
  ["Rufbereitschaft", /rufbereitschaft/i],
  ["Leasing", /leasing|porsche\s*bank/i],
  ["Vollkasko", /vollkasko/i],
  ["Haftpflicht", /haftpflicht|allianz/i],
  ["Handyvertrag", /handy|mobilfunk|\ba1\b|telekom/i],
  ["Apple Care", /apple[\s+-]*care/i],
  ["Barber", /barber|fris[eö]ur/i],
  ["PayPal Abo", /^paypal\s*abo$/i],
  ["AMEX Monatsgebühr", /(?:amex|american express).*(?:monatsgeb|platin)/i],
  ["Spotify", /spotify/i],
];
export const isIncomeCategory = (category: Category) =>
  category === "Gehalt" ||
  category === "Rufbereitschaft" ||
  category === "Einkommen";
export function isFixedExpense(
  row: Pick<Transaction, "category" | "amount" | "fixedCost">,
) {
  return row.amount < 0 && !isIncomeCategory(row.category) &&
    !["Transfer", "Transfer intern"].includes(row.category) &&
    (row.fixedCost ?? fixedCategories.includes(row.category));
}
export function fixedRowCategory(row: FinanceRow): Category | undefined {
  if (row.kind === "variable") return undefined;
  if (row.fixedSource && row.planCategory) return canonicalCategory(row.planCategory);
  if (row.planCategory && fixedCategories.includes(row.planCategory))
    return canonicalCategory(row.planCategory);
  const detected = patterns.find(([, pattern]) => pattern.test(row.label))?.[0] ??
    suggestCategory(row.label) ?? (fixedCategories.includes(row.label as Category) ? row.label as Category : undefined);
  return detected ? canonicalCategory(detected) : undefined;
}
export function matchingFixedRow(state: AppState, category: Category, booking?: Transaction, merchantKey?: string) {
  if (booking?.fixedCost === false && !isIncomeCategory(category)) return;
  const canonical = canonicalCategory(category);
  const sources = state.financeRows.filter((row) => row.kind === "fixed" && row.fixedSource);
  if (booking && sources.length) {
    const sourceKey = merchantAliasSourceKey(booking);
    const key = merchantKey ?? merchantRuleKey(booking);
    const byId = sources.filter((row) => row.fixedSource?.bookingIds.includes(booking.id));
    const samePocket = sources.filter((row) => row.fixedSource?.pocket === normalizeAccount(booking).pocket);
    const bySource = sourceKey ? samePocket.filter((row) => row.fixedSource?.merchantKeys.includes(sourceKey)) : [];
    const linked = byId.length ? byId : bySource.length ? bySource :
      samePocket.filter((row) => row.fixedSource?.merchantKeys.includes(key));
    if (linked.length === 1) return linked[0];
    if (linked.length > 1) return;
  }
  const candidates = state.financeRows.filter(
    (row) =>
      !row.fixedSource &&
      row.kind === (isIncomeCategory(canonical) ? "income" : "fixed") &&
      (fixedRowCategory(row) === canonical || row.label === canonical),
  );
  // Legacy contract labels remain separate budget positions, even though the
  // ledger now groups them under one category. Never take the first insurance.
  const legacy = patterns.find(([name]) => name === category && name !== canonical);
  if (legacy) return candidates.find((row) => legacy[1].test(row.label));
  if (!groupedContractCategories.includes(canonical)) {
    if (booking?.fixedCost === true) {
      const known = new Set((state.fixedReceipts ?? []).filter((item) =>
        item.rowId && ((merchantKey && item.merchantKey === merchantKey) ||
          item.booking?.id === booking.id)).map((item) => item.rowId));
      const text = [booking.description, booking.merchantAlias, booking.rawDescription].filter(Boolean).join(" ").toLocaleLowerCase("de");
      return candidates.find((row) => known.has(row.id) || row.label === canonical ||
        text.includes(row.label.toLocaleLowerCase("de")));
    }
    return candidates[0];
  }
  if (booking) {
    const knownIds = new Set((state.fixedReceipts ?? []).filter((item) =>
      item.rowId && ((merchantKey && item.merchantKey === merchantKey) ||
        (item.booking?.bank === booking.bank && item.booking.description === booking.description)),
    ).map((item) => item.rowId));
    const known = candidates.filter((row) => knownIds.has(row.id));
    if (known.length === 1) return known[0];
    if (known.length > 1) return;
    const text = [booking.description, booking.rawDescription, ...(booking.rawDetails ?? []), booking.sourceCategory].filter(Boolean).join(" ");
    const contracts = patterns.filter(([name, pattern]) => canonicalCategory(name) === canonical && pattern.test(text));
    const matches = candidates.filter((row) => contracts.some(([, pattern]) => pattern.test(row.label)) ||
      (row.label !== canonical && text.toLocaleLowerCase("de").includes(row.label.toLocaleLowerCase("de"))) ||
      (canonical === "Versicherungen" && /paypal\s+europe|apple\.com\/bill/i.test(booking.description) &&
        /apple[\s+-]*care/i.test(row.label) && row.values[booking.date.slice(0, 7)] != null &&
        Math.abs(Math.abs(booking.amount) - row.values[booking.date.slice(0, 7)]!) <= 0.05));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return;
  }
  // A deliberately generic single budget is valid; unrelated named contracts are not.
  return candidates.length === 1 && candidates[0].label === canonical ? candidates[0] : undefined;
}
