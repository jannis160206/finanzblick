// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { Months } from "./months";
import { createSeed } from "@/lib/seed";
import { currency, number } from "@/lib/format";
import type { AppState } from "@/lib/types";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T12:00:00"));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture(): AppState {
  const state = createSeed();
  return {
    ...state, settings: { ...state.settings, asOf: "2026-10-05" },
    savingsGoals: [], plannedOneOffs: [], plannedOneOffsSeeded: true,
    financeRows: [{ id: "income", label: "Gehalt", kind: "income", values: { "2026-10": 3000 } }],
    transactions: [{
      id: "card", bank: "Amex", pocket: "Amex", date: "2026-09-25",
      description: "Amazon Bestellung", amount: -500, category: "Shopping", includeInPlan: false, reviewed: true,
    }],
    accountSnapshots: [{ bank: "Revolut", name: "Amex", date: "2026-09-30", balance: 125 }],
  };
}
function mount(initialState = fixture()) {
  let latest: ReturnType<typeof useFinance>;
  function Harness() {
    const finance = useFinance();
    useEffect(() => { latest = finance; }, [finance]);
    return <Months />;
  }
  const view = render(<FinanceProvider initialState={initialState}><Harness /></FinanceProvider>);
  return { ...view, read: () => latest };
}

function monthCell(label: string, month: number) {
  return within(screen.getByRole("row", { name: new RegExp(`^${label} `) })).getAllByRole("cell")[month - 1];
}

it("shows the automatic gap inside variable costs and updates surplus after reserve transfers and reload", () => {
  const view = mount();
  const initial = view.read().state;
  const budgets = initial.financeRows.filter((row) => row.kind === "variable");
  const row = screen.getByRole("row", { name: /^Amex offen / });
  expect(within(row).getByText("Amex offen").getAttribute("title")).toContain(`Rücklage ${currency(125)}`);
  const rows = screen.getAllByRole("row");
  expect(rows.indexOf(row)).toBeGreaterThan(rows.indexOf(screen.getByRole("row", { name: "Variable Ausgaben" })));
  expect(rows.indexOf(row)).toBeLessThan(rows.indexOf(screen.getByRole("row", { name: /^Variabel gesamt / })));
  expect(within(row).queryByRole("button")).toBeNull();
  expect(within(row).queryByRole("textbox")).toBeNull();
  expect(monthCell("Amex offen", 10).textContent).toBe(number(375));
  expect(monthCell("Amex offen", 11).textContent).toBe(number(0));
  expect(monthCell("Variabel gesamt", 10).textContent).toBe(number(view.read().dashboard.current.variablePlan));
  const before = view.read().dashboard.current.surplus;
  expect(monthCell("Überschuss", 10).textContent).toBe(number(before));
  act(() => view.read().update((state) => ({
    ...state, transactions: [...state.transactions, {
      id: "reserve", bank: "Revolut", pocket: "AMEX", date: "2026-10-01",
      description: "Um EUR Amex einzustecken", amount: 200, category: "Transfer intern", includeInPlan: false,
    }],
  })));
  expect(monthCell("Amex offen", 10).textContent).toBe(number(175));
  expect(monthCell("Überschuss", 10).textContent).toBe(number(before + 200));
  expect(view.read().state.financeRows.filter((item) => item.kind === "variable")).toEqual(budgets);
  expect(view.read().state.transactions[0]).toEqual(initial.transactions[0]);
  expect(view.read().saved).toBe(true);
  view.unmount();
  const restored = mount();
  expect(monthCell("Amex offen", 10).textContent).toBe(number(175));
  act(() => restored.read().update((state) => ({ ...state, transactions: state.transactions.filter((item) => item.id !== "card") })));
  expect(monthCell("Amex offen", 10).textContent).toBe(number(0));
});
