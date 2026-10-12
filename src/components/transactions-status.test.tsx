// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFinance } from "@/components/finance-provider";
import { Transactions } from "@/components/transactions";
import { calculateDashboard, classify } from "@/lib/calc";
import { statementFingerprint } from "@/lib/import/identity";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/statement-import", () => ({
  StatementImport: ({ reviewRequest }: { reviewRequest: number }) => (
    <output data-testid="review-request">{reviewRequest}</output>
  ),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows all month-filtered rows without status tabs and preserves review explanations", () => {
  const seed = createSeed();
  const receipt: Transaction = {
    id: "original-receipt", date: "2026-09-12", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
    description: "Testvertrag", amount: -35, category: "Telefon & Internet", categoryOverride: true,
    fixedCost: true, includeInPlan: false,
  };
  const old: Transaction = { ...receipt, id: "old", date: "2026-08-12", description: "Alter Vertrag" };
  const assigned: Transaction = { ...receipt, id: "assigned", description: "BIPA", amount: -5, category: "Mittagessen", fixedCost: false, includeInPlan: true };
  const state: AppState = {
    ...seed, settings: { ...seed.settings, asOf: "2026-09-15" }, transactions: [old, assigned],
    fixedReceipts: [{ key: statementFingerprint(receipt), booking: receipt, date: receipt.date, amount: receipt.amount, category: receipt.category }],
    reviewQueue: [
      { kind: "fixed", id: "fixed-change", change: { id: "fixed-change", category: receipt.category, month: "2026-09", previous: 30, amount: 35, bookings: [receipt] } },
      { kind: "booking", id: old.id, draft: old, message: "Historische Zuordnung prüfen." },
    ],
  };
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update: vi.fn(), replace: vi.fn(), openReviewCount: 2,
    ready: true, saved: true, storageError: null, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  render(<Transactions />);
  const toolbar = within(screen.getByRole("group", { name: "Umsatz-Werkzeugleiste" }));
  expect(screen.queryByRole("group", { name: "Zuordnungsstatus filtern" })).toBeNull();
  expect(toolbar.queryByRole("button", { name: /^(Alle|Prüfung offen|Zugeordnet)(\s*\d+)?$/ })).toBeNull();
  const table = screen.getByRole("table", { name: "Buchungen" });
  expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(within(table).getByText("Testvertrag")).toBeTruthy();
  expect(within(table).getByText("BIPA")).toBeTruthy();
  expect(within(table).getByText("Prüfung offen")).toBeTruthy();
  expect(within(table).getByText("Zugeordnet")).toBeTruthy();
  expect(screen.getByText("2 Treffer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Zuordnungsdetails: Testvertrag" }));
  expect(screen.getByText("Fixkostenbetrag hat sich geändert.")).toBeTruthy();
  expect(screen.getByText(classify(receipt).reason || "Außerhalb des Alltagsbudgets")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(toolbar.getByRole("button", { name: "Zuordnung prüfen" }));
  expect(screen.getByTestId("review-request").textContent).toBe("1");
  expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Monat filtern"), { target: { value: "" } });
  expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
  expect(screen.getByText("3 Treffer")).toBeTruthy();
  expect(within(table).getAllByText("Prüfung offen")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Zuordnungsdetails: Alter Vertrag" }));
  expect(screen.getByText("Historische Zuordnung prüfen.")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Zuordnungsdetails: BIPA" }));
  expect(screen.getByText("Für diese Buchung ist keine Prüfung offen.")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.change(screen.getByRole("textbox", { name: "Umsätze durchsuchen" }), { target: { value: "BIPA" } });
  expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(within(table).getByText("BIPA")).toBeTruthy();
  fireEvent.click(toolbar.getByRole("button", { name: "Zurücksetzen" }));
  expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(within(table).getByText("Prüfung offen")).toBeTruthy();
  expect(within(table).getByText("Zugeordnet")).toBeTruthy();
  expect(state.fixedReceipts?.[0].booking).toBe(receipt);
});

it("does not reopen a manually reviewed row for an identical unreviewed fixed-cost payment", () => {
  const seed = createSeed();
  const reviewed: Transaction = {
    id: "reviewed", date: "2026-09-12", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
    description: "Testvertrag", amount: -35, category: "Telefon & Internet", categoryOverride: true,
    fixedCost: true, includeInPlan: false, reviewed: true,
  };
  const twin = { ...reviewed, id: "unreviewed", reviewed: undefined };
  expect(statementFingerprint(twin)).toBe(statementFingerprint(reviewed));
  const state: AppState = {
    ...seed, settings: { ...seed.settings, asOf: "2026-09-15" }, transactions: [reviewed, twin],
    fixedReceipts: [], reviewQueue: [
      { kind: "fixed", id: "fixed-change", change: { id: "fixed-change", category: twin.category, month: "2026-09", previous: 30, amount: 35, bookings: [twin] } },
    ],
  };
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update: vi.fn(), replace: vi.fn(), openReviewCount: 1,
    ready: true, saved: true, storageError: null, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  render(<Transactions />);
  expect(screen.queryByRole("group", { name: "Zuordnungsstatus filtern" })).toBeNull();
  const table = screen.getByRole("table", { name: "Buchungen" });
  expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(within(table).getAllByText("Prüfung offen")).toHaveLength(1);
  expect(within(table).getAllByText("Geprüft")).toHaveLength(1);
  fireEvent.click(within(table).getByText("Geprüft"));
  expect(screen.getByText("Diese Buchung wurde manuell geprüft.")).toBeTruthy();
  expect(screen.getByText(classify(reviewed).reason || "Außerhalb des Alltagsbudgets")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(within(table).getByText("Prüfung offen"));
  expect(screen.getByText("Fixkostenbetrag hat sich geändert.")).toBeTruthy();
});
