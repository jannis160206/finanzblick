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
  { id: "income-5", label: "Nettogehalt", kind: "income", values: { "2026-10": 2500, "2026-11": 2500 } },
  { id: "income-6", label: "Rufbereitschaft", kind: "income", values: { "2026-10": 210 } },
  { id: "income-8", label: "Sonstiges", kind: "income", values: { "2026-10": 50 } },
  { id: "rent", label: "Miete", kind: "fixed", values: { "2026-10": 900 } },
];
const state = (financeRows = rows) => ({ financeRows }) as AppState;
const value = (result: { state: AppState }, id: string, month = "2026-10") =>
  result.state.financeRows.find((row) => row.id === id)?.values[month];

describe("payslip net pay parsing", () => {
  it("reads the printed Netto line", () => {
    const entry = payslipSchema.parse(parsePayslipPages([syntheticContextPage("")]).drafts[0]);
    expect(entry.netPay).toBe(2260);
  });

  it("ignores Auszahlung after an advance and keeps the total net", () => {
    const page = syntheticContextPage("");
    const lines = [...page.lines,
      positionedLine(265, [89, "Akonto"], [379, "-2.000,00"]),
      positionedLine(250, [89, "Auszahlung"], [379, "260,00"])];
    expect(parsePayslipPages([{ lines }]).drafts[0].netPay).toBe(2260);
    const withoutNet = lines.filter((line) => !line.items.some((item) => item.text === "Netto"));
    expect(parsePayslipPages([{ lines: withoutNet }]).drafts[0].netPay).toBeUndefined();
  });
});

describe("payslip income for the month plan", () => {
  it("writes the printed net and splits the on-call share by gross", () => {
    const result = applyPayslipIncome(state(), [{ ...base, netPay: 2800, onCallGross: 400 }]);
    expect(value(result, "income-6")).toBe(280);
    expect(value(result, "income-5")).toBe(2520);
    expect(value(result, "income-8")).toBe(50);
    expect(value(result, "income-5", "2026-11")).toBe(2500);
    expect(result.applied[0]).toMatchObject({ net: 2800, computed: false });
  });

  it("puts the special-payment net into its own row", () => {
    const entry = { ...base, month: 6, netPay: 5600, specialGross: 3700, specialSv: 630, specialTax: 150 };
    const result = applyPayslipIncome(state(), [entry]);
    const special = result.state.financeRows.find((row) => row.label === "Sonderzahlungen");
    expect(special?.kind).toBe("income");
    expect(special?.values["2026-06"]).toBe(2920);
    expect(value(result, "income-5", "2026-06")).toBe(2680);
    expect(value(result, "income-6", "2026-06")).toBe(0);
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
      { id: "income-salary", label: "Nettogehalt", kind: "income", values: { "2026-10": 2720 } },
    ]);
    expect(applyPayslipIncome(once.state, [base]).changed).toBe(false);
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
