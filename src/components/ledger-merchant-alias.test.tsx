// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { Transactions } from "./transactions";
import { createSeed } from "@/lib/seed";
import { prepareStatementImport } from "@/lib/import/review";
import { statementFingerprint } from "@/lib/import/identity";
import { applyMerchantRules, merchantAliasSourceKey } from "@/lib/import/merchant-rules";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const original: Transaction = {
  id: "ledger-original", bank: "Raiffeisen", pocket: "Raiffeisen Giro", date: "2026-09-01",
  description: "Sonstiges IBAN Empfaenger: AT000000000000000001 BIC Empfaenger: TESTATXX Empfaenger: Musterstrasse 15 9020 Klagenfurt",
  rawDescription: "Unveränderter synthetischer Banktext", rawDetails: ["Synthetische Bankdetails"],
  bankReference: "synthetic-reference", occurrence: 1,
  amount: -3, category: "Sonstiges", includeInPlan: true,
};

function mount(booking = original, receiptBacked = false) {
  const state: AppState = {
    ...createSeed(), transactions: receiptBacked ? [] : [booking], financeRows: [], merchantRules: [],
    reviewQueue: [], holidayRanges: [],
    fixedReceipts: receiptBacked ? [{
      key: statementFingerprint(booking), merchantKey: merchantAliasSourceKey(booking),
      booking, date: booking.date, amount: booking.amount, category: booking.category,
    }] : [],
  };
  let current: ReturnType<typeof useFinance>;
  function Harness() {
    const finance = useFinance();
    useEffect(() => { current = finance; }, [finance]);
    return <Transactions />;
  }
  const view = render(<FinanceProvider initialState={state}><Harness /></FinanceProvider>);
  fireEvent.change(screen.getByLabelText("Monat filtern"), { target: { value: "" } });
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: `Zuordnung ändern: ${booking.description}` }));
    return within(screen.getByRole("dialog", { name: "Zuordnung ändern" }));
  };
  const savedBooking = () => receiptBacked
    ? current.state.fixedReceipts![0].booking!
    : current.state.transactions.find((row) => row.id === booking.id)!;
  return { ...view, read: () => current, open, savedBooking };
}

function editName(dialog: Pick<typeof screen, "getByRole">, name: string) {
  fireEvent.click(dialog.getByRole("button", { name: "Händlername bearbeiten" }));
  const input = dialog.getByRole<HTMLInputElement>("textbox", { name: "Händlername" });
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  fireEvent.change(input, { target: { value: name } });
  return input;
}

