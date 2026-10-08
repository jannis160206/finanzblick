import {
  analyzePayrollAutomatically,
  estimatePayrollBonus,
} from "@/lib/payroll-analysis";
import type { Payslip } from "@/lib/payslip-schema";
import { currency, monthLabel } from "@/lib/format";

export const payrollPeriod = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;
export const payrollMoney = (value: number | undefined) =>
  value === undefined ? "Noch offen" : currency(value);
export const payrollEstimate = (
  value: { sixth: number; sixthUpper?: number } | undefined,
) =>
  value?.sixthUpper !== undefined
    ? `${currency(value.sixth)} – ${currency(value.sixthUpper)}`
    : payrollMoney(value?.sixth);

export function payrollPresentation(
  payslips: Payslip[],
  year: Payslip["year"],
  employer: string,
  asOf: string,
) {
  const analysis = analyzePayrollAutomatically(payslips, year, employer);
  const { latest, actual } = analysis;
  const dashboardYear = Number(asOf.slice(0, 4));
  const nextMonth =
    year === dashboardYear
      ? Number(asOf.slice(5, 7))
      : year < dashboardYear
        ? 13
        : 1;
  const estimateMonth = Math.max(latest?.month ?? 1, Math.min(12, nextMonth));
  const nextPayment = analysis.forecast.months.find(
    (entry) => entry.specialGross > 0 && entry.month >= nextMonth,
  );
  return {
    analysis,
    latest,
    actual,
    year,
    estimateMonth,
    nextPayment,
    currentEstimate: analysis.sixthEstimates.find(
      (entry) => entry.month === estimateMonth,
    ),
    yearEndSixth: analysis.yearEnd?.sixth ?? actual?.controlSixth,
    yearEndEstimate: analysis.sixthEstimates.find(
      (entry) => entry.month === 12,
    ),
    next: analysis.projections.find(
      (entry) => entry.month === nextPayment?.month,
    ),
    bonus: estimatePayrollBonus(
      payslips,
      analysis,
      nextPayment?.month ?? estimateMonth,
    ),
    missing: analysis.missingMonths
      .map((month) => monthLabel(payrollPeriod(year, month)))
      .join(", "),
    rough: analysis.estimatedHistoryMonths.length > 0,
    uncertain: analysis.unresolvedSixthMonths.length > 0,
    projectedMonths: analysis.sixthEstimates.filter(
      (entry) => latest && entry.month > latest.month,
    ),
  };
}
export type PayrollPresentation = ReturnType<typeof payrollPresentation>;
