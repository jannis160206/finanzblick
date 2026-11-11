import { describe, expect, it } from "vitest";
import { autoBudgetCorrections, confirmPayslip, reviewPayrollBudget, syncPayrollBudget } from "@/lib/payroll-budget";
import { payslipFingerprint } from "@/lib/payslip-validation";
import { createSeed } from "@/lib/seed";
import type { Payslip } from "@/lib/payslip-schema";
import type { AppState } from "@/lib/types";

const october: Payslip = {
  year: 2026, month: 10, employer: "Musterbetrieb GmbH", monthlyPayroll: true,
  regularGross: 3000, specialGross: 0, baseSalary: 3000, regularSv: 542.1, regularTax: 357.9, netPay: 2100,
};
function payslipState(): AppState {
  const state = createSeed();
  state.settings = { ...state.settings, asOf: "2026-11-10", baselineDate: "2026-11-01" };
  state.payslips = [october];
  return state;
}
const salary = (state: AppState, month: string) => state.financeRows.find((row) => row.id === "income-salary")?.values[month];
const setSalary = (state: AppState, month: string, amount: number): AppState => ({
  ...state,
  financeRows: state.financeRows.map((row) => row.id === "income-salary" ? { ...row, values: { ...row.values, [month]: amount } } : row),
});

describe("automatic budget from payslips", () => {
  it("writes the forecast without confirmation and remembers the values it set", () => {
    const before = payslipState();
    expect(autoBudgetCorrections(before).apply.length).toBeGreaterThan(0);
    const { state, applied, review } = syncPayrollBudget(before, 1_000);
    expect(review).toEqual([]);
    expect(applied.map((item) => item.id)).toContain("income-salary|2026-12");
    expect([salary(state, "2026-12"), salary(state, "2027-12")]).toEqual([2100, 2100]);
    expect(state.payrollBudget).toMatchObject({ at: 1_000, targets: { "income-salary": { "2026-12": 2100, "2027-12": 2100 } } });
    expect(autoBudgetCorrections(state)).toEqual({ apply: [], review: [] });
    expect(syncPayrollBudget(state, 2_000).state).toBe(state);
  });

  it("never overwrites a value changed by hand but offers it for review, keeping or applying it", () => {
    const synced = syncPayrollBudget(payslipState(), 1_000).state;
    const edited = setSalary(synced, "2027-03", 1800);
    // A new payslip changes the forecast: everything else follows automatically, March stays.
    const raised = { ...edited, payslips: [{ ...october, regularGross: 3100, baseSalary: 3100, regularSv: 560.17, regularTax: 389.83, netPay: 2150 }] };
    const { state, review } = syncPayrollBudget(raised, 2_000);
    expect(salary(state, "2027-02")).toBe(2150);
    expect(salary(state, "2027-03")).toBe(1800);
    expect(review).toEqual([expect.objectContaining({ id: "income-salary|2027-03", from: 1800, to: 2150, reason: expect.stringMatching(/^von Hand geändert · /) })]);
    const kept = reviewPayrollBudget(state, [], review, 3_000);
    expect(autoBudgetCorrections(kept).review).toEqual([]);
    expect(salary(syncPayrollBudget(kept).state, "2027-03")).toBe(1800);
    const taken = reviewPayrollBudget(state, review, [], 3_000);
    expect(salary(taken, "2027-03")).toBe(2150);
    expect(autoBudgetCorrections(taken)).toEqual({ apply: [], review: [] });
  });

  it("first only remembers the targets of a budget that is already current, so a later hand-made change is kept", () => {
    const current = syncPayrollBudget(payslipState(), 1_000).state;
    const fresh = { ...current, payrollBudget: undefined };
    const recorded = syncPayrollBudget(fresh, 2_000);
    expect(recorded.applied).toEqual([]);
    expect(recorded.state.financeRows).toBe(fresh.financeRows);
    expect(recorded.state.payrollBudget).toEqual({ targets: current.payrollBudget?.targets });
    expect(syncPayrollBudget(recorded.state, 3_000).state).toBe(recorded.state);
    const edited = setSalary(recorded.state, "2027-05", 1700);
    expect(syncPayrollBudget(edited, 4_000)).toMatchObject({ applied: [], review: [{ id: "income-salary|2027-05" }] });
  });

  it("only offers a special payment that also stands in another income row, never removes it on its own", () => {
    const base = syncPayrollBudget(payslipState(), 1_000).state;
    const special = base.financeRows.find((row) => row.id === "income-special-payments")!.values["2026-12"]!;
    const withDuplicate = {
      ...base,
      financeRows: [...base.financeRows, { id: "income-other", label: "Sonstiges", kind: "income" as const, values: { "2026-12": special } }],
    };
    const { state, review } = syncPayrollBudget(withDuplicate, 2_000);
    expect(state).toBe(withDuplicate);
    expect(review).toEqual([expect.objectContaining({ id: "income-other|2026-12", kind: "duplicate", to: 0 })]);
  });

  it("takes a contradicting payslip into the budget only after confirming exactly its values", () => {
    const broken = { ...october, netPay: 2600 };
    const state = { ...payslipState(), payslips: [broken], payrollBudget: { confirmed: ["2020-01|alt#00000000"] } };
    const { state: confirmed, income } = confirmPayslip(state, broken);
    expect(income).toMatchObject({ held: [], applied: [{ net: 2600, month: "2026-11" }] });
    expect(confirmed.payrollBudget?.confirmed).toEqual([payslipFingerprint(broken)]);
    expect(salary(confirmed, "2026-11")).toBe(2600);
  });
});
