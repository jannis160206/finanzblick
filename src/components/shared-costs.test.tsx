// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFinance } from "@/components/finance-provider";
import { Transactions } from "@/components/transactions";
import { actualBookings, calculateDashboard } from "@/lib/calc";
import { currency } from "@/lib/format";
import { createSeed } from "@/lib/seed";
import { personalAmount } from "@/lib/shared-holiday";
import type { AppState, Transaction } from "@/lib/types";

// Keep the real ledger, share controls, Radix dialogs/tabs and accounting.
// Only persistence and the unrelated file-import interface are replaced.
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/statement-import", () => ({ StatementImport: () => null }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const booking = (id: string, amount = -200): Transaction => ({
  id, description: `SWISS ${id}`, date: "2026-09-05", amount,
  category: "Urlaub", categoryOverride: true, bank: "Revolut", pocket: null, includeInPlan: true,
});
const fixture = (transactions: Transaction[]): AppState => ({
  ...createSeed(), transactions, financeRows: [], fixedReceipts: [], holidayRanges: [],
  settings: { ...createSeed().settings, asOf: "2026-09-15" },
});
function renderLedger(initial: AppState) {
  let current = initial;
  let change: (updater: (state: AppState) => AppState) => void = () => {};
  function Harness() {
    const [state, setState] = useState(initial);
    current = state;
    change = (updater) => act(() => setState(updater));
    vi.mocked(useFinance).mockReturnValue({
      state, dashboard: calculateDashboard(state), update: setState, replace: setState,
      openReviewCount: 0, ready: true, saved: true, storageError: null,
      retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
    });
    return <Transactions />;
  }
  const view = render(<Harness />);
  return { ...view, read: () => current, change: (updater: (state: AppState) => AppState) => change(updater) };
}
function openModal() {
  fireEvent.click(screen.getByRole("button", { name: "Geteilt" }));
  return screen.getByRole("dialog", { name: "Geteilt" });
}
function switchTab(name: "Suchen" | "Offen") {
  const tab = screen.getByRole("tab", { name: new RegExp(`^${name}`) });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  expect(tab.getAttribute("aria-selected")).toBe("true");
  return screen.getByRole("tabpanel");
}
function rowShare(row: Transaction) {
  const details = screen.getByLabelText(`Weitere Aktionen: ${row.description}`);
  if (!details.parentElement?.hasAttribute("open")) fireEvent.click(details);
  const action = screen.getByRole("button", { name: `Teilen: ${row.description}` });
  expect(action.previousElementSibling?.getAttribute("aria-label")).toBe(`Löschen: ${row.description}`);
  fireEvent.click(action);
  return screen.getByRole("dialog", { name: "Diese Buchung als geteilt markieren?" });
}

