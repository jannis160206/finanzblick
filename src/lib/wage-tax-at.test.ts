import { describe, expect, it } from "vitest";
import type { Payslip } from "./payslip-schema";
import {
  FAMILY_BONUS,
  incomeTax,
  monthlyWageTax,
  specialPaymentTax,
  wageTaxCaption,
  wageTaxCredits,
} from "./wage-tax-at";

const slip = (month: number, regularTax: number, base = 3000): Payslip => ({
  year: 2026, month, employer: "Musterbetrieb GmbH", monthlyPayroll: true,
  regularGross: 3600, specialGross: 0, monthlyTaxableBase: base, regularTax,
});

describe("Austrian wage tax", () => {
  it("applies the progressive tariff to the annualised base and deducts the Verkehrsabsetzbetrag", () => {
    expect(incomeTax(13539, 2026)).toBe(0);
    expect(incomeTax(21992, 2026)).toBeCloseTo(1690.6, 2);
    // (3.000 € × 12 − 132 €): 20 % and 30 % brackets, then 496 € / 12 Verkehrsabsetzbetrag.
    expect(monthlyWageTax(3000, 2026)).toBe(446.45);
    expect(monthlyWageTax(3000, 2026, 0)).toBe(487.78);
    // 2027: indexed brackets and 508 € Verkehrsabsetzbetrag; the 40 % bracket starts at 37.285 €.
    expect(monthlyWageTax(3500, 2027)).toBe(624.37);
    expect(monthlyWageTax(900, 2026)).toBe(0);
    expect(wageTaxCaption(2026)).toBe("Lohnsteuertarif AT 2026 · progressiv + Absetzbeträge");
  });

  it("learns the tax credits from the payslips and recognises the Familienbonus Plus", () => {
    expect(wageTaxCredits([], 2026)).toMatchObject({ annual: 496, source: "law", label: "Verkehrsabsetzbetrag" });
    expect(wageTaxCredits([], 2026).monthly).toBeCloseTo(41.33, 2);
    const plain = [slip(8, 446.45), slip(9, 446.45), slip(10, 446.45)];
    expect(wageTaxCredits(plain, 2026)).toMatchObject({ annual: 496, source: "payslip", label: "Verkehrsabsetzbetrag" });
    // The Verkehrsabsetzbetrag follows the year, observed extras stay as they are.
    expect(wageTaxCredits(plain, 2027).annual).toBe(508);
    const child = plain.map((entry) => ({ ...entry, regularTax: 446.45 - FAMILY_BONUS.child / 12 }));
    expect(wageTaxCredits(child, 2026)).toMatchObject({ annual: 2496.16, label: "Verkehrsabsetzbetrag + Familienbonus Plus" });
    const commuter = plain.map((entry) => ({ ...entry, regularTax: 436.45 }));
    expect(wageTaxCredits(commuter, 2026).label).toBe("Absetzbeträge lt. Abrechnung");
  });

  it("taxes a special payment within the sixth with 620 € free once a year, then 6 %", () => {
    const { tax, after } = specialPaymentTax({ gross: 3000, sixth: 7000, base: 3000 }, { used: 0, taxable: 0, svGross: 0 }, 2026);
    expect(tax).toMatchObject({ gross: 3000, sv: 512.1, eligibleGross: 3000, overflowGross: 0, preferential: 112.07, tariff: 0, net: 2375.83 });
    // 2.487,90 € after SV: 620 € tax-free, 6 % on 1.867,90 €.
    expect(tax).toMatchObject({ sixth: 7000, usedBefore: 0, freeNet: 620, reducedNet: 1867.9, higherNet: 0, overflowNet: 0 });
    expect(after).toEqual({ used: 3000, taxable: 2487.9, svGross: 3000 });
    // The second payment of the year: the 620 € are used up.
    expect(specialPaymentTax({ gross: 3000, sixth: 7000, base: 3000 }, after, 2026).tax)
      .toMatchObject({ usedBefore: 3000, freeNet: 0, reducedNet: 2487.9, preferential: 149.27 });
  });

  it("taxes the part above the sixth with the month's regular pay by the tariff", () => {
    const { tax } = specialPaymentTax({ gross: 4000, sixth: 7000, base: 3000 }, { used: 6000, taxable: 4975.8, svGross: 6000 }, 2026);
    expect(tax.sv).toBe(682.8);
    expect(tax.eligibleGross).toBe(1000);
    expect(tax.overflowGross).toBe(3000);
    expect(tax).toMatchObject({ usedBefore: 6000, freeNet: 0, reducedNet: 829.3, overflowNet: 2487.9 });
    expect(tax.preferential).toBeCloseTo(49.76, 2);
    // 2.487,90 € net overhang on top of 3.000 € regular base: 40 % bracket.
    expect(tax.tariff).toBeCloseTo(990.24, 2);
    expect(tax.net).toBeCloseTo(2277.2, 2);
  });

  it("keeps special payments tax-free under the Freigrenze and caps their SV at the annual maximum", () => {
    const free = specialPaymentTax({ gross: 1200, sixth: 2600, base: 1300 }, { used: 0, taxable: 0, svGross: 0 }, 2026).tax;
    expect(free).toMatchObject({ tax: 0, freeNet: 1030.56, reducedNet: 0 });
    expect(specialPaymentTax({ gross: 3000, sixth: 9000, base: 3000 }, { used: 0, taxable: 0, svGross: 13000 }, 2026).tax.sv).toBe(146.8);
  });
});
