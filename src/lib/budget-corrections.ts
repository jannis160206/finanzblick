import { addMonths } from "@/lib/calc";
import { fixedRowCategory } from "@/lib/fixed";
import { currency } from "@/lib/format";
import { SPECIAL_ROW_ID } from "@/lib/payslip-income";
import { planningEndMonth } from "@/lib/planning-range";
import { salaryForecast, type SalaryForecast, type SalaryPart } from "@/lib/salary-forecast";
import type { AppState, FinanceRow } from "@/lib/types";

export type BudgetCorrectionKind = SalaryPart | "duplicate";
/** One proposed budget value: row and month, old → new, and why. Applied automatically or after review (payroll-budget.ts). */
export type BudgetCorrection = {
  id: string;
  rowId: string;
  label: string;
  kind: BudgetCorrectionKind;
  /** The row does not exist yet and is created on apply. */
  create?: true;
  month: string;
  from: number;
  to: number;
  reason: string;
};
export type BudgetCorrectionGroup = { rowId: string; label: string; kind: BudgetCorrectionKind; create: boolean; items: BudgetCorrection[] };

// Same row rules as the payslip import (payslip-income.ts), plus overtime and other income.
const SPECIAL_ROW = /sonderzahl|urlaubs(?:geld|zuschuss)|weihnachts|1[34]\.\s*(?:monats)?(?:gehalt|lohn)/i;
const OVERTIME_ROW = /[üu]e?berstunden|mehrleistung/i;
const OTHER_ROW = /weitere\s+einnahmen|sonstig/i;
const BUDGET_MONTH = /^202[6-8]-(0[1-9]|1[0-2])$/;
export const OVERTIME_ROW_ID = "income-overtime";
const kindOrder: BudgetCorrectionKind[] = ["salary", "onCall", "overtime", "holidayWork", "special", "duplicate"];
const cents = (value: number) => Math.round(value * 100);

export function salaryRows(rows: readonly FinanceRow[]) {
  const income = rows.filter((row) => row.kind === "income" && !row.fixedSource);
  const special = income.find((row) => SPECIAL_ROW.test(row.label));
  const overtime = income.find((row) => OVERTIME_ROW.test(row.label) && row !== special);
  const salary = income.find((row) => row !== special && row !== overtime && fixedRowCategory(row) === "Gehalt");
  const onCall = income.find((row) => row !== overtime && fixedRowCategory(row) === "Rufbereitschaft" && !/feiertag/i.test(row.label));
  const holidayWork = income.find((row) => /feiertag/i.test(row.label));
  const known = new Set([special, overtime, salary, onCall, holidayWork].filter(Boolean));
  const other = income.filter((row) => !known.has(row) && OTHER_ROW.test(row.label));
  return { salary, onCall, overtime, holidayWork, special, other };
}

const freeId = (rows: readonly FinanceRow[], id: string) => {
  if (!rows.some((row) => row.id === id)) return id;
  for (let index = 2; ; index++) if (!rows.some((row) => row.id === `${id}-${index}`)) return `${id}-${index}`;
};

/**
 * Proposals that bring the income rows in line with the salary forecast for the months after the last real pay,
 * plus a clean-up from the current month on: a special payment that also stands in "Weitere Einnahmen"/"Sonstiges"
 * (±10 %). With `all`, rows and months that already match are listed too (from = to) – the full set of targets.
 */
