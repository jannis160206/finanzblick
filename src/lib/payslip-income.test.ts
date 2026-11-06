import { describe, expect, it } from "vitest";
import { parsePayslipPages } from "@/lib/import/payslip";
import { applyPayslipIncome, payslipIncome } from "@/lib/payslip-income";
import { payslipSchema, type Payslip } from "@/lib/payslip-schema";
import { preparePayslipMerge } from "@/lib/payslip-storage";
import type { AppState, FinanceRow } from "@/lib/types";
import { positionedLine, syntheticContextPage } from "../../tests/fixtures/payslip-context";

const base: Payslip = {
  year: 2026, month: 10, employer: "Musterbetrieb GmbH", regularGross: 4000, specialGross: 0,
  regularSv: 720, regularTax: 560, monthlyPayroll: true,
};
const rows: FinanceRow[] = [
  { id: "income-5", label: "Nettogehalt", kind: "income", values: { "2026-11": 2500, "2026-12": 2500 } },
  { id: "income-6", label: "Rufbereitschaft", kind: "income", values: { "2026-11": 210 } },
  { id: "income-8", label: "Sonstiges", kind: "income", values: { "2026-11": 50 } },
  { id: "rent", label: "Miete", kind: "fixed", values: { "2026-10": 900 } },
];
const state = (financeRows = rows) => ({ financeRows }) as AppState;
const value = (result: { state: AppState }, id: string, month = "2026-11") =>
  result.state.financeRows.find((row) => row.id === id)?.values[month];

describe("payslip net pay parsing", () => {
  it("reads the printed Netto line", () => {
    const entry = payslipSchema.parse(parsePayslipPages([syntheticContextPage("")]).drafts[0]);
    expect(entry.netPay).toBe(2260);
  });

  it("reads Akonto as salary and Auszahlung as the remainder", () => {
    const page = syntheticContextPage("");
    const lines = [...page.lines,
      positionedLine(265, [89, "Akonto"], [379, "-2.000,00"]),
      positionedLine(250, [89, "Auszahlung"], [379, "260,00"])];
    expect(parsePayslipPages([{ lines }]).drafts[0]).toMatchObject({ netPay: 2260, advancePay: 2000, payout: 260 });
    const withoutNet = lines.filter((line) => !line.items.some((item) => item.text === "Netto"));
    expect(parsePayslipPages([{ lines: withoutNet }]).drafts[0]).toMatchObject({ netPay: 2260, advancePay: 2000, payout: 260 });
    const onlyPayout = withoutNet.filter((line) => !line.items.some((item) => item.text === "Akonto"));
    expect(parsePayslipPages([{ lines: onlyPayout }]).drafts[0].netPay).toBe(260);
  });
});

describe("payslip income for the month plan", () => {
  it("writes the printed net and splits the on-call share by gross", () => {
    const result = applyPayslipIncome(state(), [{ ...base, netPay: 2800, onCallGross: 400 }]);
    expect(value(result, "income-6")).toBe(280);
    expect(value(result, "income-5")).toBe(2520);
    expect(value(result, "income-8")).toBe(50);
    expect(value(result, "income-5", "2026-12")).toBe(2500);
    expect(value(result, "income-5", "2026-10")).toBeUndefined();
    expect(result.applied[0]).toMatchObject({ payrollMonth: "2026-10", month: "2026-11", net: 2800, computed: false });
  });

  it("uses the transferred salary as Gehalt and the Auszahlung as Rufbereitschaft", () => {
    const entry = { ...base, netPay: 4465.31, onCallGross: 500.62, advancePay: 2658.31, payout: 1800 };
    const result = applyPayslipIncome(state(), [entry]);
    expect(value(result, "income-5")).toBe(2658.31);
    expect(value(result, "income-6")).toBe(1800);
    expect(result.applied[0].net).toBe(4458.31);
    expect(applyPayslipIncome(result.state, [entry]).changed).toBe(false);
  });

  it("puts the special-payment net into its own row", () => {
    const entry = { ...base, month: 6, netPay: 5600, specialGross: 3700, specialSv: 630, specialTax: 150 };
    const result = applyPayslipIncome(state(), [entry]);
    const special = result.state.financeRows.find((row) => row.label === "Sonderzahlungen");
    expect(special?.kind).toBe("income");
    expect(special?.values["2026-07"]).toBe(2920);
    expect(value(result, "income-5", "2026-07")).toBe(2680);
    expect(value(result, "income-6", "2026-07")).toBe(0);
    expect(result.state.financeRows.findIndex((row) => row.label === "Sonderzahlungen")).toBe(1);
  });

  it("derives the special share when its tax is not printed", () => {
    const entry = { ...base, month: 6, netPay: 5600, specialGross: 3700, specialSv: 630 };
    expect(payslipIncome(entry)).toMatchObject({ special: 2880, salary: 2720 });
  });

  it("reconstructs net from gross, SV and tax and skips unknown special tax", () => {
    expect(payslipIncome(base)).toMatchObject({ net: 2720, computed: true });
    expect(payslipIncome({ ...base, specialGross: 1000, specialSv: 170 })).toBeUndefined();
    const result = applyPayslipIncome(state(), [{ ...base, specialGross: 1000, specialSv: 170 }]);
    expect(result.skipped).toEqual(["2026-10"]);
    expect(result.changed).toBe(false);
  });

  it("is idempotent and creates a salary row if none exists", () => {
    const once = applyPayslipIncome(state([]), [base]);
    expect(once.state.financeRows).toEqual([
      { id: "income-salary", label: "Nettogehalt", kind: "income", values: { "2026-11": 2720 } },
    ]);
    expect(applyPayslipIncome(once.state, [base]).changed).toBe(false);
  });

  it("books the December payslip into January of the next year", () => {
    expect(payslipIncome({ ...base, month: 12 })).toMatchObject({ payrollMonth: "2026-12", month: "2027-01" });
  });

  it("keeps the existing on-call split for older payslips without on-call data", () => {
    const result = applyPayslipIncome(state(), [base]);
    expect(value(result, "income-6")).toBe(210);
    expect(value(result, "income-5")).toBe(2510);
    expect(applyPayslipIncome(result.state, [base]).changed).toBe(false);
    expect(value(applyPayslipIncome(state(), [{ ...base, netPay: 2720 }]), "income-6")).toBe(0);
  });
});

describe("payslip merge with net-pay fields", () => {
  it("treats added net fields on a stored payslip as enrichment, not as conflict", () => {
    const merged = preparePayslipMerge([base], [{ ...base, netPay: 2728.5 }]);
    expect(merged.conflicts).toEqual([]);
    expect(merged.changed).toHaveLength(1);
    expect(preparePayslipMerge([base], [{ ...base, regularGross: 4100, netPay: 2728.5 }]).conflicts).toHaveLength(1);
  });
});
