// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "@/components/finance-provider";
import { Transactions } from "@/components/transactions";
import * as calc from "@/lib/calc";
import * as review from "@/lib/import/review";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("sonner", () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}));

const STORAGE_KEY = "finanzdashboard.v1";
const calculateDashboard = calc.calculateDashboard;
type Finance = ReturnType<typeof useFinance>;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

function booking(id: string): Transaction {
  return {
    id, description: `Unbekannter Einkauf ${id}`, date: "2026-09-05", amount: -10,
    bank: "Revolut", pocket: null, category: "Prüfen", includeInPlan: false,
  };
}

function fixture(count = 2, unassigned = 2): AppState {
  const state = createSeed();
  return {
    ...state,
    settings: {
      ...state.settings,
      asOf: "2026-09-16",
      baselineDate: "2026-09-01",
      balances: { Sparkonto: 0, Urlaub: 0, Notgroschen: 0, Motorrad: 0 },
    },
    financeRows: [],
    transactions: Array.from({ length: count }, (_, i) => {
      const row = booking(i === 0 ? "first" : i === 1 ? "second" : `approved-${i}`);
      return i < unassigned
        ? row
        : { ...row, category: "Lebensmittel", categoryOverride: true, includeInPlan: true };
    }),
  };
}

function Observer({ onValue }: { onValue: (value: Finance) => void }) {
  const finance = useFinance();
  useEffect(() => onValue(finance), [finance, onValue]);
  return null;
}

function DashboardReader({ label }: { label: string }) {
  const { dashboard } = useFinance();
  return <output aria-label={label}>{dashboard.currentMonth}</output>;
}

function renderFinance(initialState: AppState, children?: ReactNode) {
  let latest: Finance;
  const capture = (value: Finance) => { latest = value; };
  const tree = (content: ReactNode) => (
    <FinanceProvider initialState={initialState}>
      <Observer onValue={capture} />
      {content}
    </FinanceProvider>
  );
  const view = render(tree(children));
  return {
    ...view,
    read: () => latest,
    rerenderChildren: (content: ReactNode) => view.rerender(tree(content)),
  };
}

