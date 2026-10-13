import { describe, expect, it } from "vitest";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { assertPayslipReview, capturePayslipReview, preparePayslipMerge, removeReviewedPayslip } from "@/lib/payslip-storage";
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
      ...createSeed(), payslips: [january, { ...january, month: 2, unresolvedSixthBonus: 1000, specialSv: 141.2, payrollContextIssues: ["buag", "apprentice", "employment-ended", "context-unknown"] }], payrollForecasts: [forecast],
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

  it("captures reviewed records independently of subsequent mutation and object field order", () => {
    const record = { ...january };
    const review = capturePayslipReview([record], [january]);
    const { employer, ...fields } = january;
    assertPayslipReview([{ employer, ...fields }], review);
    record.regularGross = 3200;
    expect(() => assertPayslipReview([record], review)).toThrow("erneut prüfen");
    expect(review[0].expected?.regularGross).toBe(3000);
  });

  it.each<{ current: Payslip[] }>([
    { current: [] },
    { current: [{ ...january, regularGross: 3200 }] },
    { current: [{ ...january, payrollContextIssues: ["buag"] }] },
  ])("rejects removal of a record changed since preview: %j", ({ current }) => {
    const before = structuredClone(current);
    expect(() => removeReviewedPayslip(current, january)).toThrow("inzwischen geändert");
    expect(current).toEqual(before);
  });

  it("checks all reviewed periods atomically, including newly inserted incoming months", () => {
    const incoming = [{ ...january, regularGross: 3100 }, { ...january, month: 2 }];
    const review = capturePayslipReview([january], incoming);
    expect(() => assertPayslipReview([january, { ...january, month: 2, specialGross: 100 }], review)).toThrow("erneut hochladen");
    assertPayslipReview([january, { ...january, month: 3 }], review);
    expect(removeReviewedPayslip([january, { ...january, month: 3 }], january)).toEqual([{ ...january, month: 3 }]);
  });

  it("validates compact whitelisted context reasons", () => {
    expect(payslipSchema.safeParse({ ...january, payrollContextIssues: ["raw sensitive text"] }).success).toBe(false);
    expect(payslipSchema.safeParse({ ...january, payrollContextIssues: ["buag", "buag"] }).success).toBe(false);
  });
});
