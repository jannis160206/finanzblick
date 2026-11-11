import { describe, expect, it } from "vitest";
import { documentedSpecialPayments, plannedSpecialPayments } from "@/lib/payroll-sixth";
import type { Payslip } from "@/lib/payslip-schema";
import { monthlyWageTax, specialPaymentTax } from "@/lib/wage-tax-at";

const slip = (month: number, override: Partial<Payslip> = {}): Payslip => ({
  year: 2026, month, employer: "Synthetischer Testbetrieb", monthlyPayroll: true,
  regularGross: 3000, specialGross: 0, regularSv: 540, monthlyTaxableBase: 2460, ...override,
});
const year = (overrides: Record<number, Partial<Payslip>>, last = 6) =>
  Array.from({ length: last }, (_, index) => slip(index + 1, overrides[index + 1]));

describe("documented special payments", () => {
  it("re-calculates each payment in its own sixth and keeps the printed tax for comparison", () => {
    const { payments, state } = documentedSpecialPayments(year({ 6: { specialGross: 3000, specialSv: 512.1, specialTax: 112.07 } }), 2026);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      month: 6, kind: "holiday", source: "payslip", printedTax: 112.07,
      tax: { sixth: 6000, usedBefore: 0, eligibleGross: 3000, overflowGross: 0, freeNet: 620, reducedNet: 1867.9, preferential: 112.07 },
    });
    expect(payments[0].estimatedSixth).toBeUndefined();
    expect(state).toEqual({ used: 3000, taxable: 2487.9, svGross: 3000 });
  });

  it("shows a tariff-taxed bonus as fully taxed without using the sixth", () => {
    // The payroll added the bonus after SV (858,80 €) to February's regular base.
    const entries = year({ 2: { unresolvedSixthBonus: 1000, specialSv: 141.2, monthlyTaxableBase: 3318.8 }, 6: { specialGross: 3000, specialSv: 512.1 } });
    const { payments, state } = documentedSpecialPayments(entries, 2026);
    expect(payments.map((payment) => payment.kind)).toEqual(["bonus", "holiday"]);
    expect(payments[0]).toMatchObject({
      tariffTaxed: true,
      tax: { gross: 1000, sv: 141.2, eligibleGross: 0, overflowGross: 1000, overflowNet: 858.8, preferential: 0 },
    });
    expect(payments[0].tax.tariff).toBe(Math.round((monthlyWageTax(3318.8, 2026) - monthlyWageTax(2460, 2026)) * 100) / 100);
    // June still has the whole sixth and the 620 € allowance.
    expect(payments[1].tax).toMatchObject({ usedBefore: 0, eligibleGross: 3000, freeNet: 620 });
    expect(state.svGross).toBe(4000);
  });

  it("taxes a documented overhang on top of the regular base the payslip prints without it", () => {
    // 7.000 € against a 6.000 € sixth: the payroll put the overhang after SV into June's printed base.
    const sv = 1194.9;
    const overflowNet = Math.round((1000 - sv / 7) * 100) / 100;
    const entries = year({ 6: { specialGross: 7000, specialSv: sv, monthlyTaxableBase: Math.round((2460 + overflowNet) * 100) / 100 } });
    const [june] = documentedSpecialPayments(entries, 2026).payments;
    const expected = specialPaymentTax({ gross: 7000, sv, sixth: 6000, base: 2460 }, { used: 0, taxable: 0, svGross: 0 }, 2026).tax;
    expect(june.tax).toEqual(expected);
    expect(june.tax).toMatchObject({ eligibleGross: 6000, overflowGross: 1000, overflowNet });
  });

  it("estimates the sixth across gaps and prefers printed cumulative values", () => {
    const entries = [slip(3), slip(4), slip(5), slip(6, { specialGross: 3000, specialSv: 512.1, usedSixth: 2500, specialTaxableYtd: 2000 })];
    const { payments, state } = documentedSpecialPayments(entries, 2026);
    expect(payments[0]).toMatchObject({ estimatedSixth: true, tax: { sixth: 6000 } });
    expect(state).toMatchObject({ used: 2500, taxable: 2000 });
  });

  it("names planned payments by month, the December one being the Successbonus", () => {
    const tax = specialPaymentTax({ gross: 1000, sixth: 6000, base: 2460 }, { used: 0, taxable: 0, svGross: 0 }, 2026).tax;
    expect(plannedSpecialPayments([{ month: 10 }, { month: 11, special: tax }, { month: 12, special: tax }], true)
      .map((payment) => [payment.month, payment.kind, payment.source, payment.estimatedSixth])).toEqual([
      [11, "christmas", "forecast", true], [12, "successBonus", "forecast", true],
    ]);
  });
});
