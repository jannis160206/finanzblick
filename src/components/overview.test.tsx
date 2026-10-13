// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Overview } from "./overview";
import { useFinance } from "./finance-provider";
import { calculateDashboard, monthsForYear } from "@/lib/calc";
import { createEmptyAccountState } from "@/lib/account-state";
import { initializeMotorcycleGoal } from "@/lib/goals";
import { currency, monthLabel } from "@/lib/format";
import { plannedOneOffSchema } from "@/lib/types";
import { monthlyVariableBudget } from "@/lib/variable-budgets";

const privacy = vi.hoisted(() => ({ locked: false }));
vi.mock("./finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("./security-mode-provider", () => ({ useSecurityMode: () => privacy }));
vi.mock("./seasonal-icons", () => ({ SeasonalIcon: ({ fallback }: { fallback?: ReactNode }) => fallback ?? null }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => children,
  BarChart: ({ data }: { data: unknown[] }) => <div data-testid="cashflow-chart" data-rows={JSON.stringify(data)} />,
  AreaChart: () => null, PieChart: () => null, Area: () => null, Bar: () => null,
  CartesianGrid: () => null, Cell: () => null, Pie: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); privacy.locked = false; });
const moneyText = (value: number) => currency(value).replace(/\u00a0/g, " ");

function fixture() {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-01";
  state.settings.balances.Sparkonto = 1800;
  state.financeRows = [
    { id: "salary", kind: "income", label: "Gehalt", values: Object.fromEntries([...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [month, 3000])) },
    { id: "rent", kind: "fixed", label: "Wohnen", values: { "2026-10": 600 } },
  ];
  state.transactions = [{
    id: "shopping", date: "2026-10-06", description: "Shop", amount: -180,
    bank: "Amex", pocket: "Amex", category: "Shopping", includeInPlan: false, sharedWithRaphael: true,
  }];
  state.savingsGoals = [{ id: "bike", name: "Motorrad", pocket: "Motorrad", target: 5400, date: "2027-04-01" }];
  state.plannedOneOffs = [plannedOneOffSchema.parse({ id: "planned", name: "Schrank", date: "2026-10-10", amount: 400, sharedWithRaphael: true })];
  state.bikeOnlyGoalApplied = false;
  return initializeMotorcycleGoal(state, 0);
}

function mount(state = fixture(), overrides: Partial<ReturnType<typeof calculateDashboard>> = {}) {
  const dashboard = { ...calculateDashboard(state), ...overrides };
  const update = vi.fn();
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard, update, replace: vi.fn(), ready: true, saved: true, storageError: null,
    openReviewCount: 0, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return { ...render(<Overview />), dashboard, update };
}

it("prioritizes the surplus, keeps model values and plan/actual distinctions, and removes redundant copy", () => {
  const state = fixture();
  const before = JSON.stringify(state);
  const { dashboard, container, update } = mount(state);
  const metrics = ["Überschuss · Plan", "Einnahmen · Plan", "Ausgaben · Ist", "Ersparnisse gesamt"];
  const values = [dashboard.current.surplus, dashboard.current.salaryPlan, dashboard.current.actualSpending, dashboard.totalAssets];
  metrics.forEach((label, index) => expect(within(screen.getByRole("region", { name: label })).getByText(moneyText(values[index]))).toBeTruthy());
  expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(metrics[0]);
  expect(screen.getByText(`Erhalten: ${moneyText(dashboard.current.salaryReceived)}`)).toBeTruthy();
  expect(dashboard.monthlyFunding.find((row) => row.id === "savings")?.amount).toBe(dashboard.current.surplus);
  expect(screen.queryByText(/DEIN FINANZCOCKPIT|Ist · alle vier Pockets|Ohne Umbuchungen|NOCH BIS ZUM KAUF/)).toBeNull();
  expect(screen.getByRole("link", { name: "Kontoauszüge importieren" }).getAttribute("href")).toBe("/umsaetze");
  expect(within(screen.getByRole("list", { name: "Geplant Oktober 2026" })).getByRole("listitem").textContent).toBe("Schrank 200 €");
  expect(JSON.stringify(state)).toBe(before);
  expect(update).not.toHaveBeenCalled();
});

