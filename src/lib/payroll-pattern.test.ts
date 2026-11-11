import { describe, expect, it } from "vitest";
import { payrollPattern, payrollPatterns, variablePay } from "@/lib/payroll-pattern";
import type { Payslip } from "@/lib/payslip-schema";

const slip = (month: number, onCallGross: number, override: Partial<Payslip> = {}): Payslip => ({
  year: 2026, month, employer: "Musterbetrieb GmbH", regularGross: 3300, specialGross: 0, monthlyPayroll: true,
  baseSalary: 3000, onCallGross, ...override,
});

describe("payroll pattern", () => {
  it("learns the normal on-call flat rate from the most frequent amount", () => {
    const entries = [slip(1, 300), slip(2, 300.2), slip(3, 410), slip(4, 0), slip(5, 299.9), slip(6, 410)];
    expect(payrollPattern(entries).normalOnCallGross).toBe(300);
    expect(payrollPattern([slip(1, 410), slip(2, 300)]).normalOnCallGross).toBe(300);
    expect(payrollPattern([slip(1, 0)])).toEqual({});
  });

  it("looks at the last twelve payslips of one employer", () => {
    const old = Array.from({ length: 6 }, (_, index) => slip(index + 1, 250, { year: 2025 }));
    const recent = Array.from({ length: 10 }, (_, index) => slip(index + 1, index < 3 ? 250 : 300));
    expect(payrollPattern([...old, ...recent]).normalOnCallGross).toBe(300);
    const other = slip(11, 500, { employer: "Anderer Arbeitgeber" });
    expect(payrollPattern([...recent, other, other], "MUSTERBETRIEB  GmbH").normalOnCallGross).toBe(300);
    expect(payrollPatterns([...recent, other]).size).toBe(2);
  });

  it("splits variable pay into normal on-call, holiday work and extra hours", () => {
    const october = slip(10, 400, { regularGross: 5500, holidayWorkGross: 100 });
    expect(variablePay(october, { normalOnCallGross: 300 })).toEqual({ onCall: 300, holiday: 200, overtime: 2000 });
    expect(variablePay(october)).toEqual({ onCall: 400, holiday: 100, overtime: 2000 });
    expect(variablePay({ ...october, baseSalary: undefined }, { normalOnCallGross: 300 }).overtime).toBe(0);
  });
});
