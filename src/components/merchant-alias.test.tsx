// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { StatementImport } from "./statement-import";
import { createSeed } from "@/lib/seed";
import { prepareStatementImport } from "@/lib/import/review";
import { statementFingerprint } from "@/lib/import/identity";
import { cleanBookingText } from "@/lib/import/bank-description";
import { bookingDescription } from "@/lib/import/merchant-description";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const original: Transaction = {
  id: "unknown", bank: "Raiffeisen", pocket: "Raiffeisen Giro", date: "2026-09-01",
  description: "Sonstiges IBAN Empfaenger: AT000000000000000001 BIC Empfaenger: TESTATXX Empfaenger: Musterstrasse 15 9020 Klagenfurt",
  amount: -3, category: "Sonstiges", includeInPlan: true,
};
function mount(stored = true) {
  const state: AppState = {
    ...createSeed(), transactions: stored ? [original] : [], financeRows: [], merchantRules: [], fixedReceipts: [],
    reviewQueue: [{ kind: "booking", id: original.id, draft: original, message: "Händler noch nicht sicher zugeordnet." }],
  };
  let current: ReturnType<typeof useFinance>;
  function Harness() {
    const finance = useFinance();
    const [request, setRequest] = useState(0);
    useEffect(() => { current = finance; }, [finance]);
    return <><button onClick={() => setRequest((value) => value + 1)}>Prüfung öffnen</button>
      <StatementImport reviewRequest={request} /></>;
  }
  const view = render(<FinanceProvider initialState={state}><Harness /></FinanceProvider>);
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: "Prüfung öffnen" }));
    return within(screen.getByRole("region", { name: `Buchung prüfen: ${bookingDescription(original)}` }));
  };
  return { ...view, read: () => current, open };
}
const persisted = (): AppState => JSON.parse(localStorage.getItem("finanzdashboard.v1")!);

it.each([false, true])("saves a pencil-edited name and learns future imports via the real provider (stored=%s)", async (stored) => {
  const view = mount(stored);
  const section = view.open();
  const name = section.getByLabelText<HTMLInputElement>("Text");
  expect(name.readOnly).toBe(true);
  fireEvent.click(section.getByRole("button", { name: "Händlername bearbeiten" }));
  expect(name.readOnly).toBe(false);
  expect(document.activeElement).toBe(name);
  fireEvent.change(name, { target: { value: "  Hausverwaltung  " } });
  fireEvent.change(section.getByLabelText("Kategorie"), { target: { value: "Miete" } });
  fireEvent.click(section.getByRole("checkbox", { name: "Als Fixkosten markieren" }));
  expect(view.read().state.merchantRules).toEqual([]);
  expect(view.read().state.transactions[0]?.merchantAlias).toBeUndefined();
  expect(section.getByLabelText<HTMLInputElement>("Datum").readOnly).toBe(true);
  expect(section.getByLabelText<HTMLInputElement>("Betrag").readOnly).toBe(true);
  fireEvent.click(section.getByRole("button", { name: "Zuordnung übernehmen" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(view.read().state.transactions[0]).toMatchObject({
    ...original, description: "Sonstiges Empfaenger: Musterstrasse 15 9020 Klagenfurt", rawDescription: original.description,
    merchantAlias: "Hausverwaltung", category: "Miete", manualCategory: true, reviewed: true,
    categoryOverride: true, fixedCost: true, includeInPlan: false,
  });
  expect(statementFingerprint(view.read().state.transactions[0])).toBe(statementFingerprint(original));
  await waitFor(() => expect(persisted().transactions[0]?.merchantAlias).toBe("Hausverwaltung"));
  const rules = view.read().state.merchantRules;
  view.unmount();
  const loaded = mount(stored);
  expect(loaded.read().state.merchantRules).toEqual(rules);
  const future = { ...original, id: "future", date: "2026-10-01", amount: -5 };
  const prepared = prepareStatementImport([{
    file: "synthetic.csv", source: "Raiffeisen", rows: [future], issues: [], skipped: 0,
  }], loaded.read().state);
  expect(prepared.review).toEqual([]);
  expect(prepared.automatic[0]).toMatchObject({ merchantAlias: "Hausverwaltung", category: "Miete", fixedCost: true });
  act(() => loaded.read().appendStatements(prepared.automatic, prepared.duplicates, "future-import", [], prepared.metadata));
  expect(loaded.read().state.transactions).toHaveLength(2);
  expect(loaded.read().state.transactions[1]).toMatchObject({
    ...future, description: "Sonstiges Empfaenger: Musterstrasse 15 9020 Klagenfurt", rawDescription: future.description,
    merchantAlias: "Hausverwaltung", category: "Miete", fixedCost: true, includeInPlan: false, categoryOverride: true,
  });
});

it("offers a contract only for reviews of booked expenses and opens the contract assistant", async () => {
  const booked = mount(true).open();
  fireEvent.click(booked.getByRole("button", { name: "Als Vertrag anlegen" }));
  expect(await screen.findByRole("dialog", { name: "Als Vertrag anlegen" }, { timeout: 5000 })).toBeTruthy();
  cleanup();
  localStorage.clear();
  const imported = mount(false).open();
  expect(imported.queryByRole("button", { name: "Als Vertrag anlegen" })).toBeNull();
});

it("rejects blank names and discards an unconfirmed rename on skip", () => {
  const view = mount();
  const section = view.open();
  const before = view.read().state;
  fireEvent.click(section.getByRole("button", { name: "Händlername bearbeiten" }));
  fireEvent.change(section.getByLabelText("Text"), { target: { value: "   " } });
  fireEvent.change(section.getByLabelText("Kategorie"), { target: { value: "Shopping" } });
  expect(section.getByRole<HTMLButtonElement>("button", { name: "Zuordnung übernehmen" }).disabled).toBe(true);
  expect(section.getByText("Bitte einen Händlernamen eingeben.")).toBeTruthy();
  fireEvent.change(section.getByLabelText("Text"), { target: { value: "Neuer Name" } });
  expect(section.getByRole<HTMLButtonElement>("button", { name: "Zuordnung übernehmen" }).disabled).toBe(false);
  fireEvent.click(section.getByRole("button", { name: "Später prüfen" }));
  expect(view.read().state).toBe(before);
  expect(view.open().getByLabelText<HTMLInputElement>("Text").value).toBe(cleanBookingText(original.description));
});