it("keeps every 90-day forecast figure and labels rates for all goals, not only the motorcycle", () => {
  const state = fixture();
  state.savingsGoals!.push({ id: "camera", name: "Kamera", pocket: "Kamera", target: 300, date: "2026-10-20" });
  state.accountSnapshots = [{ bank: "Revolut", name: "Kamera", date: state.settings.asOf, balance: 0 }];
  const { dashboard } = mount(state);
  const forecast = within(screen.getByRole("region", { name: "Monatsprognose" }));
  expect(forecast.getAllByRole("article")).toHaveLength(3);
  for (const row of dashboard.ninetyDays) {
    const card = within(forecast.getByRole("article", { name: `Prognose ${monthLabel(row.month)}` }));
    expect(card.getByText("Rest nach Zielraten").previousElementSibling?.textContent).toBe(currency(row.remaining));
    for (const [label, value] of [["Einnahmen", row.income], ["Fixkosten", row.fixed], ["Alltagsbudget", row.variablePlan], ["Zielraten", row.surplus - row.remaining]] as const) {
      expect(card.getByText(label).nextElementSibling?.textContent).toBe(currency(value));
    }
  }
  expect(dashboard.ninetyDays[0].surplus - dashboard.ninetyDays[0].remaining).toBeGreaterThan(dashboard.ninetyDays[0].bikeTransfer);
});

it("does not display zero round-ups, but retains actual nonzero round-ups and pocket balances", () => {
  const { dashboard, unmount } = mount(fixture(), { currentRoundUp: 0 });
  expect(screen.queryByText(/Round-up/)).toBeNull();
  const pockets = within(screen.getByRole("region", { name: "Deine Pockets" }));
  expect(pockets.getAllByRole("link")).toHaveLength(5);
  expect(pockets.getByText(moneyText(dashboard.actual.Sparkonto))).toBeTruthy();
  unmount();
  mount(fixture(), { currentRoundUp: 12.34 });
  expect(screen.getByText(`Round-up +${moneyText(12.34)}`)).toBeTruthy();
});

it("expands the six-month cashflow on demand without changing the saved state", () => {
  const state = fixture();
  const before = JSON.stringify(state);
  const { container, dashboard, update, rerender } = mount(state);
  expect(screen.queryByTestId("cashflow-chart")).toBeNull();
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  const rows = JSON.parse(screen.getByTestId("cashflow-chart").getAttribute("data-rows")!);
  expect(rows).toHaveLength(6);
  expect(rows[0].income).toBe(dashboard.current.income);
  privacy.locked = true;
  rerender(<Overview />);
  const maskedChart = screen.getByTestId("cashflow-chart").closest("[data-financial-data]");
  expect(maskedChart?.getAttribute("aria-hidden")).toBe("true");
  expect(maskedChart?.hasAttribute("inert")).toBe(true);
  privacy.locked = false;
  rerender(<Overview />);
  expect(screen.getByTestId("cashflow-chart")).toBeTruthy();
  details.open = false;
  fireEvent(details, new Event("toggle"));
  expect(screen.queryByTestId("cashflow-chart")).toBeNull();
  expect(update).not.toHaveBeenCalled();
  expect(JSON.stringify(state)).toBe(before);
});

it("keeps negative surplus visible as a warning rather than presenting success", () => {
  const state = fixture();
  state.financeRows = [];
  mount(state);
  const surplus = screen.getByRole("region", { name: "Überschuss · Plan" });
  expect(surplus.className).toContain("border-destructive");
  expect(within(surplus).getByText(moneyText(calculateDashboard(state).current.surplus)).className).toContain("text-destructive");
});

