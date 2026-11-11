import { fixedRowCategory } from "@/lib/fixed";
import { payrollPatterns, variablePay, type PayrollPattern } from "@/lib/payroll-pattern";
import { isReferencePayslip, payrollEmployerKey, payslipKey, type Payslip } from "@/lib/payslip-schema";
import { payslipHold, type PayslipValidation } from "@/lib/payslip-validation";
import type { AppState, FinanceRow } from "@/lib/types";

export type PayslipIncome = {
  /** Abrechnungsmonat of the payslip. */
  payrollMonth: string;
  /** Month on "Monate" that receives the pay: always the month after the Abrechnungsmonat. */
  month: string;
  net: number;
  salary: number;
  /** Normal on-call pay (flat rate). */
  onCall: number;
  /** Holiday work, including on-call above the normal level. */
  holidayWork: number;
  /** Other extra hours above Grundgehalt, on-call and holiday work. */
  overtime: number;
  special: number;
  /** Salary was transferred in advance; the rest (on-call, holiday work, overtime) comes as a separate payout. */
  advanced: boolean;
  computed: boolean;
  /** False for payslips stored before on-call shares were read: the existing on-call split is kept. */
  splitKnown: boolean;
  /** The on-call flat rate of the payslip's year is known, so holiday work could be told apart from on-call. */
  rated: boolean;
};

const cents = (value: number) => Math.round(value * 100);
const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
const SPECIAL_ROW = /sonderzahl|urlaubs(?:geld|zuschuss)|weihnachts|1[34]\.\s*(?:monats)?(?:gehalt|lohn)/i;
const OVERTIME_ROW = /[üu]e?berstunden|mehrleistung/i;
export const SPECIAL_ROW_ID = "income-special-payments";

/**
 * Splits one payslip's net pay into the month-plan income rows. Amounts are euros. With the employer's pattern,
 * on-call pay above its normal level counts as holiday work instead of on-call.
 */
export function payslipIncome(entry: Payslip, pattern?: PayrollPattern): PayslipIncome | undefined {
  const bonus = cents(entry.unresolvedSixthBonus ?? 0);
  const specialGross = cents(entry.specialGross);
  const specialDeductions = specialGross || bonus ? cents(entry.specialSv ?? NaN) + cents(entry.specialTax ?? 0) : 0;
  // Back-pay for earlier months ("Nachtrag") reaches the account with this payslip and counts as salary.
  const backPay = entry.backPayGross ? Math.max(0, cents(entry.backPayGross) - cents(entry.backPayDeductions ?? 0)) : 0;
  let net = entry.netPay === undefined ? NaN : cents(entry.netPay);
  // With an advance transfer, what reaches the account is "bereits überwiesen" + "Auszahlung" (after e.g. Betriebsrat).
  if (entry.advancePay !== undefined && entry.payout !== undefined) net = cents(entry.advancePay) + cents(entry.payout);
  const computed = !Number.isFinite(net);
  if (computed) {
    // Without a printed "Netto" only an exact reconstruction is used; tax on special payments must be known.
    if (specialGross && entry.specialTax === undefined) return undefined;
    net = cents(entry.regularGross) + specialGross + bonus - cents(entry.regularSv ?? NaN) -
      cents(entry.regularTax ?? NaN) - specialDeductions + backPay;
  }
  if (!Number.isFinite(net) || net <= 0) return undefined;
  const specialKnown = !specialGross || (entry.specialSv !== undefined && entry.specialTax !== undefined);
  const regularOnly = cents(entry.regularGross) + bonus - cents(entry.regularSv ?? NaN) - cents(entry.regularTax ?? NaN) -
    (bonus ? cents(entry.specialSv ?? NaN) : 0);
  // Without the special-payment tax, the printed net minus the reconstructed regular net is the special share.
  const specialNet = specialKnown ? specialGross - cents(entry.specialSv ?? 0) - cents(entry.specialTax ?? 0)
    : Number.isFinite(regularOnly) ? net - regularOnly - backPay : 0;
  const special = Math.max(0, Math.min(net, specialGross, specialNet));
  const regularNet = net - special;
  const regularGross = cents(entry.regularGross) + bonus;
  const ownNet = regularNet - Math.min(regularNet, backPay);
  const share = (gross: number) => regularGross > 0 ? Math.round(ownNet * gross / regularGross) : 0;
  const pay = variablePay(entry, pattern);
  let onCall = share(cents(pay.onCall));
  let holidayWork = share(cents(pay.holiday));
  let overtime = share(cents(pay.overtime));
  let salary = regularNet - onCall - holidayWork - overtime;
  const advance = cents(entry.advancePay ?? NaN);
  const advanced = Number.isFinite(advance) && entry.payout !== undefined && advance <= regularNet;
  if (advanced) {
    // Salary was transferred in advance; the remaining payout is split by the gross of its variable parts.
    salary = advance;
    const rest = regularNet - advance;
    const variable = cents(pay.onCall) + cents(pay.holiday) + cents(pay.overtime);
    holidayWork = variable > 0 ? Math.round(rest * cents(pay.holiday) / variable) : 0;
    overtime = variable > 0 ? Math.round(rest * cents(pay.overtime) / variable) : 0;
    onCall = rest - holidayWork - overtime;
  }
  const next = entry.month === 12 ? { year: entry.year + 1, month: 1 } : { year: entry.year, month: entry.month + 1 };
  return {
    payrollMonth: monthKey(entry.year, entry.month),
    month: monthKey(next.year, next.month),
    net: net / 100,
    salary: salary / 100,
    onCall: onCall / 100,
    holidayWork: holidayWork / 100,
    overtime: overtime / 100,
    special: special / 100,
    advanced,
    computed,
    splitKnown: entry.netPay !== undefined || entry.onCallGross !== undefined || entry.holidayWorkGross !== undefined ||
      entry.advancePay !== undefined,
    rated: pay.rated,
  };
}

