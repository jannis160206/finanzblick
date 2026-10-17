import { variableBudgetLines, type VariableBudgetId } from "@/lib/variable-budgets";

export type LedgerLink = {
  /** "" steht für „Alle Monate“; undefined für den aktuellen Monat. */
  month?: string;
  group?: VariableBudgetId;
};

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseBudgetGroup(value: string | null | undefined): VariableBudgetId | undefined {
  return variableBudgetLines.find((line) => line.id === value)?.id;
}

export function budgetGroupLabel(group: VariableBudgetId): string {
  return variableBudgetLines.find((line) => line.id === group)?.label ?? group;
}

// Ungültige Werte werden ignoriert. Suchtexte gehören bewusst nicht in die URL.
export function parseLedgerLink(params: { get(name: string): string | null }): LedgerLink {
  const month = params.get("month");
  const group = parseBudgetGroup(params.get("group"));
  return {
    ...(month === "all" ? { month: "" } : month && monthPattern.test(month) ? { month } : {}),
    ...(group ? { group } : {}),
  };
}

export function ledgerHref(link: LedgerLink = {}): string {
  const params = new URLSearchParams();
  if (link.month === "") params.set("month", "all");
  else if (link.month) params.set("month", link.month);
  if (link.group) params.set("group", link.group);
  const query = params.toString();
  return query ? `/umsaetze?${query}` : "/umsaetze";
}