it("supports an empty account and non-motorcycle goals without inventing funding", () => {
  const state = createEmptyAccountState();
  const { unmount } = mount(state);
  expect(screen.getByText("Noch keine Ausgaben")).toBeTruthy();
  expect(screen.getByText("Noch kein Sparziel")).toBeTruthy();
  expect(screen.queryByLabelText("Motorrad-Finanzierung")).toBeNull();
  const distribution = screen.getByRole("region", { name: "Pocket-Verteilung diesen Monat" });
  expect(within(distribution).getByText(moneyText(0))).toBeTruthy();
  expect(within(distribution).queryByLabelText("Sparkonto überwiesen")).toBeNull();
  expect(screen.getByRole("link", { name: "Monatsplan ergänzen" })).toBeTruthy();
  unmount();
  state.savingsGoals = [{ id: "camera", name: "Kamera", pocket: "Kamera", target: 1200, date: "2027-04-01" }];
  mount(state);
  expect(screen.getByRole("article", { name: "Sparziel Kamera" })).toBeTruthy();
  const progress = screen.getByRole("progressbar", { name: "Kamera Fortschritt" });
  expect(progress.hasAttribute("aria-valuenow")).toBe(false);
  expect(progress.getAttribute("aria-valuetext")).toBe("Kontostand unbekannt");
});

it.each([false, true])("shows the savings recommendation or the actual explicitly transferred amount (executed: %s)", (executed) => {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
    "2026-10": monthlyVariableBudget("2026-10").total + 301.4,
  } }];
  const base = { date: "2026-10-01", bank: "Revolut", category: "Transfer intern", includeInPlan: false } as const;
  state.transactions = [
    { ...base, id: "vacation", pocket: "Urlaub", amount: -300, description: "Auszahlung bei Pocket" },
    { ...base, id: "saving", pocket: "Sparen", amount: 300, description: "Um EUR Sparen von EUR einzustecken" },
    { ...base, id: "round-up", pocket: "Sparen", amount: 0.4, description: "Um EUR Sparen von EUR einzustecken" },
  ];
  if (executed) state.transactions.push({
    ...base, id: "main", pocket: "Persönliches Konto", amount: -300, description: "Um EUR Sparen von EUR einzustecken",
  });
  const { container, dashboard } = mount(state);
  const savings = container.querySelector<HTMLElement>('[data-funding-pot="Sparkonto"]')!;
  expect(within(savings).getByText(executed ? "Überwiesen" : "Sparempfehlung")).toBeTruthy();
  expect(within(savings).getByText(moneyText(executed ? 300 : 301.4))).toBeTruthy();
  expect(within(savings).getByText("Sparkonto").className).not.toContain("text-muted-foreground");
  expect(within(savings).getByText(executed ? "Überwiesen" : "Sparempfehlung").className).toContain("col-start-2");
  expect(dashboard.timeline.find((row) => row.month === dashboard.currentMonth)?.rates.Sparkonto).toBe(301.4);
  if (executed) expect(within(savings).getByLabelText("Sparkonto überwiesen")).toBeTruthy();
  else expect(within(savings).queryByLabelText("Sparkonto überwiesen")).toBeNull();
});

it.each([0, -478.6])("keeps the savings card visible at zero for surplus %s without changing the funding model", (surplus) => {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
    "2026-10": monthlyVariableBudget("2026-10").total + 780 + surplus,
  } }];
  state.plannedOneOffs = [plannedOneOffSchema.parse({
    id: "licence", name: "Führerschein", date: "2026-10-20", amount: 780, pocket: "Sparkonto",
  })];
  const before = JSON.stringify(state);
  const { dashboard, update } = mount(state);
  const distribution = screen.getByRole("region", { name: "Pocket-Verteilung diesen Monat" });
  expect(within(distribution).getByText("Sparempfehlung")).toBeTruthy();
  expect(within(distribution).getByText(moneyText(0))).toBeTruthy();
  expect(within(distribution).queryByLabelText("Sparkonto überwiesen")).toBeNull();
  expect(dashboard.monthlyFunding).toEqual([]);
  expect(dashboard.current.surplus).toBe(surplus);
  expect(screen.getByRole("region", { name: "Geplante Ausgaben" })).toBeTruthy();
  expect(JSON.stringify(state)).toBe(before);
  expect(update).not.toHaveBeenCalled();
});
