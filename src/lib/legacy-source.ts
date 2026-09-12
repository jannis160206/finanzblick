import { type AppState, type Transaction } from "@/lib/types";
import { calculatePlan } from "@/lib/calc";

const septemberRepair = "september-2026-sonstiges-focus-override" as const;

export function repairKnownPlanningOverrides(state: AppState): AppState {
  if (state.planningRepairs?.includes(septemberRepair)) return state;
  return {
    ...state,
    planningRepairs: [septemberRepair],
    financeRows: state.financeRows.map((row) => {
      // This exact accidental override was confirmed in the user's backup.
      // Never clear arbitrary values, other months, or later intentional edits.
      if (
        row.id !== "auto-Sonstiges" ||
        row.kind !== "variable" ||
        row.planCategory !== "Sonstiges" ||
        row.overrides?.["2026-09"] !== 2027.75 ||
        row.values["2026-09"] !== 2027.75
      )
        return row;
      const asOf =
        state.settings.asOf > "2026-09-30" ? "2026-09-30" : state.settings.asOf;
      const automatic =
        calculatePlan(state.transactions, asOf).byCategory.find(
          (item) => item.category === "Sonstiges",
        )?.total ?? 0;
      return {
        ...row,
        overrides: { ...row.overrides, "2026-09": null },
        values: { ...row.values, "2026-09": automatic },
      };
    }),
  };
}

const sourceKey = (row: Transaction) =>
  JSON.stringify([
    row.id,
    row.date,
    row.bank,
    row.amount,
    row.description,
    row.pocket,
  ]);

// Older Excel imports collapsed unsupported categories into Sonstiges and lost
// the original source label. Restore only exact, unedited bootstrap rows.
export function restoreLegacySourceCategories(
  state: AppState,
  reference?: AppState,
): AppState {
  if (!reference) return state;
  const originals = new Map(
    reference.transactions
      .filter((row) => row.sourceCategory)
      .map((row) => [sourceKey(row), row.sourceCategory!]),
  );
  let changed = false;
  const transactions = state.transactions.map((row) => {
    if (
      !/^xlsx-\d+$/.test(row.id) ||
      row.sourceCategory ||
      row.category !== "Sonstiges" ||
      row.categoryOverride
    )
      return row;
    const sourceCategory = originals.get(sourceKey(row));
    if (!sourceCategory) return row;
    changed = true;
    return { ...row, sourceCategory };
  });
  return changed ? { ...state, transactions } : state;
}
