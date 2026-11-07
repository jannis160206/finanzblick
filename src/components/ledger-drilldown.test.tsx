// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFinance } from "@/components/finance-provider";
import { Transactions } from "@/components/transactions";
import { calculateDashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/umsaetze",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/statement-import", () => ({ StatementImport: () => null }));

const booking = (id: string, description: string, category: Transaction["category"], patch: Partial<Transaction> = {}): Transaction => ({
  id, description, date: "2026-09-10", amount: -12, category, categoryOverride: true,
  bank: "Revolut", pocket: null, includeInPlan: true, reviewed: true, ...patch,
});
const state: AppState = {
  ...createSeed(),
  financeRows: [], fixedReceipts: [], holidayRanges: [],
  settings: { ...createSeed().settings, asOf: "2026-09-15" },
  transactions: [
    booking("food-1", "Billa Zentrum", "Lebensmittel"),
    booking("food-old", "Spar Altmonat", "Lebensmittel", { date: "2026-08-20" }),
    booking("out-1", "Restaurant Linde", "Restaurants"),
  ],
};
function Harness() {
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update: vi.fn(), replace: vi.fn(),
    openReviewCount: 0, ready: true, saved: true, storageError: null,
    retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return <Transactions />;
}
const shown = () => ({
  food: !!screen.queryByTitle(/Billa Zentrum/),
  out: !!screen.queryByTitle(/Restaurant Linde/),
  old: !!screen.queryByTitle(/Spar Altmonat/),
});

beforeEach(() => { nav.search = ""; nav.replace.mockClear(); });
afterEach(cleanup);

describe("ledger drilldown via URL", () => {
  it("shows exactly the bookings of the budget group in the requested month", () => {
    nav.search = "month=2026-09&group=food";
    render(<Harness />);
    expect(shown()).toEqual({ food: true, out: false, old: false });
    expect(screen.getByText("Budget: Lebensmittel & Haushalt")).toBeTruthy();
  });

  it("ignores invalid parameters without errors", () => {
    nav.search = "month=2026-99&group=nope&q=geheim";
    render(<Harness />);
    expect(shown()).toEqual({ food: true, out: true, old: false });
    expect(screen.queryByText(/Budget:/)).toBeNull();
  });

  it("follows the URL when the user navigates back", () => {
    nav.search = "month=2026-09&group=food";
    const view = render(<Harness />);
    expect(shown().out).toBe(false);
    nav.search = "";
    view.rerender(<Harness />);
    expect(shown().out).toBe(true);
    expect(screen.queryByText(/Budget:/)).toBeNull();
  });

  it("writes the group removal to the URL and never writes search text", () => {
    nav.search = "month=2026-09&group=food";
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Umsätze durchsuchen"), { target: { value: "Billa" } });
    expect(nav.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Budget: Lebensmittel/ }));
    expect(nav.replace).toHaveBeenCalledWith("/umsaetze?month=2026-09", { scroll: false });
    expect(nav.replace.mock.calls.flat().join("")).not.toContain("Billa");
  });
});
