import { fixedCategories, type AppState, type Category, type FinanceRow, type HolidayRange } from "@/lib/types";
import { canonicalCategory, isTravelCategory } from "@/lib/categories";
import { lunchBudget } from "@/lib/holidays-at-kaernten";
import { isIncomeCategory } from "@/lib/fixed";

const gifts = [50, 50, 0, 50, 100, 0, 50, 50, 0, 0, 100, 1000] as const;
export type VariableBudgetId = "food" | "lunch" | "fuel" | "leisure" | "going-out" | "gifts" | "buffer";
export const variableBudgetLines: { id: VariableBudgetId; label: string; category?: Category; pattern: RegExp; amount: number | "lunch" | "gifts" }[] = [
  { id: "food", label: "Lebensmittel & Haushalt", category: "Lebensmittel", pattern: /lebensmittel/i, amount: 250 },
  { id: "lunch", label: "Mittagessen", category: "Mittagessen", pattern: /mittag/i, amount: "lunch" },
  { id: "fuel", label: "Tanken", category: "Mobilität", pattern: /tanken/i, amount: 180 },
  { id: "leisure", label: "Freizeit", category: "Freizeit", pattern: /g2a|apple.guthaben|^freizeit$/i, amount: 20 },
  { id: "going-out", label: "Restaurants & Lieferdienste", category: "Restaurants", pattern: /ausgehen|restaurant/i, amount: 250 },
  { id: "gifts", label: "Geschenke & Spenden", category: "Geschenke & Spenden", pattern: /geschenk|spenden/i, amount: "gifts" },
  { id: "buffer", label: "Giro Puffer", pattern: /giro[\s-]*puffer/i, amount: 100 },
];
const categoryBudgets: Partial<Record<Category, VariableBudgetId>> = {
  "Lebensmittel": "food",
  "Drogerie": "food",
  "Wohnen & Haushalt": "food",
  "Mittagessen": "lunch",
  "Mobilität": "fuel",
  "Tanken": "fuel",
  "Freizeit": "leisure",
  "Guthabenkarten": "leisure",
  "Entertainment": "leisure",
  "Sport & Fitness": "leisure",
  "Bildung": "leisure",
  "Weiterbildung": "leisure",
  "Restaurants": "going-out",
  "Lieferdienste": "going-out",
  "Cafés & Snacks": "going-out",
  "Geschenke & Spenden": "gifts",
};
export function variableBudgetId(category: Category, fixedCost?: boolean): VariableBudgetId | undefined {
  category = canonicalCategory(category);
  if (fixedCost === true || isIncomeCategory(category) ||
    (fixedCost !== false && fixedCategories.includes(category)) || isTravelCategory(category) ||
    category === "Transfer" || category === "Transfer intern" || category === "Prüfen") return;
  // Detailed non-fuel mobility and larger household purchases use the buffer,
  // not a new plan line or a redefinition of the grocery and fuel allowances.
  return categoryBudgets[category] ?? "buffer";
}
const matches = (row: FinanceRow, line: typeof variableBudgetLines[number]) => row.kind === "variable" &&
  (row.id === `budget-${line.id}` || (line.category !== undefined && row.planCategory !== undefined &&
    canonicalCategory(row.planCategory) === line.category) || line.pattern.test(row.label));
const amountFor = (line: typeof variableBudgetLines[number], month: string, ranges: readonly HolidayRange[]) =>
  line.amount === "lunch" ? lunchBudget(month, ranges).total : line.amount === "gifts" ? gifts[Number(month.slice(5, 7)) - 1] : line.amount;

export function monthlyVariableBudget(month: string, ranges: readonly HolidayRange[] = []) {
  const rows = variableBudgetLines.map((line) => ({ id: line.id, label: line.label, category: line.category, total: amountFor(line, month, ranges) }));
  return { currentMonth: month, rows, total: rows.reduce((total, row) => total + row.total, 0), lunch: lunchBudget(month, ranges) };
}

export function variableBudgetValue(row: FinanceRow, month: string, ranges: readonly HolidayRange[] = []): number {
  const line = variableBudgetLines.find((line) => matches(row, line));
  return line ? amountFor(line, month, ranges) : 0;
}

export function applyVariableBudgets(state: AppState): AppState {
  const currentMonth = state.settings.asOf.slice(0, 7);
  const months = [2026, 2027].flatMap((year) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`))
    .filter((month) => month >= currentMonth);
  const used = new Set<string>();
  const reservedIds = new Set(state.financeRows.map((row) => row.id));
  const variableRows: FinanceRow[] = variableBudgetLines.map((line) => {
    const old = state.financeRows.find((row) => !used.has(row.id) && matches(row, line));
    if (old) used.add(old.id);
    const values = { ...old?.values };
    const overrides = Object.fromEntries(Object.entries(old?.overrides ?? {}).filter(([month]) => month < currentMonth));
    for (const month of months) values[month] = amountFor(line, month, state.holidayRanges ?? []);
    let id = old?.id ?? `budget-${line.id}`;
    if (!old) {
      let suffix = 1;
      while (reservedIds.has(id)) id = `budget-${line.id}-${suffix++}`;
      reservedIds.add(id);
    }
    return { id, label: line.label, kind: "variable",
      ...(line.category ? { planCategory: line.category } : {}), values,
      ...(Object.keys(overrides).length ? { overrides } : {}),
    };
  });
  return { ...state,
    financeRows: [...state.financeRows.filter((row) => row.kind !== "variable"), ...variableRows],
    months: Object.fromEntries(Object.entries(state.months).map(([month, input]) => [month,
      month >= currentMonth && input.variableOverride !== null ? { ...input, variableOverride: null } : input])),
  };
}