type Rows = { salary?: FinanceRow; onCall?: FinanceRow; holidayWork?: FinanceRow; overtime?: FinanceRow; special?: FinanceRow };

function payrollRows(rows: FinanceRow[]): Rows {
  const income = rows.filter((row) => row.kind === "income" && !row.fixedSource);
  const extra = (row: FinanceRow) => SPECIAL_ROW.test(row.label) || OVERTIME_ROW.test(row.label);
  return {
    special: income.find((row) => SPECIAL_ROW.test(row.label)),
    salary: income.find((row) => !extra(row) && fixedRowCategory(row) === "Gehalt"),
    onCall: income.find((row) => !extra(row) && fixedRowCategory(row) === "Rufbereitschaft" && !/feiertag/i.test(row.label)),
    holidayWork: income.find((row) => /feiertag/i.test(row.label)),
    overtime: income.find((row) => !SPECIAL_ROW.test(row.label) && OVERTIME_ROW.test(row.label)),
  };
}

/**
 * Writes payslip net pay into the income rows of the following month on the "Monate" page
 * (the October payslip is paid out and planned in November).
 * Only payroll rows are set; other income such as "Sonstiges" stays untouched. Re-applying
 * the same payslip yields the same values. Payslips of reference years (2025) only feed forecasts.
 * A payslip whose numbers contradict each other stays out of the budget (`held`) until the user confirms it.
 */
export function applyPayslipIncome(state: AppState, entries: readonly Payslip[]) {
  const applied: PayslipIncome[] = [];
  const skipped: string[] = [];
  const reference: string[] = [];
  const held: PayslipValidation[] = [];
  const incoming = new Set(entries.map(payslipKey));
  const history = [...(state.payslips ?? []).filter((entry) => !incoming.has(payslipKey(entry))), ...entries];
  const patterns = payrollPatterns(history);
  let rows = state.financeRows;
  for (const entry of [...entries].sort((a, b) => a.year - b.year || a.month - b.month)) {
    if (isReferencePayslip(entry)) {
      reference.push(monthKey(entry.year, entry.month));
      continue;
    }
    const hold = payslipHold(entry, history, state.payrollBudget?.confirmed);
    if (hold) {
      held.push(hold);
      continue;
    }
    const income = payslipIncome(entry, patterns.get(payrollEmployerKey(entry.employer)));
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
    let { onCall, holidayWork, overtime } = income;
    if (!income.splitKnown) {
      const existing = (row?: FinanceRow) => row?.values[income.month] ?? 0;
      const kept = existing(found.onCall) + existing(found.holidayWork);
      if (kept >= 0 && kept < salary + overtime) {
        onCall = existing(found.onCall);
        holidayWork = existing(found.holidayWork);
        salary = Math.round((salary + overtime - kept) * 100) / 100;
        overtime = 0;
      }
    }
    const targets = new Map<string, number>();
    const assign = (row: FinanceRow | undefined, amount: number) => {
      if (row) targets.set(row.id, Math.round(((targets.get(row.id) ?? 0) + amount) * 100) / 100);
      else salary += amount;
    };
    assign(found.special, income.special);
    assign(found.onCall, onCall);
    // The separate payout (booked as on-call by the bank) keeps holiday work and extra hours apart from on-call.
    assign(found.holidayWork ?? (income.advanced ? found.onCall : undefined), holidayWork);
    assign(found.overtime ?? (income.advanced ? found.holidayWork ?? found.onCall : undefined), overtime);
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
  return { state: changed ? { ...state, financeRows: rows } : state, applied, skipped, reference, held, changed };
}
