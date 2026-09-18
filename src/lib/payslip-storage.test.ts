import { describe, expect, it } from "vitest";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { preparePayslipMerge } from "@/lib/payslip-storage";
import { payslipSchema, type Payslip, type PayrollForecast } from "@/lib/payslip-schema";
import { createSeed } from "@/lib/seed";
import { appStateSchema } from "@/lib/types";

const january: Payslip = {
  year: 2026, month: 1, employer: "Musterbetrieb GmbH",
  regularGross: 3000, specialGross: 0, regularSv: 540, regularTax: 200,
  monthlyTaxableBase: 2460, baseSalary: 2800, monthlyPayroll: true,
};
const forecast: PayrollForecast = {
  year: 2026, employer: january.employer, standardPayrollConfirmed: false,
  months: [{ month: 6, regularGross: 3200, specialGross: 2800, specialSv: 470, monthlyTaxableBase: 2600 }],
};

describe("local payroll records", () => {
  it("does not change or require payroll fields on older finance data", () => {
    const old = appStateSchema.parse(createSeed());
    expect(old.payslips).toBeUndefined();
    expect(old.payrollForecasts).toBeUndefined();
  });

  it("deduplicates repeated imports without adding monthly amounts", () => {
    const before = structuredClone(january);
    const merged = preparePayslipMerge([january], [{ ...january }, { ...january }]);
    expect(merged.entries).toEqual([january]);
    expect(merged.duplicates).toBe(2);
    expect(merged.conflicts).toEqual([]);
    expect(merged.changed).toEqual([]);
    expect(january).toEqual(before);
  });

  it("flags replacement and prevents conflicting versions in the same batch", () => {
    const correction = { ...january, regularGross: 3100 };
    expect(preparePayslipMerge([january], [correction])).toMatchObject({
      entries: [correction], conflicts: [expect.any(String)],
      changed: [correction],
    });
    expect(() => preparePayslipMerge([], [january, correction])).toThrow("unterschiedliche Abrechnungen");
  });

  it("keeps different employers, months and years separate and rejects normalized duplicates in saved state", () => {
    const rows: Payslip[] = [january, { ...january, month: 2 }, { ...january, year: 2027 }, { ...january, employer: "Zweiter Betrieb" }];
    expect(preparePayslipMerge([], rows).entries).toHaveLength(4);
    expect(appStateSchema.safeParse({ ...createSeed(), payslips: rows }).success).toBe(true);
    expect(appStateSchema.safeParse({
      ...createSeed(), payslips: [january, { ...january, employer: "  MUSTERBETRIEB   GmbH  " }],
    }).success).toBe(false);
    expect(appStateSchema.safeParse({ ...createSeed(), payrollForecasts: [forecast, { ...forecast }] }).success).toBe(false);
  });

  it("persists only whitelisted calculation fields, never passwords or original documents", () => {
    const parsed = payslipSchema.parse({
      ...january, password: "test-only-passphrase", pdf: [1, 2, 3], text: "private test payroll",
      iban: "private account", personnelNumber: "private identifier", sourceFile: "personal filename",
    });
    expect(parsed).toEqual(january);
    expect(JSON.stringify(parsed)).not.toContain("private");
    expect(JSON.stringify(parsed)).not.toContain("test-only-passphrase");
  });

  it("round-trips payroll and forecasts through JSON and Excel without replacing earlier manual sixth values", async () => {
    const state = appStateSchema.parse({
      ...createSeed(), payslips: [january, { ...january, month: 2, unresolvedSixthBonus: 1000, specialSv: 141.2 }], payrollForecasts: [forecast],
      annualSixth: [{
        year: 2026, month: 1, employer: "Manuell", regularGross: 1000, specialGross: 0,
        plannedSpecialGross: 0, monthlyPayroll: true,
      }],
    });

    for (const restored of [
      appStateSchema.parse(JSON.parse(JSON.stringify(state))),
      (await parseWorkbook(await exportWorkbook(state))).state,
    ]) {
      expect(restored.payslips).toEqual(state.payslips);
      expect(restored.payrollForecasts).toEqual(state.payrollForecasts);
      expect(restored.annualSixth).toEqual(state.annualSixth);
    }
  });

  it.each([-1, 0.001, 1_000_000_000.01])("rejects invalid separate bonus amounts: %s", (unresolvedSixthBonus) => {
    expect(payslipSchema.safeParse({ ...january, unresolvedSixthBonus }).success).toBe(false);
  });
});
