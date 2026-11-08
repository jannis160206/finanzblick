import { FinanceStorageError } from "@/lib/finance-storage";
import { appStateSchema, transactionSchema, type AppState, type Transaction } from "@/lib/types";
import { isAutomationLocked } from "@/lib/automation/locks";
import { hasCategoryChoice } from "@/lib/manual-category";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export class FinanceMergeConflictError extends FinanceStorageError {}
export type FinanceMergeBaseline = Omit<AppState, "transactions" | "fixedReceipts" | "reviewQueue">;

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
  "aiAssigned",
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
// Personal notes on a booking. Server-side bank sync never sets them, so the device copy wins instead of blocking the sync.
const annotations = new Set([
  "tags",
  "ignored",
  "splits",
  "sharedWithRaphael",
  "sharedPaidManually",
  "sharedRefundFor",
  "sharedRefundUnlinked",
  "sharedRepaymentFor",
  "sharedPaidAmount",
]);
const merchantFields = ["merchantAlias", "merchantId", "merchantLogo", "merchantMatch", "merchantNameConfirmed", "is_locked"] as const;
const bookingMetadata = new Set([...assignments, ...annotations]);
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

// Filled by the server's bank sync and imports, so the server copy is the newest truth there.
const serverSections = new Set([
  "accountSnapshots",
  "amexBalanceSnapshots",
  "pocketSnapshots",
  "trBalances",
  "importResults",
  "interestRates",
]);

function without(value: Record<string, unknown>, fields: ReadonlySet<string>) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !fields.has(key)),
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
  // Rows without an identity are compared by their whole content.
  if (!fields || fields.some((key) => value[key] === undefined)) return JSON.stringify(value);
  return JSON.stringify(fields.map((key) => value[key]));
}

/** Newest side for a value both copies changed: bank-fed sections trust the server, personal edits trust this device. */
const preferred = (left: unknown, right: unknown, section: string) => serverSections.has(section) ? right : left;

function mergeBooking(left: Record<string, unknown>, right: Record<string, unknown>, local: Transaction, remote: Transaction) {
  const localChoice = hasCategoryChoice(local), remoteChoice = hasCategoryChoice(remote);
  const localLocked = isAutomationLocked(local), remoteLocked = isAutomationLocked(remote);
  // A category decision and a merchant confirmation are separate choices; the device decides when both made the same kind.
  const chosen =
    localChoice !== remoteChoice
      ? localChoice ? local : remote
      : localChoice || (localLocked && !remoteLocked) ? local : remote;
  const other = chosen === local ? remote : local;
  const named = local.merchantNameConfirmed === true ? local : remote.merchantNameConfirmed === true ? remote : undefined;
  const identity = named && named !== chosen && chosen.merchantNameConfirmed !== true
    ? Object.fromEntries(merchantFields.map((key) => [key, Reflect.get(named, key)]))
    : other.merchantNameConfirmed === true && chosen.merchantNameConfirmed === true && local.merchantAlias !== remote.merchantAlias
      ? Object.fromEntries(merchantFields.map((key) => [key, Reflect.get(local, key)]))
      : {};
  // Bank facts (amount, date, status, texts) come from the server's latest bank sync.
  const facts = without(right, bookingMetadata);
  const decisions = Object.fromEntries(Object.entries(chosen).filter(([key]) => assignments.has(key)));
  const notes = Object.fromEntries([...annotations].map((key) => [key, left[key]]));
  return transactionSchema.parse(Object.fromEntries(
    Object.entries({ ...facts, ...decisions, ...identity, ...notes }).filter(([, value]) => value !== undefined),
  ));
}

function merge(left: unknown, right: unknown, section: string, base?: unknown, knownBase = false): unknown {
  if (sameFinanceData(left, right)) return right;
  if (!Array.isArray(left) && !Array.isArray(right) && !record(left) && !record(right) && knownBase) {
    if (sameFinanceData(left, base)) return right;
    if (sameFinanceData(right, base)) return left;
  }
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (Array.isArray(left) && Array.isArray(right)) {
    const values = new Map<string, unknown>();
    const originals = new Map<string, unknown>();
    if (Array.isArray(base))
      for (const value of base) originals.set(keyFor(value, section), value);
    for (const list of [left, right]) {
      const own = new Map<string, unknown>();
      // A repeated row inside one copy keeps its latest entry.
      for (const value of list) own.set(keyFor(value, section), value);
      for (const [key, value] of own)
        values.set(
          key,
          values.has(key) ? merge(values.get(key), value, section, originals.get(key), knownBase) : value,
        );
    }
    return [...values.values()];
  }
  if (!record(left) || !record(right)) return preferred(left, right, section);
  const localBooking = transactionSchema.safeParse(left);
  const remoteBooking = transactionSchema.safeParse(right);
  if (localBooking.success && remoteBooking.success)
    return mergeBooking(left, right, localBooking.data, remoteBooking.data);
  if (
    section === "fixedReceipts" &&
    record(left.booking) &&
    record(right.booking)
  ) {
    const booking = merge(left.booking, right.booking, section, record(base) ? base.booking : undefined, knownBase);
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
        : merge(left[key], right[key], collections[key] ? key : section, record(base) ? base[key] : undefined, knownBase),
    ]);
  return Object.fromEntries(combined);
}

export function mergeFinanceStates(
  local: AppState,
  remote: AppState,
  baseline?: FinanceMergeBaseline | null,
): AppState {
  const left: Record<string, unknown> = local,
    right: Record<string, unknown> = remote;
  const combined: [string, unknown][] = [];
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)]))
    combined.push([key, merge(left[key], right[key], key, baseline ? Reflect.get(baseline, key) : undefined,
      baseline !== undefined && (baseline === null || Object.hasOwn(baseline, key)))]);
  const merged = Object.fromEntries(combined);
  // A combination that breaks a rule (e.g. overlapping holidays) falls back per area: device copy first, then server copy.
  for (const source of [left, right, null]) {
    const result = appStateSchema.safeParse(merged);
    if (result.success) return result.data;
    if (!source) break;
    for (const key of new Set(result.error.issues.map((issue) => issue.path[0]).filter((key) => typeof key === "string")))
      merged[key] = source[key];
  }
  throw new FinanceMergeConflictError(
    "Der gemeinsame Datenstand ist nicht gültig. Beide Originalstände bleiben erhalten; der Abgleich wird erneut versucht.",
  );
}