async function confirm(dialog: ReturnType<typeof within>) {
  fireEvent.click(dialog.getByRole("button", { name: "Zuordnung übernehmen" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Zuordnung ändern" })).toBeNull());
}

it.each([false, true])("confirms an alias and learns future outgoing assignments through the real provider (receipt=%s)", async (receiptBacked) => {
  const view = mount(original, receiptBacked);
  const before = view.read().state;
  const dialog = view.open();
  expect(dialog.queryByRole("textbox", { name: "Händlername" })).toBeNull();
  expect(dialog.getByText(original.description)).toBeTruthy();
  editName(dialog, "  Hausverwaltung  ");
  fireEvent.click(dialog.getByRole("checkbox", { name: "Als Fixkosten markieren" }));
  fireEvent.change(dialog.getByLabelText("Kategorie"), { target: { value: "Miete" } });
  expect(view.read().state).toBe(before);
  expect(dialog.getByText(original.description)).toBeTruthy();
  await confirm(dialog);
  expect(view.savedBooking()).toMatchObject({
    ...original, merchantAlias: "Hausverwaltung", category: "Miete",
    manualCategory: true, categoryOverride: true, reviewed: true, fixedCost: true, includeInPlan: false,
  });
  expect(statementFingerprint(view.savedBooking())).toBe(statementFingerprint(original));
  expect(within(screen.getByRole("table", { name: "Buchungen" })).getByText("Hausverwaltung")).toBeTruthy();
  expect(view.read().state.merchantRules).toContainEqual({
    key: merchantAliasSourceKey(original), merchantAlias: "Hausverwaltung", category: "Miete", fixedCost: true,
  });
  if (receiptBacked) {
    expect(view.read().state.transactions).toEqual([]);
    expect(view.read().state.fixedReceipts![0].key).toBe(statementFingerprint(original));
  }
  await waitFor(() => {
    const persisted: AppState = JSON.parse(localStorage.getItem("finanzdashboard.v1")!);
    expect(receiptBacked ? persisted.fixedReceipts![0].booking?.merchantAlias : persisted.transactions[0]?.merchantAlias)
      .toBe("Hausverwaltung");
    expect(persisted.merchantRules).toEqual(view.read().state.merchantRules);
  });
  view.unmount();
  const loaded = mount(original, receiptBacked);
  expect(loaded.savedBooking().merchantAlias).toBe("Hausverwaltung");
  const future = { ...original, id: "future", date: "2026-10-01" };
  const prepared = prepareStatementImport([{
    file: "synthetic.csv", source: "Raiffeisen", rows: [future], issues: [], skipped: 0,
  }], loaded.read().state);
  expect(prepared.automatic).toHaveLength(1);
  expect(prepared.automatic[0]).toMatchObject({
    ...future, merchantAlias: "Hausverwaltung", category: "Miete", fixedCost: true, includeInPlan: false,
  });
  act(() => loaded.read().appendStatements(prepared.automatic, prepared.duplicates, "future-import", [], prepared.metadata));
  expect(loaded.read().state.transactions.find((row) => row.id === future.id)).toMatchObject({
    ...future, merchantAlias: "Hausverwaltung", category: "Miete", fixedCost: true, includeInPlan: false,
  });
  expect(applyMerchantRules(loaded.read().state, [{ ...future, id: "credit", amount: 3 }])[0].merchantAlias).toBeUndefined();
});

it("rejects an empty alias and discards unconfirmed edits when cancelled", async () => {
  const view = mount();
  const before = view.read().state;
  const dialog = view.open();
  const input = editName(dialog, "   ");
  const confirmButton = dialog.getByRole<HTMLButtonElement>("button", { name: "Zuordnung übernehmen" });
  expect(confirmButton.disabled).toBe(true);
  expect(dialog.getByRole("alert").textContent).toBe("Bitte einen Händlernamen eingeben.");
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
  expect(view.read().state).toBe(before);
  expect(screen.getByRole("dialog", { name: "Zuordnung ändern" })).toBeTruthy();
  fireEvent.change(input, { target: { value: "Nicht speichern" } });
  fireEvent.change(dialog.getByLabelText("Kategorie"), { target: { value: "Shopping" } });
  fireEvent.click(dialog.getByRole("checkbox", { name: "Als Fixkosten markieren" }));
  expect(confirmButton.disabled).toBe(false);
  fireEvent.click(dialog.getByRole("button", { name: "Abbrechen" }));
  expect(view.read().state).toBe(before);
  const reopened = view.open();
  expect(reopened.queryByRole("textbox", { name: "Händlername" })).toBeNull();
  expect(reopened.getByText(original.description)).toBeTruthy();
  expect(reopened.getByLabelText<HTMLSelectElement>("Kategorie").value).toBe(before.transactions[0].category);
});

it.each([false, true])("does not create an alias when the name was not changed (pencil=%s)", async (clickPencil) => {
  const view = mount();
  const dialog = view.open();
  if (clickPencil) fireEvent.click(dialog.getByRole("button", { name: "Händlername bearbeiten" }));
  fireEvent.change(dialog.getByLabelText("Kategorie"), { target: { value: "Shopping" } });
  await confirm(dialog);
  expect(view.savedBooking().merchantAlias).toBeUndefined();
  expect(view.savedBooking().description).toBe(original.description);
  expect(view.read().state.merchantRules?.every((rule) => rule.merchantAlias === undefined)).toBe(true);
});

it("retains an existing alias during category-only changes and remembers a subsequent rename using the original key", async () => {
  const booking = { ...original, merchantAlias: "Hausverwaltung", fixedCost: true };
  const view = mount(booking);
  const first = view.open();
  expect(first.getByText("Hausverwaltung")).toBeTruthy();
  expect(first.getByText(original.description)).toBeTruthy();
  fireEvent.change(first.getByLabelText("Kategorie"), { target: { value: "Miete" } });
  await confirm(first);
  expect(view.savedBooking().merchantAlias).toBe("Hausverwaltung");
  const second = view.open();
  editName(second, "Wohnservice");
  fireEvent.change(second.getByLabelText("Kategorie"), { target: { value: "Shopping" } });
  fireEvent.click(second.getByRole("checkbox", { name: "Als Fixkosten markieren" }));
  await confirm(second);
  const third = view.open();
  const input = editName(third, "Wohnservice Neu");
  expect(input.value).toBe("Wohnservice Neu");
  await confirm(third);
  expect(view.savedBooking()).toMatchObject({
    ...original, merchantAlias: "Wohnservice Neu", category: "Shopping", fixedCost: false,
  });
  expect(statementFingerprint(view.savedBooking())).toBe(statementFingerprint(original));
  expect(view.read().state.merchantRules).toContainEqual({
    key: merchantAliasSourceKey(original), merchantAlias: "Wohnservice Neu", category: "Shopping", fixedCost: false,
  });
  expect(applyMerchantRules(view.read().state, [{ ...original, id: "future", date: "2026-10-01" }])[0])
    .toMatchObject({ merchantAlias: "Wohnservice Neu", category: "Shopping", fixedCost: false });
});

it.each(["PayPal", "POS 3,00 AT D1"])("renames only the selected booking for the generic source %s", async (description) => {
  const booking = { ...original, description, rawDescription: description, rawDetails: undefined };
  const view = mount(booking);
  const dialog = view.open();
  editName(dialog, "Hausverwaltung");
  fireEvent.change(dialog.getByLabelText("Kategorie"), { target: { value: "Miete" } });
  await confirm(dialog);
  expect(view.savedBooking().merchantAlias).toBe("Hausverwaltung");
  expect(merchantAliasSourceKey(booking)).toBeUndefined();
  expect(applyMerchantRules(view.read().state, [{ ...booking, id: "future", date: "2026-10-01" }])[0].merchantAlias)
    .toBeUndefined();
});
