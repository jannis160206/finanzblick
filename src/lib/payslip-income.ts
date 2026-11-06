import { fixedRowCategory } from "@/lib/fixed";
import type { Payslip } from "@/lib/payslip-schema";
import type { AppState, FinanceRow } from "@/lib/types";

export type PayslipIncome = {
  /** Abrechnungsmonat of the payslip. */
  payrollMonth: string;
  /** Month on "Monate" that receives the pay: always the month after the Abrechnungsmonat. */
  month: string;
  net: number;
  salary: number;
  onCall: number;
  holidayWork: number;
  special: number;
  computed: boolean;
};

const cents = (value: number) => Math.round(value * 100);
const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
const SPECIAL_ROW = /sonderzahl|urlaubs(?:geld|zuschuss)|weihnachts|1[34]\.\s*(?:monats)?(?:gehalt|lohn)/i;
export const SPECIAL_ROW_ID = "income-special-payments";

/** Splits one payslip's net pay into the month-plan income rows. Amounts are euros. */
export function payslipIncome(entry: Payslip): PayslipIncome | undefined {
  const bonus = cents(entry.unresolvedSixthBonus ?? 0);
  const specialGross = cents(entry.specialGross);
  const specialDeductions = specialGross || bonus ? cents(entry.specialSv ?? NaN) + cents(entry.specialTax ?? 0) : 0;
  let net = entry.netPay === undefined ? NaN : cents(entry.netPay);
  const computed = !Number.isFinite(net);
  if (computed) {
    // Without a printed "Netto" only an exact reconstruction is used; tax on special payments must be known.
    if (specialGross && entry.specialTax === undefined) return undefined;
    net = cents(entry.regularGross) + specialGross + bonus - cents(entry.regularSv ?? NaN) -
      cents(entry.regularTax ?? NaN) - specialDeductions;
  }
  if (!Number.isFinite(net) || net <= 0) return undefined;
  const specialKnown = !specialGross || (entry.specialSv !== undefined && entry.specialTax !== undefined);
  const regularOnly = cents(entry.regularGross) + bonus - cents(entry.regularSv ?? NaN) - cents(entry.regularTax ?? NaN) -
    (bonus ? cents(entry.specialSv ?? NaN) : 0);
  // Without the special-payment tax, the printed net minus the reconstructed regular net is the special share.
  const specialNet = specialKnown ? specialGross - cents(entry.specialSv ?? 0) - cents(entry.specialTax ?? 0)
    : Number.isFinite(regularOnly) ? net - regularOnly : 0;
  const special = Math.max(0, Math.min(net, specialGross, specialNet));
  const regularNet = net - special;
  const regularGross = cents(entry.regularGross) + bonus;
  const share = (gross: number) => regularGross > 0 ? Math.round(regularNet * gross / regularGross) : 0;
  const onCall = share(cents(entry.onCallGross ?? 0));
  const holidayWork = share(cents(entry.holidayWorkGross ?? 0));
  const next = entry.month === 12 ? { year: entry.year + 1, month: 1 } : { year: entry.year, month: entry.month + 1 };
  return {
    payrollMonth: monthKey(entry.year, entry.month),
    month: monthKey(next.year, next.month),
    net: net / 100,
    salary: (regularNet - onCall - holidayWork) / 100,
    onCall: onCall / 100,
    holidayWork: holidayWork / 100,
    special: special / 100,
    computed,
  };
}

type Rows = { salary?: FinanceRow; onCall?: FinanceRow; holidayWork?: FinanceRow; special?: FinanceRow };

function payrollRows(rows: FinanceRow[]): Rows {
  const income = rows.filter((row) => row.kind === "income" && !row.fixedSource);
  return {
    special: income.find((row) => SPECIAL_ROW.test(row.label)),
    salary: income.find((row) => !SPECIAL_ROW.test(row.label) && fixedRowCategory(row) === "Gehalt"),
    onCall: income.find((row) => fixedRowCategory(row) === "Rufbereitschaft" && !/feiertag/i.test(row.label)),
    holidayWork: income.find((row) => /feiertag/i.test(row.label)),
  };
}

/**
 * Writes payslip net pay into the income rows of the following month on the "Monate" page
 * (the October payslip is paid out and planned in November).
 * Only payroll rows are set; other income such as "Sonstiges" stays untouched. Re-applying
 * the same payslip yields the same values.
 */
export function applyPayslipIncome(state: AppState, entries: readonly Payslip[]) {
  const applied: PayslipIncome[] = [];
  const skipped: string[] = [];
  let rows = state.financeRows;
  for (const entry of [...entries].sort((a, b) => a.year - b.year || a.month - b.month)) {
    const income = payslipIncome(entry);
    if (!income) {
      skipped.push(monthKey(entry.year, entry.month));
      continue;
    }
    let found = payrollRows(rows);
    if (!found.salary) {
      const id = rows.some((row) => row.id === "income-salary") ? `income-salary-${Date.now()}` : "income-salary";
      rows = [...rows, { id, label: "Nettogehalt", kind: "income", values: {} }];
      found = payrollRows(rows);
    }
    if (income.special > 0 && !found.special) {
      const index = rows.findIndex((row) => row.id === found.salary!.id);
      rows = [...rows.slice(0, index + 1), { id: SPECIAL_ROW_ID, label: "Sonderzahlungen", kind: "income", values: {} }, ...rows.slice(index + 1)];
      found = payrollRows(rows);
    }
    let salary = income.salary;
    const targets = new Map<string, number>();
    const assign = (row: FinanceRow | undefined, amount: number) => {
      if (row) targets.set(row.id, Math.round(((targets.get(row.id) ?? 0) + amount) * 100) / 100);
      else salary += amount;
    };
    assign(found.special, income.special);
    assign(found.onCall, income.onCall);
    assign(found.holidayWork, income.holidayWork);
    targets.set(found.salary!.id, Math.round((salary + (targets.get(found.salary!.id) ?? 0)) * 100) / 100);
    rows = rows.map((row) => {
      if (!targets.has(row.id)) return row;
      const next = { ...row, values: { ...row.values, [income.month]: targets.get(row.id)! } };
      if (row.overrides && income.month in row.overrides) {
        next.overrides = Object.fromEntries(Object.entries(row.overrides).filter(([month]) => month !== income.month));
      }
      return next;
    });
    applied.push(income);
  }
  const changed = JSON.stringify(rows) !== JSON.stringify(state.financeRows);
  return { state: changed ? { ...state, financeRows: rows } : state, applied, skipped, changed };
}