export function budgetCorrections(state: AppState, forecast: SalaryForecast = salaryForecast(state), options: { all?: boolean } = {}): BudgetCorrection[] {
  const rows = salaryRows(state.financeRows);
  const result: BudgetCorrection[] = [];
  const current = state.settings.asOf.slice(0, 7);
  const add = (row: { id: string; label: string; create?: boolean }, kind: BudgetCorrectionKind, month: string, from: number, to: number, reason: string) => {
    if (!BUDGET_MONTH.test(month) || (!options.all && Math.abs(cents(to) - cents(from)) < 100)) return;
    if (options.all && row.create && to <= 0) return;
    result.push({ id: `${row.id}|${month}`, rowId: row.id, label: row.label, kind, ...(row.create ? { create: true as const } : {}), month, from, to: Math.max(0, to), reason });
  };
  const value = (row: FinanceRow | undefined, month: string) => row?.values[month] ?? 0;
  const salaryRow = rows.salary ?? { id: freeId(state.financeRows, "income-salary"), label: "Gehalt", create: true };
  const specialRow = rows.special ?? { id: freeId(state.financeRows, SPECIAL_ROW_ID), label: "Sonderzahlungen", create: true };
  const overtimeRow = rows.overtime ?? { id: freeId(state.financeRows, OVERTIME_ROW_ID), label: "Überstunden", create: true };
  const plannedSpecial = new Map<string, number>();
  for (const month of forecast.months) {
    const key = month.month;
    let salary = month.salary.amount;
    const reasons = [month.salary.reason];
    const part = (kind: "onCall" | "holidayWork", row: FinanceRow | undefined, label: string) => {
      if (row) add(row, kind, key, value(row, key), month[kind].amount, month[kind].reason);
      else if (month[kind].amount > 0) {
        salary += month[kind].amount;
        reasons.push(`inkl. ${label} ${currency(month[kind].amount)}`);
      }
    };
    part("onCall", rows.onCall, "Rufbereitschaft");
    part("holidayWork", rows.holidayWork, "Feiertagsarbeit");
    add(salaryRow, "salary", key, value(rows.salary, key), salary, reasons.join(" · "));
    if (rows.overtime || month.overtime.amount > 0) add(overtimeRow, "overtime", key, value(rows.overtime, key), month.overtime.amount, month.overtime.reason);
    if (rows.special || month.special.amount > 0) add(specialRow, "special", key, value(rows.special, key), month.special.amount, month.special.reason);
    plannedSpecial.set(key, month.special.amount);
  }
  for (let month = current; month <= planningEndMonth(state.settings.asOf); month = addMonths(month, 1)) {
    const special = plannedSpecial.get(month) ?? value(rows.special, month);
    if (special <= 0) continue;
    const duplicate = rows.other.filter((row) => value(row, month) > 0 && Math.abs(value(row, month) - special) <= special * 0.1)
      .sort((a, b) => Math.abs(value(a, month) - special) - Math.abs(value(b, month) - special))[0];
    if (duplicate) add(duplicate, "duplicate", month, value(duplicate, month), 0, `doppelt zur Sonderzahlung ${currency(special)}`);
  }
  return result.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.rowId.localeCompare(b.rowId) || a.month.localeCompare(b.month));
}

export function groupCorrections(items: readonly BudgetCorrection[]): BudgetCorrectionGroup[] {
  const groups = new Map<string, BudgetCorrectionGroup>();
  for (const item of items) {
    const group = groups.get(item.rowId) ?? { rowId: item.rowId, label: item.label, kind: item.kind, create: !!item.create, items: [] };
    group.items.push(item);
    groups.set(item.rowId, group);
  }
  return [...groups.values()];
}

/** Income change per month if all corrections were applied – what the goal planner adds to the budget. */
export function correctionDelta(items: readonly BudgetCorrection[]): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const item of items) delta[item.month] = (cents(delta[item.month] ?? 0) + cents(item.to) - cents(item.from)) / 100;
  return delta;
}

/** Writes the confirmed corrections; values changed in the meantime are skipped. */
export function applyBudgetCorrections(state: AppState, items: readonly BudgetCorrection[]): { state: AppState; applied: number } {
  let rows = state.financeRows;
  for (const item of items) {
    if (!item.create || rows.some((row) => row.id === item.rowId)) continue;
    const after = rows.findLastIndex((row) => row.kind === "income");
    rows = [...rows.slice(0, after + 1), { id: item.rowId, label: item.label, kind: "income", values: {} }, ...rows.slice(after + 1)];
  }
  let applied = 0;
  rows = rows.map((row) => {
    const own = items.filter((item) => item.rowId === row.id && cents(row.values[item.month] ?? 0) === cents(item.from));
    if (!own.length) return row;
    applied += own.length;
    const values = { ...row.values };
    for (const item of own) values[item.month] = item.to;
    const months = new Set(own.map((item) => item.month));
    const overrides = row.overrides && Object.fromEntries(Object.entries(row.overrides).filter(([month]) => !months.has(month)));
    return { ...row, values, ...(overrides ? { overrides } : {}) };
  });
  return applied ? { state: { ...state, financeRows: rows }, applied } : { state, applied };
}
