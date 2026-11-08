// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MonthlyFunding } from "@/components/monthly-funding";
import { SavingsGoals } from "@/components/savings-goals";
import { useFinance } from "@/components/finance-provider";
import { actualPockets, calculateDashboard, monthsForYear } from "@/lib/calc";
import { initializeMotorcycleGoal } from "@/lib/goals";
import { createSeed } from "@/lib/seed";
import { currency } from "@/lib/format";
import type { AppState } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/seasonal-icons", () => ({ SeasonalIcon: ({ fallback }: { fallback?: ReactNode }) => fallback ?? null }));
vi.mock("@/components/planned-one-offs", () => ({ PlannedOneOffs: () => null, PlannedOneOffLines: () => null }));
vi.mock("recharts", () => ({
  ResponsiveContainer: () => null, Area: () => null, AreaChart: () => null, Bar: () => null,
  BarChart: () => null, CartesianGrid: () => null, Cell: () => null, Pie: () => null, PieChart: () => null,
  Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function fixture() {
  const state = createSeed();
  state.settings.asOf = "2026-10-05";
  state.financeRows = [{
    id: "salary", kind: "income", label: "Gehalt",
    values: Object.fromEntries([...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [month, 2576])),
  }];
  return initializeMotorcycleGoal(state, actualPockets(state).Motorrad);
}
function mount(initial = fixture(), settings = false) {
  let current: AppState = initial;
  function Harness() {
    const [state, setState] = useState(initial);
    current = state;
    vi.mocked(useFinance).mockReturnValue({
      state, dashboard: calculateDashboard(state), update: setState, replace: setState,
      openReviewCount: 0, ready: true, saved: true, storageError: null,
      retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
    });
    return settings ? <SavingsGoals /> : <MonthlyFunding />;
  }
  render(<Harness />);
  return () => current;
}

describe("motorcycle overview and existing goal editor", () => {
  it.each([
    ["2026-10-05", 0], ["2026-11-05", 0], ["2026-12-05", 800],
    ["2027-01-05", 2576], ["2027-02-28", 0], ["2027-03-01", 0],
  ] as const)("shows the actual savings/vacation schedule and motorcycle extras on %s", (asOf, bikeAmount) => {
    const state = fixture();
    state.settings.asOf = asOf;
    const dashboard = calculateDashboard(state);
    mount(state);
    const split = screen.getByLabelText("Pocket-Verteilung diesen Monat");
    const paused = asOf < "2027-03-01";
    expect(split.querySelector('[data-funding-pot="Sparkonto"]')?.textContent)
      .toContain(currency(paused ? dashboard.current.surplus - dashboard.current.goalExtras : 180));
    expect(!!split.querySelector('[data-funding-pot="Urlaub"]')).toBe(!paused);
    expect(!!split.querySelector('[data-funding-pot="Motorrad"]')).toBe(bikeAmount > 0);
    if (bikeAmount) expect(split.querySelector('[data-funding-pot="Motorrad"]')?.textContent).toContain(currency(bikeAmount));
  });
  it("keeps the bike-only target, saved balance and zero normal monthly rate in the model", () => {
    const dashboard = calculateDashboard(fixture());
    const bike = fixture().savingsGoals![0];
    expect(bike.target).toBe(5400);
    expect(bike.date).toBe("2027-04-01");
    expect(bike.funding?.monthly).toBe(0);
    expect(dashboard.countdown.onTrack).toBe(true);
    expect(dashboard.nextTransfer).toBe(0);
    mount();
    expect(screen.getByLabelText("Pocket-Verteilung diesen Monat").textContent).not.toContain("Motorrad");
  });
  it.each([["2026-12-05", 800], ["2027-01-05", 2576], ["2027-02-05", 0], ["2027-05-05", 0]] as const)(
    "plans only scheduled motorcycle funding on %s", (asOf, amount) => {
      const state = fixture(); state.settings.asOf = asOf;
      expect(calculateDashboard(state).nextTransfer).toBe(amount);
    },
  );
  it("keeps the same goal and its opening and extras when saved in the existing editor", () => {
    const read = mount(fixture(), true);
    const before = read().savingsGoals![0];
    const card = screen.getByRole("article", { name: "Sparziel Motorrad" });
    expect(card.textContent).toContain(`${currency(2445)} von ${currency(5400)}`);
    fireEvent.click(within(card).getByRole("button", { name: "Motorrad bearbeiten" }));
    expect((screen.getByLabelText("Betrag") as HTMLInputElement).value).toBe("5400");
    expect((screen.getByLabelText("Bis-Datum") as HTMLInputElement).value).toBe("2027-04-01");
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(read().savingsGoals).toEqual([before]);
  });
});
