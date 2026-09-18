import type { Transaction } from "@/lib/types";

type CategoryChoice = Partial<Pick<Transaction, "manualCategory" | "reviewed" | "categoryOverride">>;

export const hasManualCategory = (row: CategoryChoice) => row.manualCategory === true;

// Older pencil saves acknowledged a single booking, unlike learned rules.
export const hasCategoryChoice = (row: CategoryChoice) =>
  hasManualCategory(row) || (row.reviewed === true && row.categoryOverride === true);

export function retainManualCategory<T extends Transaction>(source: T, previous: Transaction): T {
  if (hasManualCategory(source) || !hasManualCategory(previous)) return source;
  return { ...source, category: previous.category, manualCategory: true,
    categoryOverride: previous.categoryOverride, reviewed: previous.reviewed,
    includeInPlan: previous.includeInPlan, fixedCost: previous.fixedCost };
}
