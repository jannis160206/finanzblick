import { describe, expect, it } from "vitest";
import {
  comparePayroll,
  employerPayslips,
  payrollBreakdown,
  payrollYearMonths,
  payrollYearTotals,
  previousPayslip,
  previousYearPayslip,
} from "@/lib/payroll-overview";
import type { Payslip, PayrollForecastMonth } from "@/lib/payslip-schema";

const base: Payslip = {
  year: 2026,
  month: 3,
  employer: "Musterbetrieb GmbH",
  regularGross: 4000,
  specialGross: 0,
  regularSv: 720,
  regularTax: 500,
  netPay: 2700,
  monthlyPayroll: true,
};

describe("payrollBreakdown", () => {
  it("splits gross into net, tax, social insurance and other deductions with shares", () => {
    const result = payrollBreakdown(base);
    expect(result).toMatchObject({
      gross: 4000, net: 2700, tax: 500, sv: 720, other: 80,
      taxComplete: true, svComplete: true,
      regular: { gross: 4000, tax: 500, sv: 720 },
    });
    expect(result.special).toBeUndefined();
    expect(result.shares.net).toBeCloseTo(0.675);
    expect(result.shares.tax).toBeCloseTo(0.125);
    expect(result.shares.sv).toBeCloseTo(0.18);
    expect(result.shares.other).toBeCloseTo(0.02);
  });

  it("adds special-payment tax and social insurance and keeps both parts separately", () => {
    const result = payrollBreakdown({
      ...base, month: 6, specialGross: 3000, specialSv: 512.1, specialTax: 148.74, netPay: 5039.16,
    });
    expect(result.gross).toBe(7000);
    expect(result.tax).toBe(648.74);
    expect(result.sv).toBe(1232.1);
    expect(result.other).toBe(80);
    expect(result.special).toEqual({ gross: 3000, tax: 148.74, sv: 512.1 });
    expect(result.regular).toEqual({ gross: 4000, tax: 500, sv: 720 });
  });

  it("never turns missing payslip values into zero or computes other deductions from them", () => {
    const result = payrollBreakdown({ ...base, netPay: undefined, regularTax: undefined });
    expect(result.net).toBeUndefined();
    expect(result.tax).toBeUndefined();
    expect(result.other).toBeUndefined();
    expect(result.sv).toBe(720);
    expect(result.shares).toEqual({ sv: 0.18 });
    expect(result.taxComplete).toBe(false);
  });

  it("does not compute other deductions when the special payment's tax is not printed", () => {
    const result = payrollBreakdown({ ...base, specialGross: 3000, specialSv: 512.1, netPay: 5100 });
    expect(result.tax).toBe(500);
    expect(result.taxComplete).toBe(false);
    expect(result.svComplete).toBe(true);
    expect(result.other).toBeUndefined();
    expect(result.special).toEqual({ gross: 3000, tax: undefined, sv: 512.1 });
  });

  it("omits negative other deductions instead of showing an impossible segment", () => {
    expect(payrollBreakdown({ ...base, netPay: 2900 }).other).toBeUndefined();
  });

  it("keeps an unresolved bonus in gross and shows it as part of the special payment", () => {
    const result = payrollBreakdown({
      ...base, unresolvedSixthBonus: 1000, specialSv: 141.2, netPay: 3200,
    });
    expect(result.gross).toBe(5000);
    expect(result.unresolvedBonus).toBe(1000);
    expect(result.special).toEqual({ gross: 1000, tax: undefined, sv: 141.2 });
    expect(result.taxComplete).toBe(true);
    expect(result.other).toBe(438.8);
  });
});

