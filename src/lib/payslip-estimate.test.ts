import { describe, expect, it } from "vitest";
import { completeReferenceDrafts } from "./payslip-estimate";
import type { Payslip, PayslipDraft } from "./payslip-schema";

const employer = "Musterbetrieb GmbH";
const slip = (month: number, extra: Partial<Payslip> = {}): Payslip => ({
  year: 2025, month, employer, monthlyPayroll: true, baseSalary: 3000, regularGross: 3600, specialGross: 0,
  regularSv: 648, regularTax: 400, netPay: 2552, ...extra,
});
const stored = [slip(5), slip(6, { specialGross: 3000, specialSv: 512.1, specialTax: 142.07, netPay: 4897.83 }), slip(8)];

describe("reference payslips completed from the own pattern", () => {
  it("estimates the regular gross from the SV share and takes the Grundgehalt of the nearest month", () => {
    const partial: PayslipDraft = { year: 2025, month: 7, employer, regularSv: 666, regularTax: 420, monthlyTaxableBase: 2700 };
    const { drafts, notes } = completeReferenceDrafts([partial], stored);
    expect(drafts[0]).toEqual({ ...partial, regularGross: 3700, specialGross: 0, baseSalary: 3000, monthlyPayroll: true, estimated: true });
    expect(notes).toEqual(["Abrechnung 07/2025: als Referenz mit geschätzten Werten aus den eigenen Abrechnungen übernommen."]);
  });

  it("models the special payment of a learned special month and leaves budget years and unknown employers alone", () => {
    const june: PayslipDraft = { year: 2025, month: 6, employer, regularSv: 648, netPay: 4900 };
    expect(completeReferenceDrafts([june], stored.filter((entry) => entry.month !== 6).concat(slip(6, { year: 2025, specialGross: 3000 })))
      .drafts[0]).toMatchObject({ regularGross: 3600, specialGross: 3000, estimated: true });
    const budget: PayslipDraft = { year: 2026, month: 7, employer, regularSv: 666 };
    expect(completeReferenceDrafts([budget], stored)).toEqual({ drafts: [budget], notes: [] });
    const stranger: PayslipDraft = { year: 2025, month: 7, employer: "Wolkenrad Technik AG", regularSv: 666 };
    expect(completeReferenceDrafts([stranger], stored).drafts[0]).toBe(stranger);
    const complete = { ...slip(9) };
    expect(completeReferenceDrafts([complete], stored).drafts[0]).toBe(complete);
  });
});
