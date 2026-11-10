import {
  payrollEmployerKey,
  type Payslip,
  type PayrollForecastMonth,
} from "@/lib/payslip-schema";

// Presentation helpers for "Gehalt & Steuern": only sums, differences and shares of printed payslip values.
// No tax logic lives here; forecasts come from the existing payroll analysis.

export type PayrollAmountKey = "net" | "tax" | "sv" | "other";

export type PayrollPart = { gross: number; tax?: number; sv?: number };

export type PayrollMonthBreakdown = {
  year: number;
  month: number;
  employer: string;
  gross: number;
  regular: PayrollPart;
  special?: PayrollPart;
  unresolvedBonus?: number;
  net?: number;
  tax?: number;
  sv?: number;
  other?: number;
  taxComplete: boolean;
  svComplete: boolean;
  shares: Partial<Record<PayrollAmountKey, number>>;
};

export type PayrollComparison = {
  year: number;
  month: number;
  metric: "net" | "gross";
  delta: number;
  adjacent: boolean;
};

export type PayrollTotal = { value: number; months: number };

export type PayrollYearTotals = {
  months: number;
  gross: PayrollTotal;
  net?: PayrollTotal;
  tax?: PayrollTotal;
  sv?: PayrollTotal;
  deductionRate?: { value: number; months: number };
};

export type PayrollStripMonth =
  | { month: number; kind: "actual"; breakdown: PayrollMonthBreakdown; special: boolean }
  | {
      month: number;
      kind: "forecast";
      gross: number;
      regularGross: number;
      specialGross: number;
      special: boolean;
    }
  | { month: number; kind: "missing" | "open" };

const cents = (value: number) => Math.round((value + Number.EPSILON) * 100);
const total = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + cents(value), 0) / 100;
const present = (values: readonly (number | undefined)[]) =>
  values.filter((value): value is number => value !== undefined);
const periodIndex = (entry: { year: number; month: number }) =>
  entry.year * 12 + entry.month - 1;
const sameEmployer = (entry: Pick<Payslip, "employer">, employer: string) =>
  payrollEmployerKey(entry.employer) === payrollEmployerKey(employer);

export function employerPayslips(
  payslips: readonly Payslip[],
  year: number,
  employer: string,
): Payslip[] {
  return payslips
    .filter((entry) => entry.year === year && sameEmployer(entry, employer))
    .sort((left, right) => left.month - right.month);
}

export function payrollBreakdown(entry: Payslip): PayrollMonthBreakdown {
  // A tariff-taxed bonus with an open sixth assignment is outside both gross classes but still paid gross.
  const bonus = entry.unresolvedSixthBonus ?? 0;
  const gross = total([entry.regularGross, entry.specialGross, bonus]);
  const hasSpecial = entry.specialGross > 0 || bonus > 0;
  const taxParts = present([entry.regularTax, entry.specialTax]);
  const svParts = present([entry.regularSv, entry.specialSv]);
  const tax = taxParts.length ? total(taxParts) : undefined;
  const sv = svParts.length ? total(svParts) : undefined;
  const taxComplete =
    entry.regularTax !== undefined &&
    (entry.specialGross === 0 || entry.specialTax !== undefined);
  const svComplete =
    entry.regularSv !== undefined && (!hasSpecial || entry.specialSv !== undefined);
  const net = entry.netPay;
  const rest =
    net !== undefined && tax !== undefined && sv !== undefined && taxComplete && svComplete
      ? total([gross, -net, -tax, -sv])
      : undefined;
  const other = rest !== undefined && rest >= 0 ? rest : undefined;
  const share = (value: number | undefined) =>
    value === undefined || gross <= 0 ? undefined : value / gross;
  const shares: PayrollMonthBreakdown["shares"] = {};
  for (const [key, value] of [
    ["net", net],
    ["tax", tax],
    ["sv", sv],
    ["other", other],
  ] as const) {
    const result = share(value);
    if (result !== undefined) shares[key] = result;
  }
  return {
    year: entry.year,
    month: entry.month,
    employer: entry.employer,
    gross,
    regular: { gross: entry.regularGross, tax: entry.regularTax, sv: entry.regularSv },
    ...(hasSpecial
      ? {
          special: {
            gross: total([entry.specialGross, bonus]),
            tax: entry.specialTax,
            sv: entry.specialSv,
          },
        }
      : {}),
    ...(bonus > 0 ? { unresolvedBonus: bonus } : {}),
    net,
    tax,
    sv,
    other,
    taxComplete,
    svComplete,
    shares,
  };
}

