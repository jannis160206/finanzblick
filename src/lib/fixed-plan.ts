import { actualBookings, classify, round } from "@/lib/calc";
import { planningMonths } from "@/lib/planning-range";
import { isRevolutMainAccount, normalizeAccount } from "@/lib/accounts";
import { amexCardholder } from "@/lib/import/identity";
import { matchingFixedRow } from "@/lib/fixed";
import { isSpecificMerchantKey, merchantAliasSourceKey, merchantRuleKey, rememberMerchants } from "@/lib/import/merchant-rules";
import { personalAmount, type AccountedTransaction } from "@/lib/shared-holiday";
import type { AppState, FinanceRow } from "@/lib/types";

export class FixedPlanCapacityError extends Error {
  constructor() {
    super("Maximal 200 Tabellenpositionen. Bitte Positionen entfernen oder Fixkosten-Markierungen aufheben.");
    this.name = "FixedPlanCapacityError";
  }
}

// Order references (AMAZON.DE*BB4ER51S4) change with every instalment and are not part of the merchant.
export function fixedMerchantKey(row: AccountedTransaction) {
  const source = merchantAliasSourceKey(row);
  if (!source) return `booking:${row.id}`;
  return source.replace(/\*\s*[a-z0-9]*\d[a-z0-9]*/gi, "*").replace(/\bwww\./gi, "").replace(/\s+/g, " ").trim();
}

// Statement PDFs and screenshots name the same card differently ("AMEX Jannis" / "Amex").
export function fixedCardKey(row: AccountedTransaction) {
  const holder = amexCardholder(row);
  if (holder) return `amex:${holder}`;
  if (isRevolutMainAccount(row)) return "revolut:main";
  return normalizeAccount(row).pocket;
}

function sourceKey(row: AccountedTransaction) {
  return JSON.stringify([fixedMerchantKey(row), fixedCardKey(row)]);
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.01);

// Parallel instalments at one merchant (e.g. two Amazon payment plans) stay separate by amount;
// a single plan whose price changes (PlayStation 13,99 → 15,99) stays one series.
export function splitFixedSeries<T extends AccountedTransaction>(group: T[]): T[][] {
  const marked = group.filter((row) => row.fixedCost);
  const series: { rows: T[]; amount: number; months: Set<string> }[] = [];
  const byMonth = new Map<string, T[]>();
  for (const row of marked) byMonth.set(row.date.slice(0, 7), [...(byMonth.get(row.date.slice(0, 7)) ?? []), row]);
  for (const [month, rows] of [...byMonth].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rest: T[] = [];
    const add = (entry: (typeof series)[number], row: T) => {
      entry.rows.push(row);
      entry.amount = Math.abs(personalAmount(row));
      entry.months.add(month);
    };
    for (const row of rows) {
      const amount = Math.abs(personalAmount(row));
      const match = series.find((entry) => sameAmount(amount, entry.amount));
      if (match) add(match, row); else rest.push(row);
    }
    for (const row of rest) {
      const amount = Math.abs(personalAmount(row));
      const change = series.find((entry) => sameAmount(amount, entry.amount)) ?? series.filter((entry) => !entry.months.has(month))
        .sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount))[0];
      if (change) add(change, row);
      else series.push({ rows: [row], amount, months: new Set([month]) });
    }
  }
  if (series.length <= 1) return [group];
  const result = series.map((entry) => [...entry.rows]);
  // Explicit "not fixed" bookings end only the series with the same amount.
  for (const row of group) {
    if (row.fixedCost) continue;
    const index = series.findIndex((entry) => entry.rows.some((item) => sameAmount(Math.abs(personalAmount(row)), Math.abs(personalAmount(item)))));
    if (index >= 0) result[index].push(row);
  }
  return result;
}

function restore(row: FinanceRow, months: string[]): FinanceRow[] {
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
  const months = planningMonths(state.settings.asOf);
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
  const series = [...groups].flatMap(([base, group]) => splitFixedSeries(group).map((rows, index) => {
    if (!index) return [base, rows] as const;
    const first = rows.find((row) => row.fixedCost) ?? rows[0];
    return [JSON.stringify([...JSON.parse(base), Math.abs(personalAmount(first)).toFixed(2)]), rows] as const;
  }));
  for (const [key, group] of series) {
    // One recurring amount per merchant/account; a later ordinary booking ends it.
    group.sort((a, b) => a.date.localeCompare(b.date) ||
      Number(b.fixedCost) - Number(a.fixedCost) || a.id.localeCompare(b.id));
    const marked = group.filter((row) => row.fixedCost);
    if (!marked.length) continue;
    const firstMonth = marked[0].date.slice(0, 7);
    if (firstMonth > months.at(-1)!) continue;
    const latest = marked.at(-1)!;
    const category = classify(latest).category;
    const ids = new Set(group.map((row) => row.id));
    const previous = linked.find((row) => row.fixedSource?.key === key && !claimed.has(row.id)) ??
      linked.find((row) => !claimed.has(row.id) && !series.some(([other]) => other === row.fixedSource?.key) &&
        row.fixedSource?.bookingIds.some((id) => ids.has(id)));
    const matching = previous ?? matchingFixedRow(state, category, latest, merchantRuleKey(latest));
    const existing = matching && !claimed.has(matching.id) &&
      (!matching.fixedSource || matching === previous || matching.fixedSource.key === key) ? matching : undefined;
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
    if (!replacements.has(row.id)) replacements.set(row.id, restore(row, months));
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
