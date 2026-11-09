// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { budgetTone, BudgetProgressCard } from "./budget-progress-card";
import { NetWorthCard } from "./net-worth-card";
import { GoalsCard } from "./goals-card";
import { useFinance } from "@/components/finance-provider";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { currency } from "@/lib/format";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => children,
  AreaChart: () => null, Area: () => null, Tooltip: () => null,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const text = (value: number) => currency(value).replace(/\u00a0/g, " ");

function mount(state = createEmptyAccountState()) {
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update: vi.fn(), replace: vi.fn(), ready: true, saved: true,
    storageError: null, openReviewCount: 0, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return state;
}

it("grades budget usage as in range, tight or exceeded", () => {
  expect(budgetTone(50, 100)).toBe("default");
  expect(budgetTone(90, 100)).toBe("warning");
  expect(budgetTone(101, 100)).toBe("destructive");
  expect(budgetTone(0, 0)).toBe("muted");
  expect(budgetTone(5, 0)).toBe("destructive");
});

it("shows the remaining everyday budget with accessible progress bars per position", () => {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-01";
  mount(state);
  const { plan } = calculateDashboard(state);
  render(<BudgetProgressCard />);
  const card = screen.getByRole("region", { name: /Budget Oktober 2026/ });
  expect(within(card).getByRole("progressbar", { name: "Alltagsbudget gesamt" })).toBeTruthy();
  expect(within(card).getAllByRole("progressbar")).toHaveLength(1 + Math.min(5, plan.rows.length));
  expect(within(card).getAllByText(text(plan.total), { exact: false }).length).toBeGreaterThan(0);
});

it("explains missing balances instead of inventing a net worth", () => {
  render(<NetWorthCard points={[]} />);
  expect(screen.getByText("Noch keine Kontostände")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it("lists the accounts behind the net worth and the change since the first known month", () => {
  render(<NetWorthCard points={[
    { month: "2026-08", total: 1000, parts: { girokonto: 1000 } },
    { month: "2026-09", total: 1150, parts: { girokonto: 1400, amex: -250 } },
  ]} />);
  const card = screen.getByRole("region", { name: "Nettovermögen" });
  expect(within(card).getByText(text(1150))).toBeTruthy();
  expect(within(card).getByText(/\+150,00/)).toBeTruthy();
  expect(within(card).getByText("Girokonto")).toBeTruthy();
  expect(within(card).getByText(text(-250)).className).toContain("text-destructive");
  expect(within(card).getByRole("img").getAttribute("aria-label")).toContain("auf");
});

it("offers to create the first savings goal when none exist", () => {
  mount();
  render(<GoalsCard />);
  expect(screen.getByText("Noch keine Sparziele")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Sparziel anlegen" }).getAttribute("href")).toBe("/sparen#sparziele");
});
