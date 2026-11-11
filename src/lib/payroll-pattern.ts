import { payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";

/**
 * What a normal month looks like for one employer, learned from the stored payslips. On-call pay is a flat rate:
 * an amount that recurs in a year (at least three times) is that year's normal level and carries over to later
 * years; more on a payslip means on-call duty on public holidays. Years without a recurring amount (e.g. paid per
 * duty week) have no flat rate, so their on-call pay is not split.
 */
export type PayrollPattern = {
  /** Flat rate of the latest year that has one. */
  normalOnCallGross?: number;
  /** Flat rate per calendar year in which it was recognised. */
  onCallByYear?: Record<number, number>;
};

/** Gross variable pay of one payslip: normal on-call, holiday work (incl. on-call above normal) and other extra hours. */
export type VariablePay = {
  onCall: number;
  holiday: number;
  overtime: number;
  /** A flat rate was known for the payslip's year, so on-call above it could be told apart as holiday work. */
  rated: boolean;
};

/** Patterns learned from the payslips of one employer, for forecasts and checks. */
export type PayrollProfile = {
  payslips: number;
  years: number[];
  onCallByYear: Record<number, number>;
  /** Months (1–12) with holiday work in a year with a flat rate. */
  holidayMonths: number[];
  /** Months (1–12) with a special payment, and its typical size relative to the Grundgehalt. */
  specialMonths: number[];
  specialRatio?: number;
  /** Months (1–12) with a bonus taxed like regular pay (e.g. VEB-Prämie). */
  bonusMonths: number[];
  /** Most payslips transfer the salary in advance and the rest as a separate payout. */
  advance: boolean;
};

const MIN_REPEAT = 3;
const cents = (value: number) => Math.round(value * 100);
const period = (entry: Pick<Payslip, "year" | "month">) => entry.year * 12 + entry.month;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function flatRate(values: number[]): number | undefined {
  // Whole euros as buckets: the same flat rate can differ by a few cents (rounding, aliquot days).
  const buckets = new Map<number, number[]>();
  for (const value of values) {
    const key = Math.round(value);
    buckets.set(key, [...(buckets.get(key) ?? []), value]);
  }
  const best = [...buckets].filter(([, bucket]) => bucket.length >= MIN_REPEAT)
    // The most frequent amount; on a tie the lower one, because holidays only ever add to it.
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0];
  if (!best) return undefined;
  const sorted = [...best[1]].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

const ownPayslips = (payslips: readonly Payslip[], employer?: string) => payslips
  .filter((entry) => !employer || payrollEmployerKey(entry.employer) === payrollEmployerKey(employer))
  .sort((a, b) => period(a) - period(b));

export function payrollPattern(payslips: readonly Payslip[], employer?: string): PayrollPattern {
  const own = ownPayslips(payslips, employer);
  const onCallByYear: Record<number, number> = {};
  for (const year of new Set(own.map((entry) => entry.year))) {
    const rate = flatRate(own.filter((entry) => entry.year === year).map((entry) => entry.onCallGross ?? 0).filter((value) => value > 0));
    if (rate !== undefined) onCallByYear[year] = rate;
  }
  const years = Object.keys(onCallByYear).map(Number).sort((a, b) => a - b);
  if (!years.length) return {};
  return { normalOnCallGross: onCallByYear[years.at(-1)!], onCallByYear };
}

/** The flat rate that applies to a year: its own, else the one of the latest earlier year. */
export function normalOnCall(pattern: PayrollPattern, year: number): number | undefined {
  if (!pattern.onCallByYear) return pattern.normalOnCallGross;
  const years = Object.keys(pattern.onCallByYear).map(Number).filter((item) => item <= year).sort((a, b) => a - b);
  return years.length ? pattern.onCallByYear[years.at(-1)!] : undefined;
}

/** Patterns per employer, keyed like payrollEmployerKey. */
export function payrollPatterns(payslips: readonly Payslip[]): Map<string, PayrollPattern> {
  const employers = new Set(payslips.map((entry) => payrollEmployerKey(entry.employer)));
  return new Map([...employers].map((key) => [key, payrollPattern(payslips.filter((entry) => payrollEmployerKey(entry.employer) === key))]));
}

export function variablePay(entry: Payslip, pattern: PayrollPattern = {}): VariablePay {
  const onCallGross = entry.onCallGross ?? 0;
  const holidayLines = entry.holidayWorkGross ?? 0;
  const normal = normalOnCall(pattern, entry.year);
  // Cents above the flat rate are rounding, not a holiday duty.
  const onCall = normal === undefined || onCallGross - normal < 1 ? onCallGross : normal;
  // Only Grundgehalt, on-call and holiday lines are known; the rest of the regular gross is extra hours.
  const overtime = entry.baseSalary === undefined ? 0
    : Math.max(0, cents(entry.regularGross) - cents(entry.baseSalary) - cents(onCallGross) - cents(holidayLines)) / 100;
  return {
    onCall,
    holiday: (cents(holidayLines) + cents(onCallGross) - cents(onCall)) / 100,
    overtime,
    rated: normal !== undefined || onCallGross === 0,
  };
}

/** Everything the own payslips (reference years included) tell about the usual pay of one employer. */
export function payrollProfile(payslips: readonly Payslip[], employer?: string): PayrollProfile {
  const own = ownPayslips(payslips, employer);
  const pattern = payrollPattern(own);
  const months = (test: (entry: Payslip) => boolean) => [...new Set(own.filter(test).map((entry) => entry.month))].sort((a, b) => a - b);
  const ratios = own.filter((entry) => entry.specialGross > 0 && entry.baseSalary).map((entry) => entry.specialGross / entry.baseSalary!);
  const advance = own.filter((entry) => entry.advancePay !== undefined && entry.payout !== undefined).length;
  return {
    payslips: own.length,
    years: [...new Set(own.map((entry) => entry.year))].sort((a, b) => a - b),
    onCallByYear: pattern.onCallByYear ?? {},
    holidayMonths: months((entry) => {
      const pay = variablePay(entry, pattern);
      return pay.rated && pay.holiday > 0;
    }),
    specialMonths: months((entry) => entry.specialGross > 0),
    ...(ratios.length ? { specialRatio: Math.round(median(ratios) * 1000) / 1000 } : {}),
    bonusMonths: months((entry) => (entry.unresolvedSixthBonus ?? 0) > 0),
    advance: own.length > 0 && advance * 2 > own.length,
  };
}