describe("month lookups and comparisons", () => {
  const payslips: Payslip[] = [
    { ...base, month: 1, netPay: 2650 },
    { ...base, month: 2, employer: "Anderer Betrieb", netPay: 1000 },
    { ...base, month: 3 },
    { ...base, month: 5, netPay: undefined, regularGross: 4100 },
    { ...base, year: 2027, month: 3, employer: " musterbetrieb  gmbh ", netPay: 2800 },
    { ...base, year: 2026, month: 12, netPay: 2600 },
  ];

  it("finds the previous available month of the same employer across gaps and years", () => {
    expect(previousPayslip(payslips, payslips[2])?.month).toBe(1);
    expect(previousPayslip(payslips, payslips[3])?.month).toBe(3);
    expect(previousPayslip(payslips, payslips[4])).toMatchObject({ year: 2026, month: 12 });
    expect(previousPayslip(payslips, payslips[0])).toBeUndefined();
  });

  it("finds the same month of the previous year only when it exists", () => {
    expect(previousYearPayslip(payslips, payslips[4])).toBe(payslips[2]);
    expect(previousYearPayslip(payslips, payslips[2])).toBeUndefined();
  });

  it("compares net when both months print it, otherwise gross", () => {
    expect(comparePayroll(payrollBreakdown(payslips[2]), payrollBreakdown(payslips[0]))).toEqual({
      year: 2026, month: 1, metric: "net", delta: 50, adjacent: false,
    });
    expect(comparePayroll(payrollBreakdown(payslips[3]), payrollBreakdown(payslips[2]))).toEqual({
      year: 2026, month: 3, metric: "gross", delta: 100, adjacent: false,
    });
    expect(comparePayroll(payrollBreakdown(payslips[4]), payrollBreakdown(payslips[5]))).toMatchObject({
      metric: "net", delta: 200, adjacent: false,
    });
    expect(comparePayroll(payrollBreakdown({ ...base, month: 4 }), payrollBreakdown(payslips[2]))).toMatchObject({
      metric: "net", delta: 0, adjacent: true,
    });
    expect(comparePayroll(payrollBreakdown(payslips[2]), undefined)).toBeUndefined();
  });

  it("selects one year and employer in month order", () => {
    expect(employerPayslips(payslips, 2026, "MUSTERBETRIEB GMBH").map((entry) => entry.month)).toEqual([1, 3, 5, 12]);
  });
});

describe("payrollYearTotals", () => {
  it("sums only present values and counts their months", () => {
    const totals = payrollYearTotals([
      base,
      { ...base, month: 4, netPay: undefined, regularTax: undefined },
      { ...base, month: 6, specialGross: 3000, specialSv: 512.1, specialTax: 148.74, netPay: 5039.16 },
    ]);
    expect(totals.months).toBe(3);
    expect(totals.gross).toEqual({ value: 15000, months: 3 });
    expect(totals.net).toEqual({ value: 7739.16, months: 2 });
    expect(totals.tax).toEqual({ value: 1148.74, months: 2 });
    expect(totals.sv).toEqual({ value: 2672.1, months: 3 });
    expect(totals.deductionRate?.months).toBe(2);
    expect(totals.deductionRate?.value).toBeCloseTo((11000 - 7739.16) / 11000);
  });

  it("leaves totals unknown instead of zero when no payslip prints them", () => {
    const totals = payrollYearTotals([{ ...base, netPay: undefined, regularTax: undefined, regularSv: undefined }]);
    expect(totals.net).toBeUndefined();
    expect(totals.tax).toBeUndefined();
    expect(totals.sv).toBeUndefined();
    expect(totals.deductionRate).toBeUndefined();
    expect(payrollYearTotals([]).gross).toEqual({ value: 0, months: 0 });
  });
});

describe("payrollYearMonths", () => {
  const forecast: PayrollForecastMonth[] = [6, 7, 8, 9, 10, 11, 12].map((month) => ({
    month, regularGross: 4000, specialGross: month === 11 ? 3000 : 0,
  }));

  it("marks documented, missing, forecast and special-payment months", () => {
    const months = payrollYearMonths(
      [{ ...base, month: 1 }, { ...base, month: 3 }, { ...base, month: 5, specialGross: 1000 }],
      forecast,
    );
    expect(months).toHaveLength(12);
    expect(months.map((entry) => entry.kind)).toEqual([
      "actual", "missing", "actual", "missing", "actual",
      "forecast", "forecast", "forecast", "forecast", "forecast", "forecast", "forecast",
    ]);
    expect(months[4]).toMatchObject({ kind: "actual", special: true });
    expect(months[10]).toEqual({
      month: 11, kind: "forecast", gross: 7000, regularGross: 4000, specialGross: 3000, special: true,
    });
    expect(months[5]).toMatchObject({ special: false, gross: 4000 });
  });

  it("keeps months open without a forecast or without any payslip", () => {
    expect(payrollYearMonths([{ ...base, month: 2 }], []).slice(2).every((entry) => entry.kind === "open")).toBe(true);
    expect(payrollYearMonths([], forecast).every((entry) => entry.kind === "open")).toBe(true);
  });
});
