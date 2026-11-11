import type { Payslip } from "@/lib/payslip-schema";
import {
  monthlyWageTax,
  specialPaymentSv,
  specialPaymentTax,
  type SpecialPaymentState,
  type SpecialPaymentTax,
} from "@/lib/wage-tax-at";

/**
 * Every special payment of a tax year, split exactly into the part inside the Jahressechstel (after SV: rest of the
 * 620 € tax-free, then 6 %) and the part above it, which is taxed with the month's regular pay by the tariff.
 * Documented payments are re-calculated from their payslip; planned ones come from the payroll forecast.
 */
export type SixthPaymentKind = "holiday" | "christmas" | "successBonus" | "bonus" | "special";

export const sixthPaymentLabel: Record<SixthPaymentKind, string> = {
  holiday: "Urlaubszuschuss",
  christmas: "Weihnachtsremuneration",
  successBonus: "Successbonus",
  bonus: "Prämie",
  special: "Sonderzahlung",
};

export type SixthPayment = {
  /** Abrechnungsmonat. */
  month: number;
  kind: SixthPaymentKind;
  source: "payslip" | "forecast";
  /** A documented bonus the payroll taxed entirely by the tariff, outside the sixth. */
  tariffTaxed?: boolean;
  /** The sixth rests on estimated months, because the documented year has gaps. */
  estimatedSixth?: boolean;
  tax: SpecialPaymentTax;
  /** Lohnsteuer the payslip prints for its special payment. */
  printedTax?: number;
};

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const documentedKind = (month: number): SixthPaymentKind => month === 6 ? "holiday" : month === 11 ? "christmas" : "special";
const plannedKind = (month: number): SixthPaymentKind => month === 12 ? "successBonus" : documentedKind(month);

/**
 * Walks the documented payslips of one year and employer in order. The sixth is the regular gross since January
 * divided by the elapsed months times two (or the value the payslip prints); gaps count with the average regular
 * gross. Printed cumulative values (used sixth, preferential base) take precedence over the calculation.
 */
export function documentedSpecialPayments(
  entries: readonly Payslip[],
  year: number,
  monthlyCredits?: number,
): { payments: SixthPayment[]; state: SpecialPaymentState } {
  const sorted = [...entries].sort((left, right) => left.month - right.month);
  const average = sorted.length ? sorted.reduce((total, entry) => total + entry.regularGross, 0) / sorted.length : 0;
  const payments: SixthPayment[] = [];
  let state: SpecialPaymentState = { used: 0, taxable: 0, svGross: 0 };
  let regular = 0;
  let previous = 0;
  let estimated = false;
  for (const entry of sorted) {
    if (entry.regularGrossYtd !== undefined) {
      regular = entry.regularGrossYtd;
      estimated = false;
    } else {
      const gap = entry.month - previous - 1;
      if (gap > 0) {
        regular += gap * average;
        estimated = true;
      }
      regular += entry.regularGross;
    }
    previous = entry.month;
    const sixth = entry.reportedSixth ?? money(regular / entry.month * 2);
    const estimatedSixth = estimated && entry.reportedSixth === undefined;
    const bonus = entry.unresolvedSixthBonus ?? 0;
    const svShare = (part: number) =>
      entry.specialSv === undefined ? undefined : money(entry.specialSv * part / (entry.specialGross + bonus));
    // The payroll adds tariff-taxed amounts to the month's regular base, so the printed base already contains them.
    const printedBase = entry.monthlyTaxableBase ?? money(entry.regularGross - (entry.regularSv ?? entry.regularGross * 0.18));
    if (entry.specialGross > 0) {
      const payment = { gross: entry.specialGross, sv: svShare(entry.specialGross), sixth };
      let result = specialPaymentTax({ ...payment, base: printedBase }, state, year, monthlyCredits);
      if (result.tax.overflowNet > 0 && entry.monthlyTaxableBase !== undefined) {
        result = specialPaymentTax({ ...payment, base: money(printedBase - result.tax.overflowNet) }, state, year, monthlyCredits);
      }
      payments.push({
        month: entry.month, kind: documentedKind(entry.month), source: "payslip", tax: result.tax,
        ...(estimatedSixth ? { estimatedSixth } : {}),
        ...(entry.specialTax === undefined ? {} : { printedTax: entry.specialTax }),
      });
      state = result.after;
    }
    if (bonus > 0) {
      const sv = Math.min(bonus, svShare(bonus) ?? specialPaymentSv(bonus, state.svGross));
      const overflowNet = money(bonus - sv);
      const tariff = money(monthlyWageTax(printedBase, year, monthlyCredits) - monthlyWageTax(money(printedBase - overflowNet), year, monthlyCredits));
      payments.push({
        month: entry.month, kind: "bonus", source: "payslip", tariffTaxed: true,
        ...(estimatedSixth ? { estimatedSixth } : {}),
        tax: {
          gross: bonus, sv, sixth, usedBefore: state.used, eligibleGross: 0, overflowGross: bonus,
          freeNet: 0, reducedNet: 0, higherNet: 0, overflowNet,
          preferential: 0, tariff, tax: tariff, net: money(bonus - sv - tariff),
        },
      });
      state = { ...state, svGross: money(state.svGross + bonus) };
    }
    if (entry.usedSixth !== undefined) state = { ...state, used: entry.usedSixth };
    if (entry.specialTaxableYtd !== undefined) state = { ...state, taxable: entry.specialTaxableYtd };
  }
  return { payments, state };
}

/** Planned special payments of the forecast months, in the order the payroll would pay them. */
export function plannedSpecialPayments(
  estimates: readonly { month: number; special?: SpecialPaymentTax }[],
  estimatedSixth = false,
): SixthPayment[] {
  return estimates.flatMap((estimate) => estimate.special && estimate.special.gross > 0
    ? [{ month: estimate.month, kind: plannedKind(estimate.month), source: "forecast" as const, tax: estimate.special,
      ...(estimatedSixth ? { estimatedSixth } : {}) }]
    : []);
}
