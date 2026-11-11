import {
  analyzePayrollAutomatically,
  estimatePayrollBonus,
  type AutomaticPayrollAnalysis,
  type PayrollYear,
} from "@/lib/payroll-analysis";
import { payrollBreakdown } from "@/lib/payroll-overview";
import { payrollPattern } from "@/lib/payroll-pattern";
import { payslipIncome, type PayslipIncome } from "@/lib/payslip-income";
import { isReferencePayslip, payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";
import { salaryParts, type SalaryForecast, type SalaryForecastMonth } from "@/lib/salary-forecast";
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

export type PayrollMonthStatus = "actual" | "forecast" | "missing" | "open";

export const payrollStatusLabel: Record<PayrollMonthStatus, string> = {
  actual: "belegt",
  forecast: "geschätzt",
  missing: "fehlt",
  open: "offen",
};

export type PayoutPartKey = (typeof salaryParts)[number];

export const payoutPartLabel: Record<PayoutPartKey, string> = {
  salary: "Gehalt",
  onCall: "Rufbereitschaft",
  overtime: "Überstunden",
  holidayWork: "Feiertagsarbeit",
  special: "Sonderzahlung",
};

/** Net share of one payout; forecasts say where the amount comes from. */
export type PayoutPart = { key: PayoutPartKey; amount: number; reason?: string };

export type PayrollMonthDetails =
  | {
      kind: "actual";
      entry: Payslip;
      /** Paid out net; missing when the payslip neither prints nor allows an exact net. */
      net?: number;
      parts: PayoutPart[];
      regularGross: number;
      specialGross: number;
      tax?: number;
      sv?: number;
      /** Only for the latest payslip of its tax year: the documented Jahressechstel. */
      sixth?: number;
    }
  | {
      kind: "forecast";
      net?: number;
      parts: PayoutPart[];
      regularGross?: number;
      /** `undefined` while the special-payment model is unknown, 0 when none is planned. */
      specialGross?: number;
      sixth?: { sixth: number; sixthUpper?: number };
    };

export type PayrollMonthTile = {
  /** Auszahlungsmonat 1–12 of the shown year. */
  month: number;
  label: string;
  /** Abrechnungsmonat paid out in this month: always the month before. */
  payroll: { year: number; month: number; label: string };
  status: PayrollMonthStatus;
  special: boolean;
  /** Payslip of a reference year (2025): pattern for forecasts only, never in the budget. */
  reference: boolean;
  /** Net payout; gross only when no net is known. */
  headline?: { metric: "net" | "gross"; value: number };
  /** Present for months that can be opened. */
  details?: PayrollMonthDetails;
};

export type PayrollTileSources = {
  view: PayrollPresentation;
  /** Analysis of the previous tax year: its December payslip is paid out in January. */
  previous?: AutomaticPayrollAnalysis;
  payslips: readonly Payslip[];
  employer: string;
  /** Net forecast by budget month – the same values the budget update proposes. */
  forecast?: SalaryForecast;
};

const periodIndex = (year: number, month: number) => year * 12 + month - 1;
const shown = (parts: PayoutPart[]) => parts.filter((part) => part.key === "salary" || part.amount > 0);
const incomeParts = (income: PayslipIncome) => shown(salaryParts.map((key) => ({ key, amount: income[key] })));
const forecastParts = (month: SalaryForecastMonth) =>
  shown(salaryParts.map((key) => ({ key, amount: month[key].amount, reason: month[key].reason })));

/**
 * Twelve tiles by Auszahlungsmonat: the October payslip is paid in November, December's in January of the next year.
 * Documented months come from the payslips, later months from the salary forecast and the payroll model.
 */
export function payrollMonthTiles({ view, previous, payslips, employer, forecast }: PayrollTileSources): PayrollMonthTile[] {
  const { year, analysis } = view;
  const key = payrollEmployerKey(employer);
  const own = payslips.filter((entry) => payrollEmployerKey(entry.employer) === key);
  const pattern = payrollPattern(own);
  const periods = own.map((entry) => periodIndex(entry.year, entry.month));
  const first = Math.min(...periods);
  const last = Math.max(...periods);
  return Array.from({ length: 12 }, (_, index): PayrollMonthTile => {
    const month = index + 1;
    const payroll = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
    const tile = {
      month,
      label: monthLabel(payrollPeriod(year, month)),
      payroll: { ...payroll, label: monthLabel(payrollPeriod(payroll.year, payroll.month)) },
      special: false,
      reference: false,
    };
    const model = payroll.year === year ? analysis : previous;
    const entry = own.find((candidate) => candidate.year === payroll.year && candidate.month === payroll.month);
    if (entry) {
      const income = payslipIncome(entry, pattern);
      const breakdown = payrollBreakdown(entry);
      return {
        ...tile,
        status: "actual",
        reference: isReferencePayslip(entry),
        special: breakdown.special !== undefined,
        headline: income ? { metric: "net", value: income.net } : { metric: "gross", value: breakdown.gross },
        details: {
          kind: "actual",
          entry,
          net: income?.net,
          parts: income ? incomeParts(income) : [],
          regularGross: entry.regularGross,
          specialGross: breakdown.special?.gross ?? 0,
          tax: breakdown.tax,
          sv: breakdown.sv,
          sixth: model?.actual?.month === payroll.month ? model.actual.sixth : undefined,
        },
      };
    }
    const at = periodIndex(payroll.year, payroll.month);
    if (at < last) return { ...tile, status: at > first ? "missing" : "open" };
    const planned = forecast?.months.find((candidate) => candidate.month === payrollPeriod(year, month));
    const gross = model?.forecast.months.find((candidate) => candidate.month === payroll.month);
    const sixth = own.length ? model?.sixthEstimates.find((candidate) => candidate.month === payroll.month) : undefined;
    if (!planned && !gross && !sixth) return { ...tile, status: "open" };
    return {
      ...tile,
      status: "forecast",
      special: planned ? planned.special.amount > 0 : (gross?.specialGross ?? 0) > 0,
      ...(planned
        ? { headline: { metric: "net" as const, value: planned.total } }
        : gross ? { headline: { metric: "gross" as const, value: gross.regularGross + gross.specialGross } } : {}),
      details: {
        kind: "forecast",
        net: planned?.total,
        parts: planned ? forecastParts(planned) : [],
        regularGross: gross?.regularGross,
        specialGross: model?.hasSpecialPaymentModel ? gross?.specialGross : undefined,
        sixth,
      },
    };
  });
}
