import { describe, expect, it } from "vitest";
import { payslipFingerprint, payslipHold, validatePayslip, validatePayslips } from "@/lib/payslip-validation";
import type { Payslip } from "@/lib/payslip-schema";

// Synthetic payslip shaped like a real one: 10 € tax-free extras in the net, 5 € deducted after the net.
const slip = (override: Partial<Payslip> = {}): Payslip => ({
  year: 2026, month: 3, employer: "Musterbetrieb GmbH", monthlyPayroll: true,
  regularGross: 4000, specialGross: 0, baseSalary: 3500, onCallGross: 300,
  regularSv: 722.8, regularTax: 540, netPay: 2747.2, advancePay: 2400, payout: 342.2,
  ...override,
});
const ids = (result: ReturnType<typeof validatePayslip>, level?: string) =>
  result.checks.filter((check) => !level || check.level === level).map((check) => check.id);

describe("payslip validation", () => {
  it("accepts a payslip whose net, transfers, components and rates fit together", () => {
    const result = validatePayslip(slip());
    expect(result).toMatchObject({ period: "2026-03", consistent: true, checks: [] });
    expect(result.passed).toEqual(["net-range", "net-balance", "transfers", "components", "tax-rate", "sv-rate"]);
  });

  it("counts back-pay for earlier months in the net balance and notes it", () => {
    const backPay = slip({ backPayGross: 200, backPayDeductions: 70, netPay: 2877.2, payout: 472.2 });
    const result = validatePayslip(backPay);
    expect(result.consistent).toBe(true);
    expect(result.passed).toContain("net-balance");
    expect(result.checks).toEqual([{ id: "back-pay", level: "info", message: "Nachzahlung für Vormonate 200,00\u00a0€ brutto – getrennt vom Monatswert." }]);
    expect(ids(validatePayslip({ ...backPay, backPayGross: undefined, backPayDeductions: undefined }), "error")).toEqual(["net-balance"]);
    expect(ids(validatePayslip(slip({ estimated: true })), "info")).toEqual(["estimated"]);
  });

  it("holds back clear contradictions and only notes plausible differences", () => {
    expect(ids(validatePayslip(slip({ netPay: 3047.2, payout: 642.2 })), "error")).toEqual(["net-balance"]);
    expect(validatePayslip(slip({ netPay: 2707.2, payout: 302.2 }))).toMatchObject({
      consistent: true, checks: [{ id: "net-balance", level: "warning", message: expect.stringMatching(/^Sonstige Abzüge von 30,00/) }],
    });
    expect(validatePayslip(slip({ netPay: 2727.2, payout: 322.2 })).passed).toContain("net-balance");
    expect(ids(validatePayslip(slip({ payout: 500 })), "error")).toEqual(["transfers"]);
    expect(validatePayslip(slip({ payout: 100 })).checks[0].message).toMatch(/decken das Netto nicht/);
    expect(ids(validatePayslip(slip({ baseSalary: 3800 })), "error")).toEqual(["components"]);
    expect(ids(validatePayslip(slip({ regularTax: 2100, netPay: 1187.2, advancePay: undefined, payout: undefined })), "error")).toEqual(["tax-rate"]);
    expect(ids(validatePayslip(slip({ netPay: 4100, advancePay: undefined, payout: undefined })), "error")).toContain("net-range");
    expect(validatePayslip(slip({ regularSv: 1000, netPay: 2470, advancePay: undefined, payout: undefined }))).toMatchObject({ consistent: true, checks: [{ id: "sv-rate", level: "warning" }] });
  });

  it("checks the 6 % tax of a special payment within the Jahressechstel, with or without the 620 € allowance", () => {
    const june = (specialTax: number) => slip({ month: 6, specialGross: 3500, specialSv: 597.45, specialTax, netPay: undefined, advancePay: undefined, payout: undefined });
    expect(validatePayslip(june(136.95)).passed).toContain("special-sixth");
    expect(validatePayslip(june(174.15)).passed).toContain("special-sixth");
    expect(validatePayslip(june(400))).toMatchObject({ consistent: true, checks: [{ id: "special-sixth", level: "warning" }] });
    expect(validatePayslip(slip({ month: 6, specialGross: 1000, specialSv: 170, specialTax: 0, netPay: undefined })).passed).toContain("special-sixth");
  });

  it("uses the history: on-call far above the flat rate, special payments in unusual months, extra-hour spikes, cumulative values", () => {
    const history = [1, 2, 3].map((month) => slip({ month, regularGrossYtd: 4000 * month }));
    const april = slip({ month: 4, onCallGross: 900, regularGross: 7000, baseSalary: 3500, regularSv: 1264.9, regularTax: 1500, netPay: 4245.1, advancePay: 2400, payout: 1840.1 });
    const result = validatePayslip(april, history);
    expect(result.consistent).toBe(true);
    expect(ids(result)).toEqual(["on-call", "regular-spike"]);
    expect(result.checks.find((check) => check.id === "regular-spike")?.level).toBe("info");
    const march = validatePayslip(slip({ month: 4, specialGross: 3500, specialSv: 597.45, specialTax: 136.95, netPay: undefined }), history);
    expect(ids(march, "warning")).toEqual(["special-month"]);
    expect(ids(validatePayslip(slip({ month: 4, regularGrossYtd: 16100 }), history), "warning")).toEqual(["ytd"]);
    expect(validatePayslip(slip({ month: 4, regularGrossYtd: 16000 }), history).passed).toContain("ytd");
    expect(ids(validatePayslip(slip({ month: 4, baseSalary: 3300 }), history), "warning")).toEqual(["base-salary"]);
  });

  it("validates incoming payslips against each other and the stored ones, without their own earlier version", () => {
    const [replacement] = validatePayslips([slip({ month: 2 })], [slip({ month: 1 }), slip({ month: 2, baseSalary: 3600 })]);
    expect(ids(replacement)).toEqual([]);
    const [, february] = validatePayslips([slip({ month: 1 }), slip({ month: 2, baseSalary: 3300 })]);
    expect(ids(february)).toEqual(["base-salary"]);
  });
});

describe("payslip hold", () => {
  it("keeps contradicting payslips out of the budget until exactly these values are confirmed", () => {
    const broken = slip({ netPay: 3047.2, payout: 642.2 });
    expect(payslipHold(broken, [])?.checks[0].id).toBe("net-balance");
    expect(payslipHold(broken, [], [payslipFingerprint(broken)])).toBeUndefined();
    const changed = { ...broken, netPay: 3147.2 };
    expect(payslipFingerprint(changed)).not.toBe(payslipFingerprint(broken));
    expect(payslipHold(changed, [], [payslipFingerprint(broken)])).toBeDefined();
    expect(payslipHold(slip(), [])).toBeUndefined();
    expect(payslipHold({ ...broken, year: 2025 }, [])).toBeUndefined();
    expect(payslipFingerprint(slip())).toMatch(/^2026-03\|.*#[0-9a-f]{8}$/);
  });
});