/** Latest earlier payslip of the same employer, across years. */
export function previousPayslip(
  payslips: readonly Payslip[],
  entry: Pick<Payslip, "year" | "month" | "employer">,
): Payslip | undefined {
  const at = periodIndex(entry);
  let previous: Payslip | undefined;
  for (const candidate of payslips) {
    if (!sameEmployer(candidate, entry.employer) || periodIndex(candidate) >= at) continue;
    if (!previous || periodIndex(candidate) > periodIndex(previous)) previous = candidate;
  }
  return previous;
}

export function previousYearPayslip(
  payslips: readonly Payslip[],
  entry: Pick<Payslip, "year" | "month" | "employer">,
): Payslip | undefined {
  return payslips.find(
    (candidate) =>
      candidate.year === entry.year - 1 &&
      candidate.month === entry.month &&
      sameEmployer(candidate, entry.employer),
  );
}

/** Net difference when both months print a net amount, otherwise the gross difference. */
export function comparePayroll(
  current: PayrollMonthBreakdown,
  reference: PayrollMonthBreakdown | undefined,
): PayrollComparison | undefined {
  if (!reference) return undefined;
  const byNet = current.net !== undefined && reference.net !== undefined;
  const delta = byNet
    ? total([current.net ?? 0, -(reference.net ?? 0)])
    : total([current.gross, -reference.gross]);
  return {
    year: reference.year,
    month: reference.month,
    metric: byNet ? "net" : "gross",
    delta,
    adjacent: periodIndex(current) - periodIndex(reference) === 1,
  };
}

export function payrollYearTotals(entries: readonly Payslip[]): PayrollYearTotals {
  const months = entries.map(payrollBreakdown);
  const sum = (key: "gross" | "net" | "tax" | "sv"): PayrollTotal | undefined => {
    const values = present(months.map((month) => month[key]));
    return values.length ? { value: total(values), months: values.length } : undefined;
  };
  const withNet = months.flatMap((month) =>
    month.net !== undefined && month.gross > 0 ? [{ gross: month.gross, net: month.net }] : [],
  );
  const grossWithNet = total(withNet.map((month) => month.gross));
  const netWithGross = total(withNet.map((month) => month.net));
  return {
    months: months.length,
    gross: sum("gross") ?? { value: 0, months: 0 },
    net: sum("net"),
    tax: sum("tax"),
    sv: sum("sv"),
    ...(grossWithNet > 0
      ? {
          deductionRate: {
            value: (grossWithNet - netWithGross) / grossWithNet,
            months: withNet.length,
          },
        }
      : {}),
  };
}

/**
 * Twelve months of one year and employer: documented payslips, gaps before the latest payslip and the
 * existing automatic forecast after it.
 */
export function payrollYearMonths(
  entries: readonly Payslip[],
  forecast: readonly PayrollForecastMonth[],
): PayrollStripMonth[] {
  const latest = entries.reduce((last, entry) => Math.max(last, entry.month), 0);
  return Array.from({ length: 12 }, (_, index): PayrollStripMonth => {
    const month = index + 1;
    const entry = entries.find((candidate) => candidate.month === month);
    if (entry) {
      return {
        month,
        kind: "actual",
        breakdown: payrollBreakdown(entry),
        special: entry.specialGross > 0,
      };
    }
    if (month < latest) return { month, kind: "missing" };
    const planned = latest > 0 ? forecast.find((candidate) => candidate.month === month) : undefined;
    if (planned) {
      return {
        month,
        kind: "forecast",
        gross: total([planned.regularGross, planned.specialGross]),
        regularGross: planned.regularGross,
        specialGross: planned.specialGross,
        special: planned.specialGross > 0,
      };
    }
    return { month, kind: "open" };
  });
}