describe("Geteilt UI", () => {
  it("keeps all open shares exclusively in the modal, not stacked on the Umsatz page", () => {
    const open = Array.from({ length: 11 }, (_, i) => ({ ...booking(`open-${i}`), sharedWithRaphael: true }));
    const paid = { ...booking("paid"), sharedWithRaphael: true, sharedPaidManually: true };
    renderLedger(fixture([...open, paid]));
    expect(screen.queryByText("Offen · Raphael Piber")).toBeNull();
    expect(screen.queryByLabelText("Offene geteilte Kosten")).toBeNull();
    expect(screen.queryByText(/Weitere \d+ unter Geteilt/)).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByLabelText("11 offene Teilungen")).toBeTruthy();

    const dialog = openModal();
    const expectedSize = document.createElement("div");
    expectedSize.style.maxWidth = "min(500px, calc(100vw - 2rem))";
    expect(dialog.style.maxWidth).toBe(expectedSize.style.maxWidth);
    expect(dialog.style.maxHeight).toBe("70dvh");
    expect(dialog.style.overflow).toBe("hidden");
    expect(dialog.querySelector('[data-slot="dialog-header"]')?.parentElement?.className).toContain("sticky top-0");
    expect(dialog.querySelector('[data-slot="dialog-footer"]')?.className).toContain("sticky bottom-0");
    expect(within(dialog).queryByText("Offen · Raphael Piber")).toBeNull();
    const panel = switchTab("Offen");
    expect(panel.className).toContain("min-h-0 flex-1 overflow-y-auto");
    expect(within(panel).getByText("Offen · Raphael Piber")).toBeTruthy();
    expect(within(panel).getAllByRole("listitem")).toHaveLength(11);
    expect(within(panel).queryByText(paid.description)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Speichern" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Offen · Raphael Piber")).toBeNull();
  });

  it("requires row confirmation, then preserves bank facts and shows half in the ledger and Offen", () => {
    const row = booking("row", -101.01);
    const view = renderLedger(fixture([row]));
    const before = JSON.stringify(view.read());
    let confirm = rowShare(row);
    expect(within(confirm).getByText("Es zählt nur noch die Hälfte.")).toBeTruthy();
    expect(within(confirm).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Abbrechen" }));
    expect(JSON.stringify(view.read())).toBe(before);
    confirm = rowShare(row);
    fireEvent.click(within(confirm).getByRole("button", { name: "Teilen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.read().transactions[0]).toEqual({ ...row, sharedWithRaphael: true });
    expect(personalAmount(actualBookings(view.read())[0])).toBe(-50.51);
    expect(screen.getByRole("table").textContent).toContain(currency(-50.51));
    expect(screen.getByLabelText("1 offene Teilungen")).toBeTruthy();
    expect(screen.queryByText("Offen · Raphael Piber")).toBeNull();
    openModal();
    const panel = switchTab("Offen");
    expect(within(panel).getByText(row.description)).toBeTruthy();
    expect(panel.textContent).toContain(`Gesamt ${currency(101.01)} · Meine Hälfte ${currency(50.51)}`);
  });

  it("marks a receipt-backed ledger row without modifying the original date or full amount", () => {
    const row = booking("original-bank-id");
    const state = fixture([]);
    state.fixedReceipts = [{ key: "receipt-key", rowId: "contract", month: "2026-09", date: row.date,
      amount: row.amount, category: row.category, booking: row }];
    const view = renderLedger(state);
    const confirm = rowShare(row);
    fireEvent.click(within(confirm).getByRole("button", { name: "Teilen" }));
    expect(view.read().fixedReceipts?.[0].booking).toEqual({ ...row, sharedWithRaphael: true });
    expect(view.read().fixedReceipts?.[0].amount).toBe(-200);
    expect(view.read().transactions).toEqual([]);
    expect(personalAmount(actualBookings(view.read())[0])).toBe(-100);
    expect(screen.getByLabelText("1 offene Teilungen")).toBeTruthy();
  });

  it("filters by text/month/amount and previews 50 percent for pending multi-selection across tabs", () => {
    const first = booking("first");
    const second = booking("second", -60);
    const view = renderLedger(fixture([first, second]));
    const before = JSON.stringify(view.read());
    const dialog = openModal();
    fireEvent.change(screen.getByLabelText("Geteilte Buchungen suchen"), { target: { value: "swiss" } });
    fireEvent.change(screen.getByLabelText("Geteilt Monat"), { target: { value: "2026-09" } });
    fireEvent.change(screen.getByLabelText("Geteilt Gesamtbetrag"), { target: { value: "200,00" } });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    const check = within(dialog).getByRole("checkbox", { name: `Teilen: ${first.description} ${first.date}` });
    fireEvent.click(check);
    expect(check.closest("label")?.textContent).toContain("Meine Hälfte (50 %)");
    expect(check.closest("label")?.textContent).toContain(currency(100));
    expect(JSON.stringify(view.read())).toBe(before);
    fireEvent.change(screen.getByLabelText("Geteilt Gesamtbetrag"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: `Teilen: ${second.description} ${second.date}` }));
    switchTab("Offen");
    expect(within(dialog).getByText("2 ausgewählt")).toBeTruthy();
    switchTab("Suchen");
    expect(within(dialog).getAllByRole<HTMLInputElement>("checkbox").every((input) => input.checked)).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(view.read().transactions).toEqual([first, second].map((row) => ({ ...row, sharedWithRaphael: true })));
    expect(screen.getByLabelText("2 offene Teilungen")).toBeTruthy();
  });

  it("discards both pending selections and paid marks on cancel, X and Escape", () => {
    const open = { ...booking("open"), sharedWithRaphael: true };
    const candidate = booking("candidate");
    const view = renderLedger(fixture([open, candidate]));
    const before = JSON.stringify(view.read());
    for (const close of ["Abbrechen", "Geteilt schließen", "Escape"]) {
      const dialog = openModal();
      fireEvent.click(within(dialog).getByRole("checkbox"));
      switchTab("Offen");
      fireEvent.click(within(dialog).getByRole("button", { name: `Als bezahlt markieren: ${open.description}` }));
      expect(within(dialog).queryByRole("listitem")).toBeNull();
      expect(within(dialog).getByText(/1 bezahlt \(ungespeichert\)/)).toBeTruthy();
      if (close === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
      else fireEvent.click(within(dialog).getByRole("button", { name: close }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(JSON.stringify(view.read())).toBe(before);
    }
    const dialog = openModal();
    expect(within(dialog).getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
    switchTab("Offen");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
  });

  it("saves manual payment, hides a zero badge and retains the paid half in the ledger", () => {
    const row = { ...booking("open"), sharedWithRaphael: true };
    const view = renderLedger(fixture([row]));
    const dialog = openModal();
    switchTab("Offen");
    fireEvent.click(within(dialog).getByRole("button", { name: `Als bezahlt markieren: ${row.description}` }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(view.read().transactions[0]).toEqual({ ...row, sharedPaidManually: true });
    expect(screen.queryByLabelText(/offene Teilungen/)).toBeNull();
    expect(screen.getByRole("table").textContent).toContain(currency(-100));
    expect(screen.getByRole("table").textContent).toContain("Bezahlt");
    openModal();
    const panel = switchTab("Offen");
    expect(within(panel).queryByRole("listitem")).toBeNull();
    expect(within(panel).getByText("Keine offenen Teilungen.")).toBeTruthy();
  });

  it("removes an auto-matched Raphael repayment from Offen while keeping the original shared charge", () => {
    const row = { ...booking("flight"), sharedWithRaphael: true };
    const view = renderLedger(fixture([row]));
    openModal();
    switchTab("Offen");
    const incoming = { ...booking("repayment", 103), description: "Raphael Piber", date: "2026-09-10" };
    view.change((state) => ({ ...state, transactions: [...state.transactions, incoming] }));
    expect(within(screen.getByRole("tabpanel")).queryByRole("listitem")).toBeNull();
    expect(screen.queryByLabelText(/offene Teilungen/)).toBeNull();
    expect(view.read().transactions[0]).toEqual(row);
    expect(actualBookings(view.read()).map(personalAmount)).toEqual([-100, 0]);
  });

  it("does not offer sharing for income or internal transfers, or permit sharing a row twice", () => {
    const income = booking("income", 100);
    const transfer = { ...booking("transfer"), category: "Transfer" as const, description: "Pocket Transfer", pocket: "Motorrad" };
    const shared = { ...booking("shared"), sharedWithRaphael: true };
    renderLedger(fixture([income, transfer, shared]));
    fireEvent.click(screen.getByText("Weitere Filter"));
    fireEvent.click(screen.getByLabelText("Transfers anzeigen"));
    for (const row of [income, transfer, shared]) {
      fireEvent.click(screen.getByLabelText(`Weitere Aktionen: ${row.description}`));
      expect(screen.queryByRole("button", { name: `Teilen: ${row.description}` })).toBeNull();
    }
    expect(screen.getByRole<HTMLButtonElement>("button", { name: `Bereits geteilt: ${shared.description}` }).disabled).toBe(true);
  });
});
