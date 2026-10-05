import { actualBookings, classify, monthsForYear, round } from "@/lib/calc";
import { normalizeAccount } from "@/lib/accounts";
import { matchingFixedRow } from "@/lib/fixed";
import { isSpecificMerchantKey, merchantAliasSourceKey, merchantRuleKey, rememberMerchants } from "@/lib/import/merchant-rules";
import { personalAmount, type AccountedTransaction } from "@/lib/shared-holiday";
import type { AppState, FinanceRow } from "@/lib/types";

const months = [...monthsForYear(2026), ...monthsForYear(2027)];

export class FixedPlanCapacityError extends Error {
  constructor() {
    super("Maximal 200 Tabellenpositionen. Bitte Positionen entfernen oder Fixkosten-Markierungen aufheben.");
    this.name = "FixedPlanCapacityError";
  }
}

function sourceKey(row: AccountedTransaction) {
  const merchant = merchantAliasSourceKey(row) ?? `booking:${row.id}`;
  return JSON.stringify([merchant, normalizeAccount(row).pocket]);
}

function restore(row: FinanceRow): FinanceRow[] {
  if (!row.fixedSource?.originalValues) return [];
  const { fixedSource, ...original } = row;
  const values = { ...original.values };
  for (const month of months) {
    if (Object.hasOwn(fixedSource.overrides ?? {}, month)) continue;
    if (values[month] !== fixedSource.applied[month]) continue;
    if (fixedSource.originalValues?.[month] === undefined) delete values[month];
    else values[month] = fixedSource.originalValues[month];
  }
  return [{ ...original, values }];
}

export function synchronizeFixedPlan(state: AppState): AppState {
  const linked = state.financeRows.filter((row) => row.fixedSource);
  if (!linked.length && !state.transactions.some((row) => row.fixedCost === true) &&
    !state.fixedReceipts?.some((item) => item.booking?.fixedCost === true)) return state;
  const groups = new Map<string, AccountedTransaction[]>();
  const receiptIds = new Map((state.fixedReceipts ?? []).flatMap((item) =>
    item.booking ? [[item.key, item.booking.id] as const] : []));
  for (const row of actualBookings(state)) {
    if (row.fixedCost === undefined || row.amount >= 0) continue;
    const result = classify(row);
    if (result.isTransfer || (row.fixedCost && !result.isFixedCost)) continue;
    const key = sourceKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const replacements = new Map<string, FinanceRow[]>();
  const additions: FinanceRow[] = [];
  const claimed = new Set<string>();
  const usedIds = new Set(state.financeRows.map((row) => row.id));
  for (const [key, group] of groups) {
    // One recurring amount per merchant/account; a later ordinary booking ends it.
    group.sort((a, b) => a.date.localeCompare(b.date) ||
      Number(b.fixedCost) - Number(a.fixedCost) || a.id.localeCompare(b.id));
    const marked = group.filter((row) => row.fixedCost);
    if (!marked.length) continue;
    const firstMonth = marked[0].date.slice(0, 7);
    if (firstMonth > months.at(-1)!) continue;
    const latest = marked.at(-1)!;
    const category = classify(latest).category;
    const previous = linked.find((row) => row.fixedSource?.key === key);
    const matching = previous ?? matchingFixedRow(state, category, latest, merchantRuleKey(latest));
    const existing = matching && !claimed.has(matching.id) &&
      (!matching.fixedSource || matching.fixedSource.key === key) ? matching : undefined;
    if (existing) claimed.add(existing.id);
    const originalValues = existing?.fixedSource
      ? existing.fixedSource.originalValues : existing?.values;
    const applied: FinanceRow["values"] = { ...(originalValues ?? {}) };
    let event = 0;
    let active: AccountedTransaction | undefined;
    for (const month of months) {
      while (event < group.length && group[event].date.slice(0, 7) <= month) active = group[event++];
      if (month < firstMonth) continue;
      applied[month] = active?.fixedCost ? round(Math.abs(personalAmount(active))) : originalValues?.[month] ?? null;
    }
    const overrides = { ...existing?.fixedSource?.overrides };
    if (existing?.fixedSource) {
      for (const month of months) {
        if (existing.values[month] === existing.fixedSource.applied[month]) continue;
        overrides[month] = existing.values[month] ?? null;
      }
    }
    const values = { ...applied, ...overrides };
    const appliedLabel = originalValues ? existing!.label : (latest.merchantAlias ?? classify(latest).merchant).slice(0, 100);
    const labelOverride = existing?.fixedSource && existing.label !== existing.fixedSource.appliedLabel
      ? existing.label : existing?.fixedSource?.labelOverride;
    const label = labelOverride ?? appliedLabel;
    const baseId = `fixed:${encodeURIComponent(key)}`;
    let id = existing?.id ?? baseId;
    if (!existing) {
      let suffix = 0;
      while (usedIds.has(id)) id = `${baseId}:${++suffix}`;
      usedIds.add(id);
    }
    const row: FinanceRow = {
      ...(existing ?? { id, kind: "fixed" as const }),
      label,
      planCategory: originalValues ? existing!.planCategory : category,
      values,
      fixedSource: {
        key, bookingIds: [...new Set(group.flatMap((row) => [row.id, ...(receiptIds.has(row.id) ? [receiptIds.get(row.id)!] : [])]))],
        merchantKeys: [...new Set(group.flatMap((row) => {
          const source = merchantAliasSourceKey(row);
          const named = merchantRuleKey(row);
          return source ? [source, named] : row.merchantAlias && isSpecificMerchantKey(named) ? [named] : [];
        }))],
        pocket: normalizeAccount(latest).pocket,
        appliedLabel: label,
        ...(labelOverride ? { labelOverride } : {}),
        applied: { ...values },
        ...(Object.keys(overrides).length ? { overrides } : {}),
        ...(originalValues ? { originalValues: { ...originalValues } } : {}),
      },
    };
    if (existing) replacements.set(existing.id, [row]);
    else additions.push(row);
  }
  for (const row of linked)
    if (!replacements.has(row.id)) replacements.set(row.id, restore(row));
  const financeRows = [...state.financeRows.flatMap((row) => replacements.get(row.id) ?? [row]), ...additions];
  if (financeRows.length > 200) throw new FixedPlanCapacityError();
  return { ...state, financeRows };
}

export function removeFixedPlanRow(state: AppState, removed: FinanceRow): AppState {
  if (!removed.fixedSource) return { ...state, financeRows: state.financeRows.filter((row) => row.id !== removed.id) };
  const ids = new Set(removed.fixedSource?.bookingIds ?? []);
  const choices = removed.fixedSource ? actualBookings(state).filter((row) => ids.has(row.id))
    .map((row) => ({ ...row, fixedCost: false })) : [];
  return rememberMerchants({
    ...state,
    financeRows: state.financeRows.filter((row) => row.id !== removed.id),
    transactions: state.transactions.map((row) => ids.has(row.id) ? { ...row, fixedCost: false } : row),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) =>
      item.booking && (ids.has(item.key) || ids.has(item.booking.id))
        ? { ...item, booking: { ...item.booking, fixedCost: false } } : item) } : {}),
  }, choices);
}
