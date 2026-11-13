// @vitest-environment jsdom
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { FinanceProvider, useFinance } from "./finance-provider";
import { Transactions } from "./transactions";
import { StatementImport } from "./statement-import";
import { Months } from "./months";
import { classify } from "@/lib/calc";
import { monthLabel } from "@/lib/format";
import { applyMerchantRules, merchantAliasSourceKey } from "@/lib/import/merchant-rules";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({
  Toaster: () => null,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T12:00:00"));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const booking: Transaction = {
  id: "fixed-plan-booking", bank: "Raiffeisen", pocket: "Raiffeisen Giro", date: "2026-10-02",
  description: "Nordlicht Laden", amount: -3, category: "Shopping", includeInPlan: true,
  categoryOverride: true, manualCategory: true, reviewed: true, fixedCost: false,
};

function fixture(patch: Partial<AppState> = {}): AppState {
  const seed = createSeed();
  return {
    ...seed, settings: { ...seed.settings, asOf: "2026-10-05" },
    transactions: [booking], financeRows: [], fixedReceipts: [], merchantRules: [], reviewQueue: [],
    plannedOneOffs: [], plannedOneOffsSeeded: true, holidayRanges: [],
    ...patch,
  };
}

function mount(initialState = fixture(), page: "ledger" | "review" | "months" = "ledger") {
  let current: ReturnType<typeof useFinance>;
  function Harness() {
    const finance = useFinance();
    const [reviewRequest, setReviewRequest] = useState(0);
    useEffect(() => { current = finance; }, [finance]);
    if (page === "months") return <Months />;
    return page === "review" ? <>
      <button onClick={() => setReviewRequest((value) => value + 1)}>Prüfung öffnen</button>
      <StatementImport reviewRequest={reviewRequest} />
    </> : <Transactions />;
  }
  const view = render(<FinanceProvider initialState={initialState}><Harness /></FinanceProvider>);
  return { ...view, read: () => current };
}

const fixedRows = (state: AppState) => state.financeRows.filter((row) => row.kind === "fixed");
const persisted = (): AppState => JSON.parse(localStorage.getItem("finanzdashboard.v1")!);
const untouchedPlan = (state: AppState) => ({
  settings: state.settings,
  variableRows: state.financeRows.filter((row) => row.kind === "variable"),
  months: state.months,
  plannedOneOffs: state.plannedOneOffs,
});

function expectFixedPlan(state: AppState, label: string) {
  const rows = fixedRows(state);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ label, kind: "fixed" });
  expect(rows[0].values).toEqual(Object.fromEntries([
    ...["2026-10", "2026-11", "2026-12"],
    ...Array.from({ length: 12 }, (_, index) => `2027-${String(index + 1).padStart(2, "0")}`),
  ].map((month) => [month, 3])));
  expect(rows[0].values["2026-09"]).toBeUndefined();
  return rows[0];
}

function openAssignment(name = booking.description) {
  fireEvent.click(screen.getByRole("button", { name: `Zuordnung ändern: ${name}` }));
  return within(screen.getByRole("dialog", { name: "Zuordnung ändern" }));
}

