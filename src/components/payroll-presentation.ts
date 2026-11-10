import {
  analyzePayrollAutomatically,
  estimatePayrollBonus,
} from "@/lib/payroll-analysis";
import { payrollYearMonths, type PayrollStripMonth } from "@/lib/payroll-overview";
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

export type PayrollMonthStatus = PayrollStripMonth["kind"];

export const payrollStatusLabel: Record<PayrollMonthStatus, string> = {
  actual: "belegt",
  forecast: "geschätzt",
  missing: "fehlt",
  open: "offen",
};

export type PayrollMonthDetails =
  | {
      kind: "actual";
      net?: number;
      regularGross: number;
      specialGross: number;
      tax?: number;
      sv?: number;
      /** Only for the latest payslip: the documented Jahressechstel. */
      sixth?: number;
    }
  | {
      kind: "forecast";
      regularGross?: number;
      /** `undefined` while the special-payment model is unknown, 0 when none is planned. */
      specialGross?: number;
      sixth?: { sixth: number; sixthUpper?: number };
    };

export type PayrollMonthTile = {
  month: number;
  label: string;
  status: PayrollMonthStatus;
  special: boolean;
  /** Net when the payslip prints it, otherwise gross (always gross for forecasts). */
  headline?: { metric: "net" | "gross"; value: number };
  /** Present for months that can be opened. */
  details?: PayrollMonthDetails;
};

/**
 * Twelve month tiles from documented payslips and the existing automatic forecast. Only rearranges values the
 * analysis already computed; nothing is estimated here.
 */
export function payrollMonthTiles(
  view: PayrollPresentation,
  entries: readonly Payslip[],
): PayrollMonthTile[] {
  const { analysis, actual, year } = view;
  const latest = entries.reduce((last, entry) => Math.max(last, entry.month), 0);
  return payrollYearMonths(entries, analysis.forecast.months).map((entry): PayrollMonthTile => {
    const label = monthLabel(payrollPeriod(year, entry.month));
    if (entry.kind === "actual") {
      const { breakdown } = entry;
      return {
        month: entry.month,
        label,
        status: "actual",
        special: entry.special,
        headline:
          breakdown.net === undefined
            ? { metric: "gross", value: breakdown.gross }
            : { metric: "net", value: breakdown.net },
        details: {
          kind: "actual",
          net: breakdown.net,
          regularGross: breakdown.regular.gross,
          specialGross: breakdown.special?.gross ?? 0,
          tax: breakdown.tax,
          sv: breakdown.sv,
          sixth: actual?.month === entry.month ? actual.sixth : undefined,
        },
      };
    }
    const sixth = analysis.sixthEstimates.find((estimate) => estimate.month === entry.month);
    // A projected sixth without a forecast row still deserves its month details instead of a blank tile.
    if (entry.kind === "forecast" || (entry.kind === "open" && latest > 0 && entry.month > latest && sixth)) {
      const planned = analysis.forecast.months.find((candidate) => candidate.month === entry.month);
      return {
        month: entry.month,
        label,
        status: "forecast",
        special: entry.kind === "forecast" && entry.special,
        ...(entry.kind === "forecast" ? { headline: { metric: "gross" as const, value: entry.gross } } : {}),
        details: {
          kind: "forecast",
          regularGross: planned?.regularGross,
          specialGross: analysis.hasSpecialPaymentModel ? planned?.specialGross : undefined,
          sixth,
        },
      };
    }
    return { month: entry.month, label, status: entry.kind, special: false };
  });
}
