import {
  fixedCategories,
  type AppState,
  type Category,
  type FinanceRow,
} from "@/lib/types";

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
export function fixedRowCategory(row: FinanceRow): Category | undefined {
  if (row.kind === "variable") return undefined;
  if (row.planCategory && fixedCategories.includes(row.planCategory))
    return row.planCategory;
  return patterns.find(([, pattern]) => pattern.test(row.label))?.[0];
}
export function matchingFixedRow(state: AppState, category: Category) {
  return state.financeRows.find(
    (row) =>
      row.kind === (isIncomeCategory(category) ? "income" : "fixed") &&
      (fixedRowCategory(row) === category || row.label === category),
  );
}