async function confirmAssignment(dialog: ReturnType<typeof within>) {
  fireEvent.click(dialog.getByRole("button", { name: "Zuordnung übernehmen" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Zuordnung ändern" })).toBeNull());
}

it("projects a confirmed October Shopping expense into fixed costs, persists it, and removes it after unmarking", async () => {
  const initial = fixture();
  const view = mount(initial);
  const before = view.read().state;
  const untouched = structuredClone(untouchedPlan(before));
  expect(fixedRows(before)).toEqual([]);
  const dialog = openAssignment();
  fireEvent.click(dialog.getByRole("button", { name: "Händlername bearbeiten" }));
  fireEvent.change(dialog.getByRole("textbox", { name: "Händlername" }), { target: { value: "Nordlicht Service" } });
  fireEvent.click(dialog.getByRole("checkbox", { name: "Als Fixkosten markieren" }));
  expect(view.read().state).toBe(before);
  expect(fixedRows(view.read().state)).toEqual([]);
  await confirmAssignment(dialog);
  expect(view.read().state.transactions[0]).toMatchObject({
    ...booking, merchantAlias: "Nordlicht Service", fixedCost: true, includeInPlan: false,
  });
  const fixed = expectFixedPlan(view.read().state, "Nordlicht Service");
  expect(untouchedPlan(view.read().state)).toEqual(untouched);
  await waitFor(() => expect(fixedRows(persisted())).toEqual([fixed]));
  view.unmount();

  const reloaded = mount(initial);
  expectFixedPlan(reloaded.read().state, "Nordlicht Service");
  expect(fixedRows(reloaded.read().state)[0].id).toBe(fixed.id);
  const unmark = openAssignment("Nordlicht Service");
  expect(unmark.getByRole<HTMLInputElement>("checkbox", { name: "Als Fixkosten markieren" }).checked).toBe(true);
  fireEvent.click(unmark.getByRole("checkbox", { name: "Als Fixkosten markieren" }));
  expect(fixedRows(reloaded.read().state)).toEqual([fixed]);
  await confirmAssignment(unmark);
  expect(reloaded.read().state.transactions[0]).toMatchObject({
    merchantAlias: "Nordlicht Service", category: "Shopping", fixedCost: false, includeInPlan: true,
  });
  expect(fixedRows(reloaded.read().state)).toEqual([]);
  expect(untouchedPlan(reloaded.read().state)).toEqual(untouched);
  await waitFor(() => expect(fixedRows(persisted())).toEqual([]));
  reloaded.unmount();
  const unmarkedReload = mount(initial);
  expect(unmarkedReload.read().state.transactions[0].fixedCost).toBe(false);
  expect(fixedRows(unmarkedReload.read().state)).toEqual([]);
});

it("removes a generated fixed row when its booking is deleted and restores it through the toast undo action", async () => {
  const marked = { ...booking, fixedCost: true, includeInPlan: false };
  const view = mount(fixture({ transactions: [marked] }));
  const untouched = structuredClone(untouchedPlan(view.read().state));
  expect(fixedRows(view.read().state)).toHaveLength(1);
  const originalFixed = fixedRows(view.read().state)[0];
  const actions = screen.getByRole("button", { name: `Weitere Aktionen: ${booking.description}` });
  fireEvent.click(actions);
  fireEvent.click(await screen.findByRole("button", { name: `Löschen: ${booking.description}` }));
  const dialog = within(screen.getByRole("dialog", { name: "Umsatz löschen?" }));
  expect(view.read().state.transactions).toHaveLength(1);
  fireEvent.click(dialog.getByRole("button", { name: "Endgültig löschen" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Umsatz löschen?" })).toBeNull());
  expect(view.read().state.transactions).toEqual([]);
  expect(fixedRows(view.read().state)).toEqual([]);
  expect(untouchedPlan(view.read().state)).toEqual(untouched);
  const undo = vi.mocked(toast).mock.calls.find(([message]) => message === "Umsatz gelöscht")?.[1]?.action;
  expect(undo).toMatchObject({ label: "Rückgängig", onClick: expect.any(Function) });
  if (!undo || typeof undo !== "object" || !("onClick" in undo)) throw new Error("Undo action missing");
  act(() => undo.onClick({} as MouseEvent<HTMLButtonElement>));
  expect(view.read().state.transactions).toEqual([marked]);
  const restored = expectFixedPlan(view.read().state, classify(marked).merchant);
  expect(restored).toEqual(originalFixed);
  expect(untouchedPlan(view.read().state)).toEqual(untouched);
  await waitFor(() => expect(fixedRows(persisted())).toEqual([restored]));
});

it.each([false, true])("projects the existing import-review fixed checkbox through appendStatements (stored=%s)", async (stored) => {
  const draft: Transaction = {
    ...booking, category: "Prüfen", categoryOverride: undefined, manualCategory: undefined, reviewed: undefined,
  };
  const initial = fixture({
    transactions: stored ? [draft] : [],
    reviewQueue: [{ kind: "booking", id: draft.id, draft, message: "Kategorie noch offen." }],
  });
  const view = mount(initial, "review");
  const before = view.read().state;
  const untouched = structuredClone(untouchedPlan(before));
  fireEvent.click(screen.getByRole("button", { name: "Prüfung öffnen" }));
  const review = within(screen.getByRole("region", { name: `Buchung prüfen: ${draft.description}` }));
  fireEvent.change(review.getByLabelText("Kategorie"), { target: { value: "Shopping" } });
  fireEvent.click(review.getByRole("checkbox", { name: "Als Fixkosten markieren" }));
  expect(view.read().state).toBe(before);
  expect(fixedRows(view.read().state)).toEqual([]);
  fireEvent.click(review.getByRole("button", { name: "Zuordnung übernehmen" }));
  await waitFor(() => {
    expect(view.read().statementImport).toBeDefined();
    expect(view.read().statementImport?.error).toBeUndefined();
    expect(view.read().openReviewCount).toBe(0);
  });
  expect(view.read().state.transactions).toHaveLength(1);
  expect(view.read().state.transactions[0]).toMatchObject({
    ...booking, category: "Shopping", fixedCost: true, reviewed: true, includeInPlan: false,
  });
  const fixed = expectFixedPlan(view.read().state, classify(view.read().state.transactions[0]).merchant);
  expect(untouchedPlan(view.read().state)).toEqual(untouched);
  await waitFor(() => expect(fixedRows(persisted())).toEqual([fixed]));
  view.unmount();
  const reloaded = mount(initial, "review");
  expect(fixedRows(reloaded.read().state)).toEqual([fixed]);
  expect(reloaded.read().openReviewCount).toBe(0);
});

const monthlyBooking: Transaction = {
  ...booking, merchantAlias: "Nordlicht Service", fixedCost: true, includeInPlan: false,
};
const monthlyFixture = () => fixture({ transactions: [monthlyBooking] });

function expectUnmarkedSource(state: AppState) {
  expect(state.transactions).toHaveLength(1);
  expect(state.transactions[0]).toMatchObject({
    id: booking.id, description: booking.description, amount: booking.amount,
    merchantAlias: monthlyBooking.merchantAlias, category: "Shopping", fixedCost: false,
  });
  expect(state.merchantRules).toContainEqual({
    key: merchantAliasSourceKey(booking), merchantAlias: monthlyBooking.merchantAlias,
    category: "Shopping", fixedCost: false,
  });
  const future: Transaction = {
    ...booking, id: "future-monthly-booking", date: "2026-11-02",
    fixedCost: undefined, reviewed: undefined, manualCategory: undefined, categoryOverride: undefined,
  };
  expect(applyMerchantRules(state, [future])[0]).toMatchObject({
    merchantAlias: monthlyBooking.merchantAlias, category: "Shopping", fixedCost: false,
  });
}

async function savePosition(dialog: ReturnType<typeof within>) {
  fireEvent.click(dialog.getByRole("button", { name: "Position speichern" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Position bearbeiten" })).toBeNull());
}

it("shows the generated row in Months and deletes its fixed linkage without deleting the booking", async () => {
  const initial = monthlyFixture();
  const view = mount(initial, "months");
  const before = view.read().state;
  const untouched = structuredClone(untouchedPlan(before));
  const row = expectFixedPlan(before, "Nordlicht Service");
  const table = within(screen.getByRole("table"));
  expect(table.getByText(row.label)).toBeTruthy();
  expect(table.getByLabelText(`${row.label} ${monthLabel("2026-10")}`).textContent).toBe("3,00");
  expect(table.queryByRole("button", { name: `${row.label} löschen` })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Plan bearbeiten" }));
  fireEvent.click(table.getByRole("button", { name: `${row.label} löschen` }));
  const dialog = within(screen.getByRole("dialog", { name: "Position löschen?" }));
  expect(view.read().state).toBe(before);
  fireEvent.click(dialog.getByRole("button", { name: "Position löschen" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Position löschen?" })).toBeNull());
  expect(fixedRows(view.read().state)).toEqual([]);
  expect(table.queryByText(row.label)).toBeNull();
  expectUnmarkedSource(view.read().state);
  expect(untouchedPlan(view.read().state)).toEqual(untouched);
  await waitFor(() => {
    expect(fixedRows(persisted())).toEqual([]);
    expect(persisted().transactions[0].fixedCost).toBe(false);
  });
  view.unmount();
  const reloaded = mount(initial, "months");
  expect(fixedRows(reloaded.read().state)).toEqual([]);
  expectUnmarkedSource(reloaded.read().state);
});

it("preserves a generated Months row's manual label and cell value across synchronization and reload", async () => {
  const initial = monthlyFixture();
  const view = mount(initial, "months");
  const before = view.read().state;
  const untouched = structuredClone(untouchedPlan(before));
  const originalRow = expectFixedPlan(before, "Nordlicht Service");
  fireEvent.click(screen.getByRole("button", { name: "Plan bearbeiten" }));
  fireEvent.click(screen.getByRole("button", { name: `${originalRow.label} bearbeiten` }));
  const dialog = within(screen.getByRole("dialog", { name: "Position bearbeiten" }));
  fireEvent.change(dialog.getByLabelText("Bezeichnung"), { target: { value: "Meine fixe Ausgabe" } });
  expect(view.read().state).toBe(before);
  await savePosition(dialog);
  expect(fixedRows(view.read().state)[0]).toMatchObject({ id: originalRow.id, label: "Meine fixe Ausgabe" });
  const october = screen.getByRole<HTMLInputElement>("textbox", { name: `Meine fixe Ausgabe ${monthLabel("2026-10")}` });
  fireEvent.change(october, { target: { value: "7,50" } });
  expect(fixedRows(view.read().state)[0].values["2026-10"]).toBe(3);
  fireEvent.blur(october);
  const edited = fixedRows(view.read().state)[0];
  expect(edited).toMatchObject({
    id: originalRow.id, label: "Meine fixe Ausgabe",
    values: { "2026-10": 7.5, "2026-11": 3 },
    fixedSource: { appliedLabel: "Meine fixe Ausgabe", labelOverride: "Meine fixe Ausgabe",
      applied: { "2026-10": 7.5 }, overrides: { "2026-10": 7.5 } },
  });
  expect(view.read().state.transactions[0]).toEqual(monthlyBooking);
  expect(untouchedPlan(view.read().state)).toEqual(untouched);
  await waitFor(() => expect(fixedRows(persisted())).toEqual([edited]));
  view.unmount();
  const reloaded = mount(initial, "months");
  expect(fixedRows(reloaded.read().state)).toEqual([edited]);
  const table = within(screen.getByRole("table"));
  expect(table.getByText("Meine fixe Ausgabe")).toBeTruthy();
  expect(table.getByLabelText(`Meine fixe Ausgabe ${monthLabel("2026-10")}`).textContent).toBe("7,50");
  expect(table.getByLabelText(`Meine fixe Ausgabe ${monthLabel("2026-11")}`).textContent).toBe("3,00");
});

it("detaches a generated Months row when RowEditor moves it to income and unmarks its source", async () => {
  const initial = monthlyFixture();
  const view = mount(initial, "months");
  const before = view.read().state;
  const untouched = structuredClone(untouchedPlan(before));
  const originalRow = expectFixedPlan(before, "Nordlicht Service");
  fireEvent.click(screen.getByRole("button", { name: "Plan bearbeiten" }));
  fireEvent.click(screen.getByRole("button", { name: `${originalRow.label} bearbeiten` }));
  const dialog = within(screen.getByRole("dialog", { name: "Position bearbeiten" }));
  fireEvent.change(dialog.getByLabelText("Bereich"), { target: { value: "income" } });
  expect(view.read().state).toBe(before);
  await savePosition(dialog);
  const detached = view.read().state.financeRows.find((row) => row.id === originalRow.id)!;
  expect(detached).toMatchObject({ kind: "income", label: originalRow.label, values: originalRow.values });
  expect(detached.fixedSource).toBeUndefined();
  expect(fixedRows(view.read().state)).toEqual([]);
  expectUnmarkedSource(view.read().state);
  expect(untouchedPlan(view.read().state)).toEqual(untouched);
  expect(within(screen.getByRole("table")).getByText(originalRow.label)).toBeTruthy();
  await waitFor(() => expect(persisted().financeRows.find((row) => row.id === originalRow.id)).toEqual(detached));
  view.unmount();
  const reloaded = mount(initial, "months");
  expect(reloaded.read().state.financeRows.find((row) => row.id === originalRow.id)).toEqual(detached);
  expect(fixedRows(reloaded.read().state)).toEqual([]);
  expectUnmarkedSource(reloaded.read().state);
});
