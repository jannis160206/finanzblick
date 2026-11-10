import { actualBookings, addMonths, bookingMonth, classify } from "@/lib/calc";
import { currency, monthLabel, percent } from "@/lib/format";
import { analyzePayrollAutomatically, type AutomaticPayrollAnalysis, type PayrollYear } from "@/lib/payroll-analysis";
import { payrollCategory } from "@/lib/payroll";
import { payslipIncome } from "@/lib/payslip-income";
import type { Payslip } from "@/lib/payslip-schema";
import { planningEndMonth } from "@/lib/planning-range";
import type { AppState } from "@/lib/types";

export const salaryParts = ["salary", "onCall", "overtime", "holidayWork", "special"] as const;
export type SalaryPart = (typeof salaryParts)[number];
type VariablePart = "onCall" | "overtime" | "holidayWork";

/** Pay that reached one budget month (the month after the Abrechnungsmonat), split like the income rows. */
export type SalaryInflow = Record<SalaryPart, number> & {
  month: string;
  source: "payslip" | "bank";
  /** Grundgehalt printed on the payslip; a change marks a raise. */
  base?: number;
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

/** Net share of a modelled special payment without a tax projection: 17,07 % SV, then about 6 % Lohnsteuer (§ 67 EStG). */
export const SPECIAL_NET_RATIO = 0.78;
// A persistent change of the regular net salary by more than 3 % counts as a raise (or cut).
const STEP = 0.03;
// A salary booking above 140 % of the regular level contains a special payment.
const SPIKE = 1.4;
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
 * Splits a payslip like the month plan does and separates overtime/Mehrleistungen: regular gross above the
 * Grundgehalt without on-call and holiday work, converted to net in proportion to the regular net pay.
 */
export function payslipInflow(entry: Payslip): SalaryInflow | undefined {
  const income = payslipIncome(entry);
  if (!income) return undefined;
  const regularGross = entry.regularGross + (entry.unresolvedSixthBonus ?? 0);
  const extraGross = entry.baseSalary
    ? Math.max(0, entry.regularGross - entry.baseSalary - (entry.onCallGross ?? 0) - (entry.holidayWorkGross ?? 0)) : 0;
  const regularNet = income.salary + income.onCall + income.holidayWork;
  let overtime = regularGross > 0 ? cents(regularNet * extraGross / regularGross) : 0;
  let { salary, onCall } = income;
  // With an advance transfer the salary is the fixed part; extra pay is in the remaining payout.
  if (entry.advancePay !== undefined && entry.payout !== undefined && cents(salary) === cents(entry.advancePay)) {
    overtime = Math.min(overtime, onCall);
    onCall = cents(onCall - overtime);
  } else {
    overtime = Math.min(overtime, salary);
    salary = cents(salary - overtime);
  }
  return {
    month: income.month, source: "payslip", salary, onCall, overtime, holidayWork: income.holidayWork, special: income.special,
    ...(entry.baseSalary ? { base: entry.baseSalary } : {}),
    known: { onCall: income.splitKnown, overtime: !!entry.baseSalary, holidayWork: income.splitKnown },
  };
}

function payslipInflows(payslips: readonly Payslip[]) {
  const result = new Map<string, SalaryInflow>();
  for (const entry of payslips) {
    const inflow = payslipInflow(entry);
    if (!inflow) continue;
    const existing = result.get(inflow.month);
    if (!existing) { result.set(inflow.month, inflow); continue; }
    for (const part of salaryParts) existing[part] = cents(existing[part] + inflow[part]);
    for (const part of ["onCall", "overtime", "holidayWork"] as const) existing.known[part] &&= inflow.known[part];
    existing.base = existing.base && inflow.base ? existing.base + inflow.base : undefined;
  }
  return result;
}

/** Salary bookings of the bank (Gehalt, Rufbereitschaft, special payments) per budget month, for months without a payslip. */
function bankInflows(state: AppState, today: string) {
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
  for (const [month, inflow] of result) if (inflow.salary <= 0) result.delete(month);
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

/**
 * Salary forecast per future budget month from the pay of the last twelve months (payslips, otherwise salary
 * bookings), scaled to today's salary level. Special payments and holiday work repeat the same month of the latest
 * year with data; without one the special payment comes from the payroll model (June/November → July/December).
 * On-call pay and overtime are twelve-month averages. Every value says where it comes from.
 */
export function salaryForecast(state: AppState, options: { today?: string; until?: string } = {}): SalaryForecast {
  const today = options.today ?? state.settings.asOf;
  const current = today.slice(0, 7);
  const until = options.until ?? planningEndMonth(today);
  const payslips = state.payslips ?? [];
  const fromPayslips = payslipInflows(payslips);
  const fromBank = bankInflows(state, today);
  const history = [...new Set([...fromPayslips.keys(), ...fromBank.keys()])].sort()
    .map((month) => fromPayslips.get(month) ?? fromBank.get(month)!)
    .filter((item) => item.salary > 0);
  if (!history.length) return { history, months: [] };
  const { levels, current: level, currentFrom } = salaryLevels(history);
  for (const item of history) {
    const own = levels.get(item.month)!;
    if (item.source === "bank" && item.salary > own * SPIKE) {
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
  const average = (part: VariablePart): SalaryValue => {
    const known = recent.filter((item) => item.known[part]);
    if (!known.length) return { amount: 0, reason: `keine Daten zu ${partLabel[part]}` };
    const amount = euros(known.reduce((sum, item) => sum + item[part] * factor(item), 0) / known.length);
    const scaled = known.some((item) => Math.abs(factor(item) - 1) >= 0.005);
    return { amount, reason: `Ø ${known.length} ${known.length === 1 ? "Monat" : "Monate"}${scaled ? " · inkl. Erhöhung" : ""}` };
  };
  const sameMonth = (month: string, part?: VariablePart) => history.findLast((item) =>
    item.month < month && item.month.slice(5) === month.slice(5) && (!part || item.known[part]));
  const analyses = new Map<PayrollYear, AutomaticPayrollAnalysis>();
  const latestPayslip = [...payslips].sort((a, b) => a.year - b.year || a.month - b.month).at(-1);
  const modelled = (month: string): SalaryValue => {
    const payroll = addMonths(month, -1);
    const payrollMonth = Number(payroll.slice(5, 7));
    if (!latestPayslip) return { amount: 0, reason: "keine Abrechnung für das Modell" };
    const year = Number(payroll.slice(0, 4));
    if (year === 2026 || year === 2027) {
      const analysis = analyses.get(year) ?? analyzePayrollAutomatically(payslips, year, latestPayslip.employer);
      analyses.set(year, analysis);
      const gross = analysis.latest ? analysis.forecast.months.find((entry) => entry.month === payrollMonth)?.specialGross ?? 0 : 0;
      if (gross > 0) {
        const net = analysis.projections.find((entry) => entry.month === payrollMonth)?.tax?.netSpecial;
        return net !== undefined
          ? { amount: euros(net), reason: `Modell: Sonderzahlung ${monthName(payrollMonth)} lt. Steuerprognose` }
          : { amount: euros(gross * SPECIAL_NET_RATIO), reason: `Modell: ${currency(gross)} brutto im ${monthName(payrollMonth)}, netto ≈ 78 %` };
      }
      if (analysis.latest && payrollMonth > analysis.latest.month) return { amount: 0, reason: "keine Sonderzahlung im Modell" };
    }
    if ((payrollMonth === 6 || payrollMonth === 11) && latestPayslip.baseSalary) {
      return { amount: euros(latestPayslip.baseSalary * SPECIAL_NET_RATIO), reason: `Modell: Grundgehalt im ${monthName(payrollMonth)}, netto ≈ 78 %` };
    }
    return { amount: 0, reason: payrollMonth === 6 || payrollMonth === 11 ? "kein Grundgehalt belegt" : "keine Sonderzahlung im Modell" };
  };
  const salary: SalaryValue = {
    amount: euros(level),
    reason: currentFrom.source === "payslip" ? `laufendes Netto lt. Abrechnung ${short(addMonths(currentFrom.month, -1))}`
      : `laufendes Netto lt. Gehaltseingang ${short(currentFrom.month)}`,
  };
  const onCall = average("onCall");
  const overtime = average("overtime");
  const months: SalaryForecastMonth[] = [];
  for (let month = [current, addMonths(actualThrough, 1)].sort()[1]; month <= until; month = addMonths(month, 1)) {
    const previous = sameMonth(month);
    const special: SalaryValue = !previous ? modelled(month) : previous.special > 0
      ? { amount: euros(previous.special * factor(previous)), reason: `wie ${short(previous.month)}${raised(previous)}` }
      : { amount: 0, reason: `${short(previous.month)} ohne Sonderzahlung` };
    const holidayMonth = sameMonth(month, "holidayWork");
    const holidayWork: SalaryValue = holidayMonth
      ? { amount: euros(holidayMonth.holidayWork * factor(holidayMonth)), reason: `wie ${short(holidayMonth.month)}${raised(holidayMonth)}` }
      : average("holidayWork");
    months.push({
      month, salary, onCall, overtime, holidayWork, special,
      total: salary.amount + onCall.amount + overtime.amount + holidayWork.amount + special.amount,
    });
  }
  const oldest = recent[0];
  const raise = oldest && Math.abs(factor(oldest) - 1) >= 0.005 ? { factor: Math.round(factor(oldest) * 10_000) / 10_000, since: oldest.month } : undefined;
  return { history, actualThrough, level: salary, ...(raise ? { raise } : {}), months };
}
