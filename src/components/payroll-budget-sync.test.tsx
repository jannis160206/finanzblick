// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PayrollBudgetSync } from "./payroll-budget-sync";
import { useFinance } from "@/components/finance-provider";
import { syncPayrollBudget } from "@/lib/payroll-budget";
import { createSeed } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));

function payslipState(): AppState {
  const state = createSeed();
  state.settings = { ...state.settings, asOf: "2026-11-10", baselineDate: "2026-11-01" };
  state.payslips = [{
    year: 2026, month: 10, employer: "Musterbetrieb GmbH", monthlyPayroll: true,
    regularGross: 3000, specialGross: 0, regularSv: 542.1, regularTax: 357.9, netPay: 2100,
  }];
  return state;
}
const update = vi.fn();
const mount = (state: AppState, extra: { ready?: boolean; storageError?: string | null } = {}) => {
  vi.mocked(useFinance).mockReturnValue({ state, update, ready: true, storageError: null, ...extra } as unknown as ReturnType<typeof useFinance>);
  return render(<PayrollBudgetSync />);
};

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it("updates the budget on its own once the data settles, with a short toast and a log entry", () => {
  const state = payslipState();
  mount(state);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(update).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(600); });
  expect(update).toHaveBeenCalledTimes(1);
  const next: AppState = update.mock.calls[0][0](state);
  expect(next.financeRows.find((row) => row.id === "income-salary")?.values).toMatchObject({ "2026-12": 2100, "2027-12": 2100 });
  // Short toast without months or amounts; the range and every value are in the import log.
  expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Budget aktualisiert · \d+ Werte$/));
  const [entry] = JSON.parse(localStorage.getItem("finanzblick.payslip-log") ?? "[]");
  expect(entry).toMatchObject({ source: "budget", budget: { applied: expect.any(Number), changes: expect.arrayContaining([expect.objectContaining({ month: "2026-12", to: 2100 })]) } });
});

it("silently remembers the targets of a budget that is already current", () => {
  const current = { ...syncPayrollBudget(payslipState(), 1).state, payrollBudget: undefined };
  mount(current);
  act(() => { vi.advanceTimersByTime(2000); });
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0][0](current).payrollBudget?.targets).toBeDefined();
  expect(toast.success).not.toHaveBeenCalled();
  expect(localStorage.getItem("finanzblick.payslip-log")).toBeNull();
});

it("stays quiet when the budget is current, while loading and when storage is unavailable", () => {
  mount(syncPayrollBudget(payslipState(), 1).state);
  act(() => { vi.advanceTimersByTime(2000); });
  cleanup();
  mount(payslipState(), { ready: false });
  act(() => { vi.advanceTimersByTime(2000); });
  cleanup();
  mount(payslipState(), { storageError: "Speicher voll" });
  act(() => { vi.advanceTimersByTime(2000); });
  expect(update).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
});
