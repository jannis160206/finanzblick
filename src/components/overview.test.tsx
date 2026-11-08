// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Overview } from "./overview";
import { useFinance } from "./finance-provider";
import { calculateDashboard, monthsForYear, round } from "@/lib/calc";
import { createEmptyAccountState } from "@/lib/account-state";
import { initializeMotorcycleGoal } from "@/lib/goals";
import { currency } from "@/lib/format";
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
  const metrics = ["Überschuss · Plan", "Einnahmen · Plan", "Ausgaben · Ist", "Guthaben gesamt"];
  const values = [dashboard.current.surplus, dashboard.current.income, dashboard.current.actualSpending, dashboard.totalAssets];
  metrics.forEach((label, index) => expect(within(screen.getByRole("region", { name: label })).getAllByText(moneyText(values[index])).length).toBeGreaterThan(0));
  expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(metrics[0]);
  expect(screen.getByText(`Erhalten: ${moneyText(dashboard.current.received)}`)).toBeTruthy();
  expect(dashboard.monthlyFunding.find((row) => row.id === "savings")?.amount).toBe(dashboard.current.surplus);
  expect(screen.queryByText(/DEIN FINANZCOCKPIT|Ist · alle vier Pockets|Ohne Umbuchungen|NOCH BIS ZUM KAUF/)).toBeNull();
  expect(screen.queryByRole("link", { name: "Kontoauszüge importieren" })).toBeNull();
  for (const removed of ["Monatsprognose", "Deine Pockets", "Pocket-Verteilung diesen Monat"]) expect(screen.queryByRole("region", { name: removed })).toBeNull();
  expect(screen.queryByText(/Vermögensentwicklung|Einnahmen & Ausgaben|Werte als Tabelle/)).toBeNull();
  expect(within(screen.getByRole("list", { name: "Geplant Oktober 2026" })).getByRole("listitem").textContent).toBe("Schrank 200 €");
  expect(JSON.stringify(state)).toBe(before);
  expect(update).not.toHaveBeenCalled();
});

it("keeps the 90-day model consistent even though the overview no longer repeats it", () => {
  const state = fixture();
  state.savingsGoals!.push({ id: "camera", name: "Kamera", pocket: "Kamera", target: 300, date: "2026-10-20" });
  state.accountSnapshots = [{ bank: "Revolut", name: "Kamera", date: state.settings.asOf, balance: 0 }];
  const { dashboard } = mount(state);
  for (const row of dashboard.ninetyDays) {
    expect(round(row.income - row.fixed - row.variablePlan - row.plannedOneOffs - (row.surplus - row.remaining))).toBe(row.remaining);
  }
  expect(dashboard.ninetyDays[0].surplus - dashboard.ninetyDays[0].remaining).toBeGreaterThan(dashboard.ninetyDays[0].bikeTransfer);
});

it("keeps negative surplus visible as a warning rather than presenting success", () => {
  const state = fixture();
  state.financeRows = [];
  mount(state);
  const surplus = screen.getByRole("region", { name: "Überschuss · Plan" });
  expect(surplus.className).toContain("border-destructive");
  expect(within(surplus).getByText(moneyText(calculateDashboard(state).current.surplus)).className).toContain("text-destructive");
});

it("supports an empty account without inventing data", () => {
  mount(createEmptyAccountState());
  expect(screen.getByText("Noch keine Ausgaben")).toBeTruthy();
  expect(screen.queryByLabelText("Motorrad-Finanzierung")).toBeNull();
});

it.each([false, true])("shows the savings recommendation or the actual explicitly transferred amount (executed: %s)", (executed) => {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-01";
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
  const { dashboard } = mount(state);
  const savings = dashboard.monthlyFunding.find((row) => row.id === "savings");
  expect(savings?.done ?? false).toBe(executed);
  if (executed) expect(savings?.transferred).toBe(300);
  expect(dashboard.timeline.find((row) => row.month === dashboard.currentMonth)?.rates.Sparkonto).toBe(301.4);
});

it.each([0, -478.6])("keeps the funding model unchanged for surplus %s", (surplus) => {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-01";
  state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
    "2026-10": monthlyVariableBudget("2026-10").total + 780 + surplus,
  } }];
  state.plannedOneOffs = [plannedOneOffSchema.parse({
    id: "licence", name: "Führerschein", date: "2026-10-20", amount: 780, pocket: "Sparkonto",
  })];
  const before = JSON.stringify(state);
  const { dashboard, update } = mount(state);
  expect(dashboard.monthlyFunding).toEqual([]);
  expect(dashboard.current.surplus).toBe(surplus);
  expect(screen.getByRole("region", { name: "Geplante Ausgaben" })).toBeTruthy();
  expect(JSON.stringify(state)).toBe(before);
  expect(update).not.toHaveBeenCalled();
});
