import type { Payslip } from "@/lib/payslip-schema";

/**
 * Austrian wage tax (Lohnsteuer). There are no tax classes: the progressive tariff (§ 33 Abs. 1 EStG) applies to the
 * annualised monthly base (§ 66), fixed tax credits (Absetzbeträge) are deducted, and special payments (sonstige
 * Bezüge) within the Jahressechstel are taxed at fixed rates (§ 67 Abs. 1/2). The part above the sixth is taxed with
 * the regular pay of its month.
 */
export type WageTaxYear = 2025 | 2026 | 2027;

type YearValues = {
  /** Upper limits of the 0, 20, 30, 40, 48 and 50 % brackets; above the last one 55 %. */
  brackets: readonly number[];
  /** Verkehrsabsetzbetrag (§ 33 Abs. 5 Z 1). */
  trafficCredit: number;
  /** Freigrenze (§ 67 Abs. 1): up to this Jahressechstel special payments stay tax-free. */
  freeLimit: number;
};

// 2026 and 2025 reproduce the withheld tax of real payslips to the cent; 2027 from BGBl. II Nr. 260/2026.
const values: Record<WageTaxYear, YearValues> = {
  2025: { brackets: [13308, 21617, 35836, 69166, 103072, 1_000_000], trafficCredit: 487, freeLimit: 2570 },
  2026: { brackets: [13539, 21992, 36458, 70365, 104859, 1_000_000], trafficCredit: 496, freeLimit: 2615 },
  2027: { brackets: [13846, 22491, 37285, 71960, 107236, 1_000_000], trafficCredit: 508, freeLimit: 2675 },
};
const rates = [0, 0.2, 0.3, 0.4, 0.48, 0.5, 0.55];
export const WERBUNGSKOSTEN_PAUSCHALE = 132;
/** Tax-free amount of the year's special payments within the sixth (§ 67 Abs. 1). */
export const SPECIAL_ALLOWANCE = 620;
/** Above this cumulative base special payments are taxed by the tariff (§ 67 Abs. 1 Z 4). */
export const PREFERENTIAL_LIMIT = 83333;
/** Familienbonus Plus per child and year (§ 33 Abs. 3a): under 18 and from 18. */
export const FAMILY_BONUS = { child: 2000.16, adult: 700.08 };

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const median = (list: number[]) => {
  const sorted = [...list].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const wageTaxYear = (year: number): WageTaxYear => year <= 2025 ? 2025 : year >= 2027 ? 2027 : 2026;
export const wageTaxValues = (year: number) => values[wageTaxYear(year)];
export const specialFreeLimit = (year: number) => wageTaxValues(year).freeLimit;

/** Income tax of an annual taxable income by the progressive tariff. */
export function incomeTax(taxable: number, year: number): number {
  const { brackets } = wageTaxValues(year);
  let tax = 0;
  let lower = 0;
  for (const [index, rate] of rates.entries()) {
    const upper = brackets[index] ?? Infinity;
    tax += Math.max(0, Math.min(taxable, upper) - lower) * rate;
    if (taxable <= upper) break;
    lower = upper;
  }
  return tax;
}

/** Tariff tax of a month for its regular LSt base before the Werbungskostenpauschale, before tax credits. */
export function monthlyTariff(base: number, year: number): number {
  return incomeTax(Math.max(0, base * 12 - WERBUNGSKOSTEN_PAUSCHALE), year) / 12;
}

/** Withheld Lohnsteuer of a month: tariff minus the monthly tax credits, never below zero. */
export function monthlyWageTax(base: number, year: number, monthlyCredits = wageTaxValues(year).trafficCredit / 12): number {
  return money(Math.max(0, monthlyTariff(base, year) - monthlyCredits));
}

/** Tax on the cumulative preferential base of the year's special payments: 0 % up to 620 €, then 6 %, 27 %, 35,75 %. */
export function preferentialTax(base: number): number {
  return Math.min(Math.max(0, base - SPECIAL_ALLOWANCE), 25000 - SPECIAL_ALLOWANCE) * 0.06
    + Math.min(Math.max(0, base - 25000), 25000) * 0.27
    + Math.min(Math.max(0, base - 50000), PREFERENTIAL_LIMIT - 50000) * 0.3575;
}

/**
 * Employee SV on special payments (2026 values; later years until verified tables exist): reduced unemployment
 * insurance for small payments, up to the annual maximum contribution base of 13.860 €.
 */
export function specialPaymentSv(gross: number, precedingGross: number): number {
  const rate = gross <= 2225 ? 0.1412 : gross <= 2427 ? 0.1512 : gross <= 2630 ? 0.1612 : 0.1707;
  return money(Math.min(gross, Math.max(0, 13860 - precedingGross)) * rate);
}

export type WageTaxCredits = {
  /** Deducted from the tariff tax every month (a twelfth of the annual amount, unrounded like the payroll does). */
  monthly: number;
  annual: number;
  /** "payslip": as the own payroll applied them; "law": the statutory Verkehrsabsetzbetrag only. */
  source: "payslip" | "law";
  label: string;
};

/**
 * Tax credits for a year as the own payroll applies them: tariff of the LSt base minus the withheld regular tax of the
 * latest payslips. The Verkehrsabsetzbetrag follows the year; further credits (Familienbonus Plus, Pendlereuro) are
 * kept as observed. Without a usable payslip only the statutory Verkehrsabsetzbetrag.
 */
export function wageTaxCredits(payslips: readonly Payslip[], year: number): WageTaxCredits {
  const traffic = wageTaxValues(year).trafficCredit;
  const observed = payslips
    .filter((entry) => entry.monthlyTaxableBase !== undefined && (entry.regularTax ?? 0) > 0)
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .slice(-3)
    .map((entry) => (monthlyTariff(entry.monthlyTaxableBase!, entry.year) - entry.regularTax!) * 12 - wageTaxValues(entry.year).trafficCredit);
  if (!observed.length) return { monthly: traffic / 12, annual: traffic, source: "law", label: "Verkehrsabsetzbetrag" };
  // Cents of rounding per month add up to a few euros a year.
  const extra = Math.abs(median(observed)) < 6 ? 0 : money(median(observed));
  const annual = money(Math.max(0, traffic + extra));
  const children = extra > 0 && [...Array(7).keys()].some((child) => [...Array(7).keys()].some((adult) =>
    child + adult > 0 && Math.abs(extra - child * FAMILY_BONUS.child - adult * FAMILY_BONUS.adult) < 6));
  return {
    monthly: annual / 12,
    annual,
    source: "payslip",
    label: extra === 0 ? "Verkehrsabsetzbetrag" : children ? "Verkehrsabsetzbetrag + Familienbonus Plus" : "Absetzbeträge lt. Abrechnung",
  };
}

/** What the year's earlier special payments already used: Jahressechstel, preferential base and SV base (gross). */
export type SpecialPaymentState = { used: number; taxable: number; svGross: number };

export type SpecialPaymentTax = {
  gross: number;
  sv: number;
  /** Jahressechstel of the payment month and the part earlier special payments of the year already used. */
  sixth: number;
  usedBefore: number;
  /** Gross within the Jahressechstel, taxed preferentially. */
  eligibleGross: number;
  /** Gross above the sixth (Sechstelüberhang), taxed with the month's regular pay. */
  overflowGross: number;
  /**
   * The part within the sixth after its SV share: tax-free (what is left of the yearly 620 €, or all of it while the
   * sixth stays under the Freigrenze), at 6 %, and in the 27/35,75 % bands.
   */
  freeNet: number;
  reducedNet: number;
  higherNet: number;
  /** After SV, added to the month's regular base and taxed by the tariff: the overhang (and anything above 83.333 €). */
  overflowNet: number;
  preferential: number;
  tariff: number;
  tax: number;
  net: number;
};

/**
 * Lohnsteuer and net of a special payment: SV first, within the sixth 620 € once a year tax-free and then 6 % (unless
 * the sixth stays under the Freigrenze), the rest added to the month's regular base and taxed by the tariff.
 */
export function specialPaymentTax(
  payment: { gross: number; sv?: number; sixth: number; base: number },
  before: SpecialPaymentState,
  year: number,
  monthlyCredits?: number,
): { tax: SpecialPaymentTax; after: SpecialPaymentState } {
  const { gross, sixth, base } = payment;
  const sv = Math.min(gross, payment.sv ?? specialPaymentSv(gross, before.svGross));
  const eligibleGross = money(Math.min(gross, Math.max(0, sixth - before.used)));
  const eligibleSv = gross > 0 ? money(sv * eligibleGross / gross) : 0;
  const eligibleNet = money(eligibleGross - eligibleSv);
  const preferentialNet = money(Math.max(0, Math.min(eligibleNet, PREFERENTIAL_LIMIT - before.taxable)));
  const overflowNet = money(gross - sv - preferentialNet);
  const exempt = sixth <= specialFreeLimit(year);
  const preferential = exempt ? 0 : money(preferentialTax(before.taxable + preferentialNet) - preferentialTax(before.taxable));
  const tariff = overflowNet > 0 ? money(monthlyWageTax(base + overflowNet, year, monthlyCredits) - monthlyWageTax(base, year, monthlyCredits)) : 0;
  const tax = money(preferential + tariff);
  const band = (lower: number, upper: number) =>
    money(Math.max(0, Math.min(before.taxable + preferentialNet, upper) - Math.max(before.taxable, lower)));
  const freeNet = exempt ? preferentialNet : band(0, SPECIAL_ALLOWANCE);
  const reducedNet = exempt ? 0 : band(SPECIAL_ALLOWANCE, 25000);
  return {
    tax: {
      gross, sv, sixth, usedBefore: before.used, eligibleGross, overflowGross: money(gross - eligibleGross),
      freeNet, reducedNet, higherNet: money(preferentialNet - freeNet - reducedNet), overflowNet,
      preferential, tariff, tax, net: money(gross - sv - tax),
    },
    after: {
      used: money(before.used + eligibleGross),
      taxable: money(before.taxable + preferentialNet),
      svGross: money(before.svGross + gross),
    },
  };
}

/** Short German description of the tax logic, e.g. for a caption. Never call it a tax class. */
export const wageTaxCaption = (year: number) => `Lohnsteuertarif AT ${wageTaxYear(year)} · progressiv + Absetzbeträge`;
