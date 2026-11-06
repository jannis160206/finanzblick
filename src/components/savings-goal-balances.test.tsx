// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Overview } from "@/components/overview";
import { SavingsGoals } from "@/components/savings-goals";
import { useFinance } from "@/components/finance-provider";
import { PocketBalanceCards } from "@/components/pocket-balance-cards";
import { PocketForecast } from "@/components/pocket-details";
import { calculateDashboard } from "@/lib/calc";
import { physicalAssetTotal, physicalPocketBalances } from "@/lib/goals";
import { createSeed } from "@/lib/seed";
import { currency } from "@/lib/format";
import { emptyPockets, type AppState, type SavingsGoal } from "@/lib/types";
import { monthlyVariableBudget } from "@/lib/variable-budgets";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/seasonal-icons", () => ({ SeasonalIcon: ({ fallback }: { fallback?: ReactNode }) => fallback ?? null }));
vi.mock("@/components/planned-one-offs", () => ({ PlannedOneOffs: () => null, PlannedOneOffLines: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("recharts", () => ({
  ResponsiveContainer: () => null, Area: () => null, AreaChart: () => null, Bar: () => null,
  BarChart: () => null, CartesianGrid: () => null, Cell: () => null, Pie: () => null, PieChart: () => null,
  Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const goal = (id: string, pocket = id): SavingsGoal => ({ id, name: id, pocket, target: 1000, date: "2027-04-01" });
function fixture(): AppState {
  const state = createSeed();
  state.settings = { ...state.settings, baselineDate: "2026-09-01", asOf: "2026-10-14", balances: emptyPockets() };
  state.months = {};
  state.transactions = [];
  state.financeRows = [];
  state.accountSnapshots = [];
  state.pocketSnapshots = [];
  state.trBalances = [];
  state.savingsGoals = [];
  return state;
}
function mount(initial: AppState, overview = false) {
  let current = initial;
  function Harness() {
    const [state, setState] = useState(initial);
    current = state;
    vi.mocked(useFinance).mockReturnValue({
      state, dashboard: calculateDashboard(state), update: setState, replace: setState,
      openReviewCount: 0, ready: true, saved: true, storageError: null,
      retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
    });
    return overview ? <Overview /> : <SavingsGoals />;
  }
  render(<Harness />);
  return () => current;
}

describe("observed and unknown goal UI", () => {
  it.each([false, true])("uses core balance1000 instead of goal zero (overview=%s)", (overview) => {
    const state = fixture();
    state.settings.balances.Sparkonto = 1000;
    state.savingsGoals = [goal("Kamera", "Sparkonto")];
    mount(state, overview);
    const card = screen.getByRole("article", { name: "Sparziel Kamera" });
    expect(card.textContent).toContain(`${currency(1000)} von ${currency(1000)}`);
    expect(within(card).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it.each([false, true])("does not render an unobserved opening as knownzero (overview=%s)", (overview) => {
    const state = fixture();
    state.settings.balances.Sparkonto = 1000;
    state.savingsGoals = [goal("Kamera")];
    state.transactions = [{ id: "movement", date: "2026-10-10", bank: "Revolut", pocket: "Kamera", amount: 100, description: "Transfer intern", category: "Transfer intern", includeInPlan: false }];
    mount(state, overview);
    const card = screen.getByRole("article", { name: "Sparziel Kamera" });
    expect(card.textContent).toContain("Kontostand unbekannt");
    expect(within(card).getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    expect(within(card).getByRole("progressbar").getAttribute("aria-valuetext")).toBe("Kontostand unbekannt");
    expect(screen.getByRole("status").textContent).toContain("Automatische Sparempfehlung pausiert");
    if (overview) {
      expect(screen.getByLabelText("Pocket-Verteilung diesen Monat").textContent).toContain("Empfehlung pausiert");
      expect(screen.getByLabelText("Ersparnisse gesamt").textContent).toContain("Unvollständig");
      expect(screen.getByLabelText("Prognose bekannter Pocket-Guthaben")).toBeTruthy();
      expect(screen.queryByLabelText("Prognose des gesamten Pocket-Vermögens")).toBeNull();
    }
  });

  it("displays an observed zero with actual zero progress", () => {
    const state = fixture();
    state.savingsGoals = [goal("Kamera")];
    state.accountSnapshots = [{ bank: "Revolut", name: "Kamera", date: state.settings.asOf, balance: 0 }];
    mount(state);
    const card = screen.getByRole("article", { name: "Sparziel Kamera" });
    expect(card.textContent).toContain(`${currency(0)} von ${currency(1000)}`);
    expect(within(card).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(card.textContent).not.toContain("Kontostand unbekannt");
  });

  it("shows the explicit400 instruction while an unknown physical opening leaves goal progress unknown", () => {
    const state = fixture();
    state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
      "2026-10": monthlyVariableBudget("2026-10").total + 620,
    } }];
    state.savingsGoals = [{ ...goal("Kamera"), funding: { monthly: 400, extras: {} } }];
    mount(state, true);
    const card = screen.getByRole("article", { name: "Sparziel Kamera" });
    expect(card.textContent).toContain("Kontostand unbekannt");
    expect(within(card).getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    const distribution = screen.getByLabelText("Pocket-Verteilung diesen Monat");
    const instruction = distribution.querySelector('[data-funding-pot="Kamera"]')!;
    expect(instruction.textContent).toContain(currency(400));
    expect(within(distribution).queryByLabelText("Kamera überwiesen")).toBeNull();
  });

  it.each([500, 1000])("checks off one aggregate1000 instruction only after the matching incoming amount (%s)", (amount) => {
    const state = fixture();
    state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
      "2026-10": monthlyVariableBudget("2026-10").total + 1000,
    } }];
    state.savingsGoals = [{ ...goal("Kamera", "Sparen"), target: 10000 }];
    state.transactions = [{ id: "incoming", date: "2026-10-10", bank: "Revolut", pocket: "Sparkonto",
      amount, description: "Transfer intern", category: "Transfer intern", includeInPlan: false }];
    mount(state, true);
    const distribution = screen.getByLabelText("Pocket-Verteilung diesen Monat");
    const instruction = distribution.querySelector('[data-funding-pot="Sparkonto"]')!;
    expect(distribution.querySelectorAll("[data-funding-pot]")).toHaveLength(1);
    expect(instruction.getAttribute("data-funding-combined")).toBe("true");
    expect(instruction.textContent).toContain(currency(1000));
    expect(instruction.textContent).toContain("Gemeinsame Überweisung");
    expect(within(distribution).queryByLabelText("Sparkonto überwiesen")).toBeNull();
    expect(!!within(distribution).queryByLabelText("Sparkonto + Kamera überwiesen")).toBe(amount === 1000);
  });

  it.each([false, true])("does not promise two fully funded goals from one1000 pocket (overview=%s)", (overview) => {
    const state = fixture();
    state.savingsGoals = [goal("Kamera", "Extra"), goal("Reise", " extra ")];
    state.accountSnapshots = [{ bank: "Revolut", name: "Extra", date: state.settings.asOf, balance: 1000 }];
    mount(state, overview);
    for (const name of ["Kamera", "Reise"]) {
      const card = screen.getByRole("article", { name: `Sparziel ${name}` });
      expect(card.textContent).toContain("Zuordnung offen");
      expect(within(card).getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    }
    expect(screen.getByRole("status").textContent).toContain("Pocket-Zuordnung eines Ziels klären");
  });

  it("does not mark an unresolved motorcycle goal as funded or predict a required numeric rate", () => {
    const state = fixture();
    state.settings.balances.Motorrad = 1000;
    state.savingsGoals = [goal("Motorrad"), goal("Ausrüstung", "Motorrad")];
    mount(state, true);
    const progress = screen.getByRole("progressbar", { name: "Motorradziel" });
    const card = progress.closest("section")!;
    expect(progress.hasAttribute("aria-valuenow")).toBe(false);
    expect(card.textContent).toContain("Zuordnung offen");
    expect(card.textContent).not.toContain("Ziel erreicht");
    expect(within(card).getByText("Benötigt / Monat").nextElementSibling?.textContent).toBe("—");
    expect(within(card).getByText(/Geplant ·/).nextElementSibling?.textContent).toBe("—");
  });

  it("removes a goal without losing its independent physical opening", () => {
    const state = fixture();
    state.savingsGoals = [{ ...goal("Kamera"), openingBalance: { date: "2026-10-01", amount: 1000 }, completedAt: "2026-10-01" }];
    const read = mount(state);
    fireEvent.keyDown(screen.getByRole("button", { name: "Kamera Menü" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Entfernen" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Entfernen" }));
    expect(read().savingsGoals).toEqual([]);
    expect(physicalAssetTotal(physicalPocketBalances(read(), emptyPockets()))).toBe(1000);
    expect(read().transactions).toEqual(state.transactions);
    expect(read().settings.balances).toEqual(state.settings.balances);
  });

  it("keeps unknown core pocket balances and their absolute predictions explicitly unknown", () => {
    const state = fixture();
    state.settings.unknownBalances = ["Sparkonto"];
    const dashboard = calculateDashboard(state);
    render(<>
      <PocketBalanceCards state={state} actual={dashboard.actual} disabled={false} editRef={null} onEdit={vi.fn()} />
      <PocketForecast state={state} dashboard={dashboard} />
    </>);
    expect(screen.getByLabelText("Sparkonto Kontostand").textContent).toBe("Kontostand unbekannt");
    const forecast = screen.getByRole("table", { name: "Pocket-Prognose", hidden: true });
    expect(forecast.textContent).toContain("Unbekannt");
  });

  it("does not present an independent motorcycle opening as confirmed bank cash", () => {
    const state = fixture();
    state.savingsGoals = [{ ...goal("Motorrad"), openingBalance: { date: "2026-10-01", amount: 2445 } }];
    const dashboard = calculateDashboard(state);
    render(<PocketBalanceCards state={state} actual={dashboard.actual} disabled={false} editRef={null} onEdit={vi.fn()} />);
    expect(screen.getByLabelText("Motorrad Kontostand").textContent).toBe(currency(0));
  });

  it("keeps unknown bank cash unknown even when an independent physical opening is known", () => {
    const state = fixture();
    state.settings.unknownBalances = ["Motorrad"];
    state.pocketOpeningBalances = [{ pocket: "Motorrad", date: "2026-10-01", amount: 2445 }];
    const dashboard = calculateDashboard(state);
    expect(dashboard.physical.motorrad).toMatchObject({ status: "known", source: "opening", amount: 2445 });
    expect(dashboard.totalAssets).toBe(2445);
    render(<PocketBalanceCards state={state} actual={dashboard.actual} disabled={false} editRef={null} onEdit={vi.fn()} />);
    expect(screen.getByLabelText("Motorrad Kontostand").textContent).toBe("Kontostand unbekannt");
  });

  it("does not present conflicting core snapshots as a numeric forecast", () => {
    const state = fixture();
    state.accountSnapshots = [
      { bank: "Revolut", name: "Sparen", date: state.settings.asOf, balance: 1000 },
      { bank: "Revolut", name: "Sparkonto", date: state.settings.asOf, balance: 2000 },
    ];
    const dashboard = calculateDashboard(state);
    render(<PocketForecast dashboard={dashboard} />);
    const table = screen.getByRole("table", { name: "Pocket-Prognose", hidden: true });
    const current = within(table).getAllByRole("row", { hidden: true }).find((row) => row.textContent?.startsWith("Okt"));
    expect(current?.textContent).toContain("Unbekannt");
  });
});
