import { payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";

/**
 * What a normal month looks like for one employer, learned from the stored payslips. On-call pay is a flat rate:
 * the amount most months show is the normal level; more on the payslip means on-call duty on public holidays.
 */
export type PayrollPattern = { normalOnCallGross?: number };

/** Gross variable pay of one payslip: normal on-call, holiday work (incl. on-call above normal) and other extra hours. */
export type VariablePay = { onCall: number; holiday: number; overtime: number };

const LOOKBACK = 12;
const cents = (value: number) => Math.round(value * 100);
const period = (entry: Pick<Payslip, "year" | "month">) => entry.year * 12 + entry.month;

export function payrollPattern(payslips: readonly Payslip[], employer?: string): PayrollPattern {
  const own = payslips
    .filter((entry) => !employer || payrollEmployerKey(entry.employer) === payrollEmployerKey(employer))
    .sort((a, b) => period(a) - period(b))
    .slice(-LOOKBACK);
  const values = own.map((entry) => entry.onCallGross ?? 0).filter((value) => value > 0);
  if (!values.length) return {};
  // Most frequent amount (whole euros); on a tie the lower one, because holidays only ever add to it.
  const counts = new Map<number, number[]>();
  for (const value of values) {
    const key = Math.round(value);
    counts.set(key, [...(counts.get(key) ?? []), value]);
  }
  const [, bucket] = [...counts].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0];
  const sorted = [...bucket].sort((a, b) => a - b);
  return { normalOnCallGross: sorted[Math.floor((sorted.length - 1) / 2)] };
}

/** Patterns per employer, keyed like payrollEmployerKey. */
export function payrollPatterns(payslips: readonly Payslip[]): Map<string, PayrollPattern> {
  const employers = new Set(payslips.map((entry) => payrollEmployerKey(entry.employer)));
  return new Map([...employers].map((key) => [key, payrollPattern(payslips.filter((entry) => payrollEmployerKey(entry.employer) === key))]));
}

export function variablePay(entry: Payslip, pattern: PayrollPattern = {}): VariablePay {
  const onCallGross = entry.onCallGross ?? 0;
  const holidayLines = entry.holidayWorkGross ?? 0;
  const normal = pattern.normalOnCallGross;
  const onCall = normal === undefined ? onCallGross : Math.min(onCallGross, normal);
  // Only Grundgehalt, on-call and holiday lines are known; the rest of the regular gross is extra hours.
  const overtime = entry.baseSalary === undefined ? 0
    : Math.max(0, cents(entry.regularGross) - cents(entry.baseSalary) - cents(onCallGross) - cents(holidayLines)) / 100;
  return { onCall, holiday: (cents(holidayLines) + cents(onCallGross) - cents(onCall)) / 100, overtime };
}
