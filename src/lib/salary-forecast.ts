import { actualBookings, addMonths, bookingMonth, classify } from "@/lib/calc";
import { currency, monthLabel, percent } from "@/lib/format";
import {
  analyzePayrollAutomatically,
  regularReference,
  successBonusGross,
  successBonusPercent,
  type AutomaticPayrollAnalysis,
  type PayrollYear,
} from "@/lib/payroll-analysis";
import { payrollCategory } from "@/lib/payroll";
import { payslipIncome } from "@/lib/payslip-income";
import { payrollPatterns, type PayrollPattern, payrollProfile } from "@/lib/payroll-pattern";
import { payslipHold } from "@/lib/payslip-validation";
import { isReferencePayslip, payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";
import { planningEndMonth } from "@/lib/planning-range";
import type { AppState } from "@/lib/types";
import { specialPaymentTax, wageTaxCredits, type SpecialPaymentState, type SpecialPaymentTax } from "@/lib/wage-tax-at";

export const salaryParts = ["salary", "onCall", "overtime", "holidayWork", "special"] as const;
export type SalaryPart = (typeof salaryParts)[number];
type VariablePart = "onCall" | "overtime" | "holidayWork";

/** Pay that reached one budget month (the month after the Abrechnungsmonat), split like the income rows. */
export type SalaryInflow = Record<SalaryPart, number> & {
  month: string;
  source: "payslip" | "bank";
  /** Grundgehalt printed on the payslip; a change marks a raise. */
  base?: number;
  /** From a payslip of a reference year (2025): a pattern for forecasts, never a budget value. */
  reference?: boolean;
  /** Whether the part could be read; bank bookings carry no overtime or holiday-work split. */
  known: Record<VariablePart, boolean>;
};
export type SalaryValue = { amount: number; reason: string };
export type SalaryForecastMonth = Record<SalaryPart, SalaryValue> & { month: string; total: number };
export type SalaryForecast = {
  history: SalaryInflow[];
  /** Last budget month already paid according to a payslip or a salary booking; later months are forecast. */
  actualThrough?: string;
  /** Current regular net salary without on-call, overtime, holiday work and special payments. */
  level?: SalaryValue;
  /** Raise between the oldest month of the last twelve and today. */
  raise?: { factor: number; since: string };
  months: SalaryForecastMonth[];
};

/** Net share of a modelled special payment when no tax estimate is possible: 17,07 % SV, then about 6 % Lohnsteuer. */
export const SPECIAL_NET_RATIO = 0.78;
// A persistent change of the regular net salary by more than 3 % counts as a raise (or cut).
const STEP = 0.03;
// A salary booking above 140 % of the regular level contains a special payment.
const SPIKE = 1.4;
// An on-call booking above 125 % of the normal on-call pay contains holiday work.
const HOLIDAY = 1.25;
const cents = (value: number) => Math.round(value * 100) / 100;
const euros = (value: number) => Math.max(0, Math.round(value));
const short = (month: string) => monthLabel(month, true);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const emptyInflow = (month: string, source: SalaryInflow["source"]): SalaryInflow => ({
  month, source, salary: 0, onCall: 0, overtime: 0, holidayWork: 0, special: 0,
  known: { onCall: false, overtime: false, holidayWork: false },
});

/**
 * Splits a payslip like the month plan does: normal on-call, holiday work (incl. on-call above its normal level),
 * other extra hours and special payments, each as net share of the payout.
 */
export function payslipInflow(entry: Payslip, pattern?: PayrollPattern): SalaryInflow | undefined {
  const income = payslipIncome(entry, pattern);
  if (!income) return undefined;
  return {
    month: income.month, source: "payslip", salary: income.salary, onCall: income.onCall, overtime: income.overtime,
    holidayWork: income.holidayWork, special: income.special,
    ...(entry.baseSalary ? { base: entry.baseSalary } : {}),
    ...(isReferencePayslip(entry) ? { reference: true } : {}),
    known: { onCall: income.splitKnown, overtime: !!entry.baseSalary, holidayWork: income.splitKnown && income.rated },
  };
}

function payslipInflows(payslips: readonly Payslip[]) {
  const result = new Map<string, SalaryInflow>();
  const patterns = payrollPatterns(payslips);
  for (const entry of payslips) {
    const inflow = payslipInflow(entry, patterns.get(payrollEmployerKey(entry.employer)));
    if (!inflow) continue;
    const existing = result.get(inflow.month);
    if (!existing) { result.set(inflow.month, inflow); continue; }
    for (const part of salaryParts) existing[part] = cents(existing[part] + inflow[part]);
    for (const part of ["onCall", "overtime", "holidayWork"] as const) existing.known[part] &&= inflow.known[part];
    existing.base = existing.base && inflow.base ? existing.base + inflow.base : undefined;
  }
  return result;
}

/**
 * Salary bookings of the bank (Gehalt, Rufbereitschaft, special payments) per budget month, for months without a
 * payslip. The bank books holiday work as on-call; above the normal on-call pay it counts as holiday work.
 */
function bankInflows(state: AppState, today: string, normalOnCall?: number) {
  const since = `${addMonths(today.slice(0, 7), -26)}-01`;
  const current = today.slice(0, 7);
  const rows = actualBookings({
    ...state, fixedReceipts: undefined,
    transactions: state.transactions.filter((row) => row.amount > 0 && row.date >= since && row.date <= today),
  });
  const result = new Map<string, SalaryInflow>();
  for (const row of rows) {
    if (row.amount <= 0 || row.date > today) continue;
    const category = classify(row);
    if (category.isTransfer) continue;
    const part: SalaryPart | undefined = category.category === "Gehalt" ? "salary"
      : category.category === "Rufbereitschaft" ? "onCall"
        : category.category === "Einkommen" && payrollCategory(row) === "Einkommen" ? "special" : undefined;
    if (!part) continue;
    const month = bookingMonth(row);
    const inflow = result.get(month) ?? emptyInflow(month, "bank");
    inflow[part] = cents(inflow[part] + row.amount);
    // On-call pay of the running month may still arrive.
    inflow.known.onCall = month < current;
    result.set(month, inflow);
  }
  for (const [month, inflow] of result) {
    if (inflow.salary <= 0) { result.delete(month); continue; }
    if (normalOnCall && inflow.known.onCall && inflow.onCall > normalOnCall * HOLIDAY) {
      inflow.holidayWork = cents(inflow.onCall - normalOnCall);
      inflow.onCall = cents(normalOnCall);
      inflow.known.holidayWork = true;
    }
  }
  return result;
}

/** Regular salary level per month: segments split where the Grundgehalt changes or the net salary changes for good. */
function salaryLevels(history: SalaryInflow[]) {
  const segments: SalaryInflow[][] = [];
  history.forEach((item, index) => {
    const segment = segments.at(-1);
    if (!segment) { segments.push([item]); return; }
    const level = median(segment.map((entry) => entry.salary));
    const base = segment.findLast((entry) => entry.base)?.base;
    const next = history[index + 1];
    const step = base && item.base ? Math.round(base * 100) !== Math.round(item.base * 100)
      : Math.abs(item.salary - level) > level * STEP && item.salary <= level * SPIKE &&
        (!next || Math.abs(next.salary - item.salary) <= item.salary * STEP);
    if (step) segments.push([item]); else segment.push(item);
  });
  const levels = new Map<string, number>();
  for (const segment of segments) {
    const level = median(segment.map((entry) => entry.salary));
    for (const item of segment) levels.set(item.month, level);
  }
  const last = segments.at(-1) ?? [];
  return { levels, current: median(last.slice(-3).map((entry) => entry.salary)), currentFrom: last.at(-1)! };
}

const partLabel: Record<VariablePart, string> = { onCall: "Rufbereitschaft", overtime: "Überstunden", holidayWork: "Feiertagsarbeit" };
const monthName = (month: number) => monthLabel(`2026-${String(month).padStart(2, "0")}`).split(" ")[0];
const percentText = (value: number) => `${String(value).replace(".", ",")} %`;
/** How the Lohnsteuer of a modelled special payment came about. */
const taxNote = (tax: SpecialPaymentTax) => tax.overflowGross > 0
  ? `${currency(tax.overflowGross)} über dem Sechstel nach Tarif`
  : tax.tax === 0 ? "steuerfrei im Jahressechstel" : "6 % im Jahressechstel";

/**
 * Salary forecast per future budget month (the payout month, one after the Abrechnungsmonat), aligned to today's
 * salary level. Older months – also payslips of the reference year 2025 – only give the pattern: special payments and
 * holiday work repeat the same month of the latest year with data, scaled to the current salary. On-call pay is its
 * normal level and extra hours their typical (median) amount, so a single month with much holiday work or overtime is
 * not spread over every month. Modelled special payments are taxed by the Austrian tariff (§ 67 EStG); the
 * Successbonus comes with the December payslip and is paid out in January, so earlier bonuses in other months are not
 * repeated. Every value says where it comes from.
 */
export function salaryForecast(state: AppState, options: { today?: string; until?: string } = {}): SalaryForecast {
  const today = options.today ?? state.settings.asOf;
  const current = today.slice(0, 7);
  const bonus = successBonusPercent(state.settings);
  const successLabel = `Successbonus ${percentText(bonus)} des Grundgehalts mit dem Dezember-Lohn`;
  const until = options.until ?? planningEndMonth(today);
  const stored = state.payslips ?? [];
  // Payslips held back for contradictions do not shape the forecast either.
  const payslips = stored.filter((entry) => !payslipHold(entry, stored, state.payrollBudget?.confirmed));
  const fromPayslips = payslipInflows(payslips);
  const onCallNet = [...fromPayslips.values()].filter((item) => item.known.onCall && item.onCall > 0).slice(-12).map((item) => item.onCall);
  const fromBank = bankInflows(state, today, onCallNet.length ? median(onCallNet) : undefined);
  const history = [...new Set([...fromPayslips.keys(), ...fromBank.keys()])].sort()
    .map((month) => fromPayslips.get(month) ?? fromBank.get(month)!)
    .filter((item) => item.salary > 0);
  if (!history.length) return { history, months: [] };
  const { levels, current: level, currentFrom } = salaryLevels(history);
  for (const item of history) {
    const own = levels.get(item.month)!;
    // A transfer far above the level (a bonus paid with the salary) is a special payment, not salary.
    if (item.salary > own * SPIKE) {
      item.special = cents(item.special + item.salary - own);
      item.salary = cents(own);
    }
  }
  const factor = (item: SalaryInflow) => {
    const own = levels.get(item.month) ?? 0;
    return own > 0 ? level / own : 1;
  };
  const raised = (item: SalaryInflow) => Math.abs(factor(item) - 1) >= 0.005 ? ` · ${factor(item) > 1 ? "+" : ""}${percent(factor(item) - 1)}` : "";
  const actualThrough = history.at(-1)!.month;
  const recent = history.filter((item) => item.month > addMonths(actualThrough, -12));
  /** Typical amount: the median, so single months with holiday work or many extra hours do not lift every month. */
  const typical = (part: "onCall" | "overtime", scale: boolean): SalaryValue => {
    const known = recent.filter((item) => item.known[part]);
    if (!known.length) return { amount: 0, reason: `keine Daten zu ${partLabel[part]}` };
    const amount = euros(median(known.map((item) => item[part] * (scale ? factor(item) : 1))));
    const scaled = scale && known.some((item) => Math.abs(factor(item) - 1) >= 0.005);
    return { amount, reason: `üblich lt. ${known.length} ${known.length === 1 ? "Monat" : "Monaten"}${scaled ? " · inkl. Erhöhung" : ""}` };
  };
  const sameMonth = (month: string, part?: VariablePart) => history.findLast((item) =>
    item.month < month && item.month.slice(5) === month.slice(5) && (!part || item.known[part]));
  const analyses = new Map<PayrollYear, AutomaticPayrollAnalysis>();
  const latestPayslip = [...payslips].sort((a, b) => a.year - b.year || a.month - b.month).at(-1);
  /** Special payment of the running tax year from the payroll model with the current Grundgehalt. */
  const taxModel = (month: string): SalaryValue | undefined => {
    const payroll = addMonths(month, -1);
    const payrollMonth = Number(payroll.slice(5, 7));
    const year = Number(payroll.slice(0, 4));
    if (!latestPayslip || (year !== 2026 && year !== 2027)) return undefined;
    const analysis = analyses.get(year) ?? analyzePayrollAutomatically(payslips, year, latestPayslip.employer, { successBonusPercent: bonus });
    analyses.set(year, analysis);
    if (!analysis.latest || payrollMonth <= analysis.latest.month) return undefined;
    const gross = analysis.forecast.months.find((entry) => entry.month === payrollMonth)?.specialGross ?? 0;
    if (gross <= 0) return { amount: 0, reason: "keine Sonderzahlung im Modell" };
    const label = payrollMonth === 12 ? successLabel : `Modell: ${currency(gross)} brutto im ${monthName(payrollMonth)}`;
    const net = analysis.projections.find((entry) => entry.month === payrollMonth)?.tax?.netSpecial;
    if (net !== undefined) return { amount: euros(net), reason: `${label} · lt. Steuerprognose` };
    const estimate = analysis.taxEstimates.find((entry) => entry.month === payrollMonth)?.special;
    return estimate
      ? { amount: euros(estimate.net), reason: `${label} · ${taxNote(estimate)}` }
      : { amount: euros(gross * SPECIAL_NET_RATIO), reason: `${label}, netto ≈ 78 %` };
  };
  const profile = latestPayslip ? payrollProfile(payslips, latestPayslip.employer) : undefined;
  const ratio = profile?.specialRatio ?? 1;
  const modelYears = new Map<number, Map<number, SpecialPaymentTax>>();
  /** A whole model year from scratch: June and November special payments, then the Successbonus, taxed in turn. */
  const modelYear = (year: number) => {
    const known = modelYears.get(year);
    if (known || !latestPayslip?.baseSalary) return known ?? new Map<number, SpecialPaymentTax>();
    const own = payslips.filter((entry) => payrollEmployerKey(entry.employer) === payrollEmployerKey(latestPayslip.employer))
      .sort((a, b) => a.year - b.year || a.month - b.month);
    const reference = regularReference(own) ?? latestPayslip;
    const credits = wageTaxCredits(own, year).monthly;
    const base = reference.monthlyTaxableBase ?? reference.regularGross * 0.82;
    const result = new Map<number, SpecialPaymentTax>();
    let before: SpecialPaymentState = { used: 0, taxable: 0, svGross: 0 };
    for (const [month, gross] of [[6, latestPayslip.baseSalary * ratio], [11, latestPayslip.baseSalary * ratio],
      [12, successBonusGross(latestPayslip, { successBonusPercent: bonus })]] as const) {
      if (gross <= 0) continue;
      const { tax, after } = specialPaymentTax({ gross: cents(gross), sixth: reference.regularGross * 2, base }, before, year, credits);
      result.set(month, tax);
      before = after;
    }
    modelYears.set(year, result);
    return result;
  };
  /**
   * Without the same month of an earlier year: a special payment in June and November (paid out in July and
   * December), as large as the own payslips showed it (share of the Grundgehalt), else one Grundgehalt, and the
   * Successbonus with the December payslip (paid out in January).
   */
  const baseModel = (month: string): SalaryValue => {
    const payroll = addMonths(month, -1);
    const payrollMonth = Number(payroll.slice(5, 7));
    if (!latestPayslip) return { amount: 0, reason: "keine Abrechnung für das Modell" };
    const due = payrollMonth === 6 || payrollMonth === 11 || (payrollMonth === 12 && bonus > 0);
    const tax = due && latestPayslip.baseSalary ? modelYear(Number(payroll.slice(0, 4))).get(payrollMonth) : undefined;
    if (tax && payrollMonth === 12) return { amount: euros(tax.net), reason: `${successLabel} · ${taxNote(tax)}` };
    if (tax) {
      const share = Math.round(ratio * 100);
      return {
        amount: euros(tax.net),
        reason: share === 100 ? `Modell: Grundgehalt im ${monthName(payrollMonth)} · ${taxNote(tax)}`
          : `Muster: ${share} % des Grundgehalts im ${monthName(payrollMonth)} lt. eigenen Abrechnungen · ${taxNote(tax)}`,
      };
    }
    return { amount: 0, reason: due ? "kein Grundgehalt belegt" : "keine Sonderzahlung im Modell" };
  };
  /** The Successbonus is paid out in January: special payments of other months besides July and December are not repeated. */
  const bonusMonth = (month: string) => bonus > 0 && month.slice(5) === "01";
  const movedBonus = (month: string) => bonus > 0 && !bonusMonth(month) && month.slice(5) !== "07" && month.slice(5) !== "12";
  const specialFor = (month: string): SalaryValue => {
    const previous = sameMonth(month);
    const modelled = taxModel(month);
    if (modelled && (modelled.amount > 0 || !previous?.special)) return modelled;
    if (previous && previous.special > 0 && movedBonus(month)) {
      return { amount: 0, reason: `Prämie wie ${short(previous.month)} kommt jetzt mit dem Dezember-Lohn (Jänner)` };
    }
    if (!previous || (bonusMonth(month) && previous.special <= 0)) return baseModel(month);
    return previous.special > 0
      ? { amount: euros(previous.special * factor(previous)), reason: `wie ${short(previous.month)}${raised(previous)}` }
      : { amount: 0, reason: `${short(previous.month)} ohne Sonderzahlung` };
  };
  const salary: SalaryValue = {
    amount: euros(level),
    reason: currentFrom.source === "payslip" ? `laufendes Netto lt. Abrechnung ${short(addMonths(currentFrom.month, -1))}`
      : `laufendes Netto lt. Gehaltseingang ${short(currentFrom.month)}`,
  };
  // On-call pay is a flat rate and does not grow with a raise; extra hours do.
  const onCall = typical("onCall", false);
  const overtime = typical("overtime", true);
  const months: SalaryForecastMonth[] = [];
  for (let month = [current, addMonths(actualThrough, 1)].sort()[1]; month <= until; month = addMonths(month, 1)) {
    const special = specialFor(month);
    const holidayMonth = sameMonth(month, "holidayWork");
    const holidayAmount = holidayMonth ? euros(holidayMonth.holidayWork * factor(holidayMonth)) : 0;
    const holidayWork: SalaryValue = holidayMonth
      ? { amount: holidayAmount, reason: holidayAmount > 0 ? `wie ${short(holidayMonth.month)}${raised(holidayMonth)}` : `${short(holidayMonth.month)} ohne Feiertagsarbeit` }
      : { amount: 0, reason: "kein Vorjahresmonat mit Daten" };
    months.push({
      month, salary, onCall, overtime, holidayWork, special,
      total: salary.amount + onCall.amount + overtime.amount + holidayWork.amount + special.amount,
    });
  }
  const oldest = recent[0];
  const raise = oldest && Math.abs(factor(oldest) - 1) >= 0.005 ? { factor: Math.round(factor(oldest) * 10_000) / 10_000, since: oldest.month } : undefined;
  return { history, actualThrough, level: salary, ...(raise ? { raise } : {}), months };
}
