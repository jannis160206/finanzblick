import { calculatePlan, monthKey, monthsForYear } from "@/lib/calc";
import { variableCategories, type AppState, type Category } from "@/lib/types";
import { repairKnownPlanningOverrides } from "@/lib/legacy-source";

export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
const automaticLines: { label: string; category: Category; pattern: RegExp }[] =
  [
    {
      label: "Lebensmittel",
      category: "Lebensmittel",
      pattern: /lebensmittel/i,
    },
    { label: "Mittagessen", category: "Mittagessen", pattern: /mittag/i },
    { label: "Tanken", category: "Mobilität", pattern: /tanken/i },
    { label: "G2A", category: "Freizeit", pattern: /g2a|apple.guthaben/i },
    {
      label: "Ausgehen",
      category: "Ausgehen",
      pattern: /ausgehen|essen.*restaurant/i,
    },
  ];

export function synchronizePlan(state: AppState): AppState {
  state = repairKnownPlanningOverrides(state);
  const plan = calculatePlan(state.transactions, state.settings.asOf);
  const months = [...monthsForYear(2026), ...monthsForYear(2027)].filter(
    (month) => month >= monthKey(state.settings.asOf),
  );
  const financeRows = [...state.financeRows];
  const lines = [...automaticLines];
  for (const category of variableCategories)
    if (
      !lines.some((line) => line.category === category) &&
      (plan.byCategory.some((line) => line.category === category) ||
        financeRows.some(
          (row) => row.kind === "variable" && row.planCategory === category,
        ))
    )
      lines.push({
        label: category,
        category,
        pattern: new RegExp(`^${category}$`, "i"),
      });
  for (const line of lines) {
    const index = financeRows.findIndex(
      (row) =>
        row.kind === "variable" &&
        (row.planCategory === line.category || line.pattern.test(row.label)),
    );
    const row =
      index >= 0
        ? financeRows[index]
        : {
            id: `auto-${line.category}`,
            label: line.label,
            kind: "variable" as const,
            values: {},
          };
    const total =
      plan.byCategory.find((item) => item.category === line.category)?.total ??
      0;
    const values = { ...row.values };
    for (const month of months) values[month] = row.overrides?.[month] ?? total;
    const updated = { ...row, planCategory: line.category, values };
    if (index < 0) financeRows.push(updated);
    else financeRows[index] = updated;
  }
  return { ...state, financeRows };
}

export function refreshPlanning(
  state: AppState,
  today = localToday(),
): AppState {
  // The workbook's supported horizon and the actual-balance baseline remain authoritative.
  const asOf = [
    state.settings.baselineDate,
    today < "2026-01-01"
      ? "2026-01-01"
      : today > "2027-12-31"
        ? "2027-12-31"
        : today,
  ]
    .sort()
    .at(-1)!;
  return synchronizePlan({ ...state, settings: { ...state.settings, asOf } });
}
