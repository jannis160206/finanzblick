import { describe, expect, it } from "vitest";
import { normalOnCall, payrollPattern, payrollPatterns, payrollProfile, variablePay } from "@/lib/payroll-pattern";
import type { Payslip } from "@/lib/payslip-schema";

const slip = (month: number, onCallGross: number, override: Partial<Payslip> = {}): Payslip => ({
  year: 2026, month, employer: "Musterbetrieb GmbH", regularGross: 3300, specialGross: 0, monthlyPayroll: true,
  baseSalary: 3000, onCallGross, ...override,
});

describe("payroll pattern", () => {
  it("learns the normal on-call flat rate from an amount that recurs at least three times", () => {
    const entries = [slip(1, 300), slip(2, 300.2), slip(3, 410), slip(4, 0), slip(5, 299.9), slip(6, 410)];
    expect(payrollPattern(entries)).toEqual({ normalOnCallGross: 300, onCallByYear: { 2026: 300 } });
    // Two different amounts are no flat rate yet.
    expect(payrollPattern([slip(1, 410), slip(2, 300)])).toEqual({});
    expect(payrollPattern([slip(1, 0)])).toEqual({});
  });

  it("learns a flat rate per year, carries it into later years and leaves years paid per duty week unsplit", () => {
    const perWeek = [23, 385, 431, 537, 584, 537, 720].map((amount, index) => slip(index + 6, amount, { year: 2025 }));
    const flat = Array.from({ length: 10 }, (_, index) => slip(index + 1, index === 9 ? 500 : 362.18));
    const pattern = payrollPattern([...perWeek, ...flat]);
    expect(pattern).toEqual({ normalOnCallGross: 362.18, onCallByYear: { 2026: 362.18 } });
    expect(normalOnCall(pattern, 2025)).toBeUndefined();
    expect(normalOnCall(pattern, 2027)).toBe(362.18);
    expect(variablePay(perWeek[6], pattern)).toMatchObject({ onCall: 720, holiday: 0, rated: false });
    expect(variablePay(flat[9], pattern)).toMatchObject({ onCall: 362.18, holiday: 137.82, rated: true });
    // A few cents above the flat rate are rounding, not holiday work.
    expect(variablePay(slip(1, 362.24), pattern)).toMatchObject({ onCall: 362.24, holiday: 0 });
    const other = slip(11, 500, { employer: "Anderer Arbeitgeber" });
    expect(payrollPattern([...flat, other, other, other], "MUSTERBETRIEB  GmbH").normalOnCallGross).toBe(362.18);
    expect(payrollPatterns([...flat, other]).size).toBe(2);
  });

  it("splits variable pay into normal on-call, holiday work and extra hours", () => {
    const october = slip(10, 400, { regularGross: 5500, holidayWorkGross: 100 });
    expect(variablePay(october, { normalOnCallGross: 300 })).toEqual({ onCall: 300, holiday: 200, overtime: 2000, rated: true });
    expect(variablePay(october)).toEqual({ onCall: 400, holiday: 100, overtime: 2000, rated: false });
    expect(variablePay({ ...october, baseSalary: undefined }, { normalOnCallGross: 300 }).overtime).toBe(0);
  });
});

describe("payroll profile", () => {
  it("learns flat rates, holiday and special-payment months, bonus months and the advance pattern from all years", () => {
    const entries = [
      ...[6, 7, 8, 9].map((month) => slip(month, 280, { year: 2025, ...(month === 6 ? { specialGross: 3000 } : {}) })),
      slip(2, 300, { unresolvedSixthBonus: 1200 }), slip(3, 300), slip(4, 330), slip(5, 330),
      slip(6, 300, { specialGross: 3000, advancePay: 2000, payout: 400 }), slip(10, 420, { advancePay: 2000, payout: 900 }),
    ];
    expect(payrollProfile(entries)).toEqual({
      payslips: 10, years: [2025, 2026], onCallByYear: { 2025: 280, 2026: 300 },
      holidayMonths: [4, 5, 10], specialMonths: [6], specialRatio: 1, bonusMonths: [2], advance: false,
    });
    expect(payrollProfile([]).payslips).toBe(0);
  });
});
