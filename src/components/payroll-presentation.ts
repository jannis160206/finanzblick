import {
  analyzePayrollAutomatically,
  estimatePayrollBonus,
  type PayrollModelOptions,
  type PayrollYear,
} from "@/lib/payroll-analysis";
import type { Payslip } from "@/lib/payslip-schema";
import { currency, monthLabel } from "@/lib/format";

export const payrollPeriod = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;
export const payrollMoney = (value: number | undefined) =>
  value === undefined ? "Noch offen" : currency(value);
const wholeEuro = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
  useGrouping: "always",
});
/** Rounded to whole euros for compact overviews; details always show the exact amount. */
export const payrollWholeMoney = (value: number) => wholeEuro.format(value);
export const payrollEstimate = (
  value: { sixth: number; sixthUpper?: number } | undefined,
) =>
  value?.sixthUpper !== undefined
    ? `${currency(value.sixth)} – ${currency(value.sixthUpper)}`
    : payrollMoney(value?.sixth);

export function payrollPresentation(
  payslips: Payslip[],
  year: PayrollYear,
  employer: string,
  asOf: string,
  options: PayrollModelOptions = {},
) {
  const analysis = analyzePayrollAutomatically(payslips, year, employer, options);
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

/** "review": documented, but kept out of the budget because the numbers contradict each other. */
export type PayrollMonthStatus = "actual" | "review" | "forecast" | "missing" | "open";

export const payrollStatusLabel: Record<PayrollMonthStatus, string> = {
  actual: "belegt",
  review: "prüfen",
  forecast: "geschätzt",
  missing: "fehlt",
  open: "offen",
};
