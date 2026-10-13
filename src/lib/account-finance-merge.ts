import { FinanceStorageError } from "@/lib/finance-storage";
import { appStateSchema, transactionSchema, type AppState } from "@/lib/types";
import { isAutomationLocked } from "@/lib/automation/locks";
import { hasCategoryChoice } from "@/lib/manual-category";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sameFinanceData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value: unknown, index: number) =>
        sameFinanceData(value, right[index]),
      )
    );
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return (
    keys.length ===
      Object.keys(right).filter((key) => right[key] !== undefined).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && sameFinanceData(left[key], right[key]),
    )
  );
}

const assignments = new Set([
  "category",
  "categoryOverride",
  "manualCategory",
  "reviewed",
  "merchantAlias",
  "merchantId",
  "merchantLogo",
  "merchantMatch",
  "merchantNameConfirmed",
  "is_locked",
  "requires_manual_review",
  "automaticCategoryEvidence",
  "includeInPlan",
  "afterBaseline",
  "fixedCost",
]);
const collections: Record<string, readonly string[]> = {
  payslips: ["employer", "year", "month"],
  payrollForecasts: ["employer", "year"],
  annualSixth: ["year"],
  holidayRanges: ["from", "to"],
  pocketOpeningBalances: ["pocket", "date"],
  pocketSnapshots: ["bank", "pocket", "date"],
  fixedAmountDecisions: ["merchantKey", "month", "category"],
  accountSnapshots: ["bank", "name", "date"],
  amexBalanceSnapshots: ["periodStart", "date"],
  trBalances: ["date"],
  importResults: ["uploadId"],
  interestRates: ["date"],
};

function without(value: Record<string, unknown>, fields: ReadonlySet<string>) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !fields.has(key)),
  );
}

function conflict(section: string): never {
  const labels: Record<string, string> = {
    transactions: "Buchungen",
    settings: "Einstellungen",
    financeRows: "Finanzzeilen",
    fixedReceipts: "Fixkostenbelege",
    reviewQueue: "offene Prüfungen",
    savingsGoals: "Sparziele",
    months: "Monatsplanung",
  };
  throw new FinanceStorageError(
    `Die Datenstände enthalten widersprüchliche Angaben im Bereich „${labels[section] ?? section}“. Es wurde nichts überschrieben. Bitte beide Stände sichern und die Unterschiede prüfen.`,
  );
}

function keyFor(value: unknown, section: string): string {
  if (!record(value)) return JSON.stringify(value);
  const fields =
    typeof value.id === "string"
      ? ["id"]
      : typeof value.key === "string"
        ? ["key"]
        : collections[section];
  if (!fields || fields.some((key) => value[key] === undefined))
    conflict(section);
  return JSON.stringify(fields.map((key) => value[key]));
}

function merge(left: unknown, right: unknown, section: string): unknown {
  if (sameFinanceData(left, right)) return right;
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (Array.isArray(left) && Array.isArray(right)) {
    const values = new Map<string, unknown>();
    for (const list of [left, right]) {
      const seen = new Set<string>();
      for (const value of list) {
        const key = keyFor(value, section);
        if (seen.has(key)) conflict(section);
        seen.add(key);
        values.set(
          key,
          values.has(key) ? merge(values.get(key), value, section) : value,
        );
      }
    }
    return [...values.values()];
  }
  if (!record(left) || !record(right)) conflict(section);
  const localBooking = transactionSchema.safeParse(left);
  const remoteBooking = transactionSchema.safeParse(right);
  if (localBooking.success && remoteBooking.success) {
    const local = localBooking.data,
      remote = remoteBooking.data;
    const localLocked = isAutomationLocked(local),
      remoteLocked = isAutomationLocked(remote);
    if (
      !sameFinanceData(without(left, assignments), without(right, assignments))
    )
      conflict(section);
    if (
      localLocked &&
      remoteLocked &&
      !sameFinanceData(
        [
          local.category,
          local.merchantAlias,
          local.includeInPlan,
          local.fixedCost,
          local.merchantNameConfirmed === true,
        ],
        [
          remote.category,
          remote.merchantAlias,
          remote.includeInPlan,
          remote.fixedCost,
          remote.merchantNameConfirmed === true,
        ],
      )
    )
      conflict(section);
    if (
      localLocked &&
      remoteLocked &&
      !hasCategoryChoice(local) &&
      hasCategoryChoice(remote)
    )
      return remote;
    return localLocked ? local : remote;
  }
  if (
    section === "fixedReceipts" &&
    record(left.booking) &&
    record(right.booking)
  ) {
    const metadata = new Set(["booking", "category", "merchantKey"]);
    if (!sameFinanceData(without(left, metadata), without(right, metadata)))
      conflict(section);
    const booking = merge(left.booking, right.booking, section);
    const selected = sameFinanceData(booking, left.booking) ? left : right;
    return { ...selected, booking };
  }
  const combined: [string, unknown][] = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
    combined.push([
      key,
      section === "reviewQueue" &&
      key === "message" &&
      left.kind === "booking" &&
      right.kind === "booking"
        ? right[key]
        : merge(left[key], right[key], collections[key] ? key : section),
    ]);
  return Object.fromEntries(combined);
}

export function mergeFinanceStates(
  local: AppState,
  remote: AppState,
): AppState {
  const left: Record<string, unknown> = local,
    right: Record<string, unknown> = remote;
  const combined: [string, unknown][] = [];
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)]))
    combined.push([key, merge(left[key], right[key], key)]);
  const result = appStateSchema.safeParse(Object.fromEntries(combined));
  if (!result.success)
    throw new FinanceStorageError(
      "Der gemeinsame Datenstand ist nicht gültig. Beide Originalstände bleiben erhalten; bitte sichern und die Unterschiede prüfen.",
    );
  return result.data;
}
