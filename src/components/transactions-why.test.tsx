// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFinance } from "@/components/finance-provider";
import { Transactions } from "@/components/transactions";
import { calculateDashboard } from "@/lib/calc";
import { openReviewCount } from "@/lib/import/review";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/statement-import", () => ({ StatementImport: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("explains a booking's category and opens the category editor", () => {
  const seed = createSeed();
  const booking: Transaction = { id: "hof", date: "2026-10-02", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
    description: "MUSTERHOF HOFLADEN", amount: -25, category: "Lebensmittel", includeInPlan: true, manualCategory: true };
  const state: AppState = { ...seed, settings: { ...seed.settings, asOf: "2026-10-08" }, transactions: [booking],
    fixedReceipts: [], merchantRules: [], reviewQueue: [] };
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update: vi.fn(), replace: vi.fn(),
    openReviewCount: openReviewCount([]), ready: true, saved: true,
    storageError: null, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  render(<Transactions />);
  fireEvent.click(screen.getByRole("button", { name: "Zuordnungsdetails: MUSTERHOF HOFLADEN" }));
  const why = screen.getByRole("region", { name: "Warum diese Kategorie?" });
  expect(within(why).getByText("Manuell gesetzt")).toBeTruthy();
  fireEvent.click(within(why).getByRole("button", { name: "Falsch? Kategorie ändern" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("saves a note on a booking and shows it in the list", async () => {
  const seed = createSeed();
  const booking: Transaction = { id: "tv", date: "2026-10-02", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
    description: "MEDIAMARKT WIEN", amount: -249, category: "Shopping", includeInPlan: true, manualCategory: true };
  const state: AppState = { ...seed, settings: { ...seed.settings, asOf: "2026-10-08" }, transactions: [booking],
    fixedReceipts: [], merchantRules: [], reviewQueue: [] };
  const update = vi.fn();
  const finance = (current: AppState) => ({
    state: current, dashboard: calculateDashboard(current), update, replace: vi.fn(),
    openReviewCount: openReviewCount([]), ready: true, saved: true,
    storageError: null, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  vi.mocked(useFinance).mockReturnValue(finance(state));
  const view = render(<Transactions />);
  fireEvent.click(screen.getAllByRole("button", { name: "Zuordnung ändern: MEDIAMARKT WIEN" })[0]);
  fireEvent.change(screen.getByLabelText("Notiz"), { target: { value: "  Fernseher fürs Wohnzimmer " } });
  fireEvent.click(screen.getByRole("button", { name: "Zuordnung übernehmen" }));
  await waitFor(() => expect(update).toHaveBeenCalled());
  const next = (update.mock.calls[0][0] as (current: AppState) => AppState)(state);
  expect(next.transactions[0].note).toBe("Fernseher fürs Wohnzimmer");

  vi.mocked(useFinance).mockReturnValue(finance(next));
  view.rerender(<Transactions />);
  expect(screen.getAllByText("Fernseher fürs Wohnzimmer").length).toBeGreaterThan(0);
});