describe("FinanceProvider lazy dashboard and assignment integration", () => {
  it("assigns real ledger reviews without any dashboard work, persists and prevents duplicate submissions", () => {
    const dashboard = vi.spyOn(calc, "calculateDashboard");
    const commit = vi.spyOn(review, "commitStatementImport");
    const initial = fixture(1_000);
    const view = renderFinance(initial, <Transactions />);
    expect(view.read().ready).toBe(true);
    expect(view.read().openReviewCount).toBe(2);
    expect(screen.getByLabelText<HTMLSelectElement>("Monat filtern").value).toBe("2026-09");
    expect(dashboard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Zuordnung prüfen" }));
    const section = screen.getByLabelText("Buchung prüfen: Unbekannter Einkauf first");
    fireEvent.change(within(section).getByLabelText("Kategorie"), { target: { value: "Freizeit" } });
    const submit = within(section).getByRole<HTMLButtonElement>("button", { name: "Zuordnung übernehmen" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(submit.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Zuordnung wird übernommen");
    expect(view.read().state.transactions[0].category).toBe("Prüfen");

    const concurrent = { ...booking("concurrent"), category: "Lebensmittel" as const, categoryOverride: true, includeInPlan: true };
    act(() => view.read().update((state) => ({
      ...state, transactions: [...state.transactions, concurrent],
    })));
    act(() => { vi.advanceTimersByTime(1); });
    const assigned = view.read();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(assigned.statementImport).toMatchObject({ added: 0, duplicates: 0 });
    expect(assigned.statementImport?.error).toBeUndefined();
    expect(assigned.state.transactions).toHaveLength(1_001);
    expect(assigned.state.transactions[0]).toEqual({
      ...initial.transactions[0], category: "Freizeit", categoryOverride: true, includeInPlan: true,
    });
    expect(assigned.state.transactions.at(-1)).toEqual(concurrent);
    expect(assigned.openReviewCount).toBe(1);
    expect(screen.queryByLabelText("Buchung prüfen: Unbekannter Einkauf first")).toBeNull();
    expect(screen.getByLabelText("Buchung prüfen: Unbekannter Einkauf second")).toBeTruthy();
    expect(dashboard).not.toHaveBeenCalled();

    const second = screen.getByLabelText("Buchung prüfen: Unbekannter Einkauf second");
    fireEvent.change(within(second).getByLabelText("Kategorie"), { target: { value: "Lebensmittel" } });
    fireEvent.click(within(second).getByRole("button", { name: "Zuordnung übernehmen" }));
    act(() => { vi.advanceTimersByTime(1); });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(view.read().openReviewCount).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("table").textContent).toContain("Freizeit");
    act(() => { vi.advanceTimersByTime(150); });
    expect(view.read().saved).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(view.read().state);
    expect(dashboard).not.toHaveBeenCalled();

    const saved = view.read().state;
    view.unmount();
    const restored = renderFinance(initial, <Transactions />);
    expect(restored.read().state.transactions).toEqual(saved.transactions);
    expect(restored.read().state.merchantRules).toEqual(saved.merchantRules);
    expect(restored.read().openReviewCount).toBe(0);
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("calculates once on first consumption, keeps save renders cached and synchronously reflects new state", () => {
    const dashboard = vi.spyOn(calc, "calculateDashboard");
    const view = renderFinance(fixture());
    act(() => view.read().update((state) => ({
      ...state, settings: { ...state.settings, asOf: "2026-10-16" },
    })));
    expect(dashboard).not.toHaveBeenCalled();
    view.rerenderChildren(<><DashboardReader label="left" /><DashboardReader label="right" /></>);
    expect(dashboard).toHaveBeenCalledTimes(1);
    expect(dashboard).toHaveBeenLastCalledWith(view.read().state);
    expect(screen.getByLabelText("left").textContent).toBe("2026-10");
    expect(screen.getByLabelText("right").textContent).toBe("2026-10");
    const previous = view.read();
    const previousDashboard = previous.dashboard;
    expect(previous.dashboard).toBe(previousDashboard);
    act(() => { vi.advanceTimersByTime(150); });
    expect(view.read().saved).toBe(true);
    expect(view.read().dashboard).toBe(previousDashboard);
    expect(dashboard).toHaveBeenCalledTimes(1);

    act(() => view.read().update((state) => ({
      ...state, settings: { ...state.settings, asOf: "2026-11-16" },
    })));
    expect(dashboard).toHaveBeenCalledTimes(2);
    expect(dashboard).toHaveBeenLastCalledWith(view.read().state);
    expect(screen.getByLabelText("left").textContent).toBe("2026-11");
    expect(screen.getByLabelText("right").textContent).toBe("2026-11");
    expect(view.read().dashboard).toEqual(calculateDashboard(view.read().state));
    expect(view.read().dashboard).not.toBe(previousDashboard);
    expect(previous.dashboard).toBe(previousDashboard);
    expect(previous.dashboard.currentMonth).toBe("2026-10");
    expect(dashboard).toHaveBeenCalledTimes(2);
  });

  it("binds previously unread snapshots to their state and invalidates on replacement and cross-tab hydration", () => {
    const dashboard = vi.spyOn(calc, "calculateDashboard");
    const view = renderFinance(fixture());
    const previous = view.read();
    const replacement = fixture(3);
    replacement.settings.balances.Sparkonto = 123;
    act(() => view.read().replace(replacement));
    const replaced = view.read();
    const external = fixture(4);
    external.settings.balances.Sparkonto = 456;
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: STORAGE_KEY, newValue: JSON.stringify(external),
    })));
    expect(dashboard).not.toHaveBeenCalled();
    expect(view.read().dashboard.actual.Sparkonto).toBe(456);
    expect(dashboard).toHaveBeenLastCalledWith(view.read().state);
    expect(replaced.dashboard.actual.Sparkonto).toBe(123);
    expect(previous.dashboard.actual.Sparkonto).toBe(0);
    expect(dashboard).toHaveBeenCalledTimes(3);
  });

  it("does not share cached dashboards between provider instances", () => {
    const dashboard = vi.spyOn(calc, "calculateDashboard");
    const initial = fixture();
    const first = renderFinance(initial);
    const second = renderFinance(initial);
    expect(dashboard).not.toHaveBeenCalled();
    const firstDashboard = first.read().dashboard;
    const secondDashboard = second.read().dashboard;
    expect(firstDashboard).toEqual(secondDashboard);
    expect(firstDashboard).not.toBe(secondDashboard);
    expect(dashboard).toHaveBeenCalledTimes(2);
    act(() => first.read().update((state) => ({
      ...state, settings: { ...state.settings, asOf: "2026-10-16" },
    })));
    expect(first.read().dashboard.currentMonth).toBe("2026-10");
    expect(second.read().dashboard).toBe(secondDashboard);
    expect(second.read().dashboard.currentMonth).toBe("2026-09");
    expect(dashboard).toHaveBeenCalledTimes(3);
  });

  it("tracks the current ledger month and resets filters without consuming a dashboard", () => {
    const dashboard = vi.spyOn(calc, "calculateDashboard");
    const view = renderFinance(fixture(), <Transactions />);
    act(() => view.read().update((state) => ({
      ...state, settings: { ...state.settings, asOf: "2026-10-16" },
    })));
    expect(screen.getByLabelText<HTMLSelectElement>("Monat filtern").value).toBe("2026-10");
    expect(screen.queryByRole("button", { name: "Zurücksetzen" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Monat filtern"), { target: { value: "2026-09" } });
    expect(screen.getByRole("table").textContent).toContain("Unbekannter Einkauf first");
    fireEvent.click(screen.getByRole("button", { name: "Zurücksetzen" }));
    expect(screen.getByLabelText<HTMLSelectElement>("Monat filtern").value).toBe("2026-10");
    expect(dashboard).not.toHaveBeenCalled();
  });

  it("reuses ledger classifications across filters, sorting and pagination but refreshes changed rows", () => {
    const dashboard = vi.spyOn(calc, "calculateDashboard");
    const classify = vi.spyOn(calc, "classify");
    const initial = fixture(60, 0);
    // Refunds avoid the separate expense-sharing control's per-visible-row classification.
    initial.transactions = initial.transactions.map((row) => ({ ...row, amount: 10 }));
    const view = renderFinance(initial, <Transactions />);
    classify.mockClear();
    fireEvent.change(screen.getByLabelText("Umsätze durchsuchen"), { target: { value: "Unbekannter" } });
    fireEvent.change(screen.getByLabelText("Kategorie filtern"), { target: { value: "Lebensmittel" } });
    fireEvent.change(screen.getByLabelText("Monat filtern"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^Kategorie$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Nächste Seite" }));
    fireEvent.click(screen.getByRole("button", { name: "Vorherige Seite" }));
    expect(classify).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Umsätze durchsuchen"), { target: { value: "Einkauf first" } });
    expect(screen.getByRole("table").textContent).toContain("Lebensmittel");
    act(() => view.read().update((state) => ({
      ...state,
      transactions: state.transactions.map((row) =>
        row.id === "first" ? { ...row, category: "Freizeit" } : row),
    })));
    expect(classify).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Kategorie filtern"), { target: { value: "Freizeit" } });
    expect(screen.getByRole("table").textContent).toContain("Unbekannter Einkauf first");
    expect(screen.getByRole("table").textContent).toContain("Freizeit");
    expect(dashboard).not.toHaveBeenCalled();
  });
});
