// @vitest-environment jsdom
import { useState, type Dispatch, type SetStateAction } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFinance } from "@/components/finance-provider";
import { StatementImport } from "@/components/statement-import";
import { SharedCosts } from "@/components/shared-costs";
import * as calc from "@/lib/calc";
import { commitStatementImport, queueLedgerReview } from "@/lib/import/review";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

type Finance = ReturnType<typeof useFinance>;
type Store = { state: AppState; result: Finance["statementImport"] };
const row = (id: string): Transaction => ({
  id, description: `Unbekannter Einkauf ${id}`, date: "2026-09-05", amount: -100,
  bank: "Revolut", pocket: null, category: "Prüfen", includeInPlan: false,
});
function fixture() {
  const state = createSeed();
  state.transactions = [row("first"), row("second")];
  state.financeRows = [];
  state.settings.asOf = "2026-09-16";
  return queueLedgerReview(state);
}
function model(state: AppState, appendStatements: Finance["appendStatements"], result?: Finance["statementImport"]): Finance {
  return { state, dashboard: calc.calculateDashboard(state), appendStatements, statementImport: result,
    ready: true, saved: true, storageError: null, openReviewCount: state.reviewQueue?.length ?? 0,
    update: vi.fn(), replace: vi.fn(), retrySave: vi.fn() };
}
function renderReview() {
  const initial = fixture();
  let latest: Store = { state: initial, result: undefined };
  let setStore: Dispatch<SetStateAction<Store>> = () => {};
  let fail = false;
  const append = vi.fn<Finance["appendStatements"]>((rows, duplicates, requestId, decisions, metadata) => {
    if (fail) {
      fail = false;
      setStore((store) => ({ ...store, result: { requestId, added: 0, duplicates, error: "Übernahme fehlgeschlagen" } }));
    } else {
      // Exercise real import/review logic against the state at execution time.
      setStore((store) => {
        const result = commitStatementImport(store.state, rows, decisions, metadata);
        return { state: queueLedgerReview(result.state), result: {
          requestId, added: result.added, duplicates: duplicates + result.duplicates, changes: result.changes,
        } };
      });
    }
  });
  function Harness({ request }: { request: number }) {
    const [store, update] = useState(latest);
    latest = store;
    setStore = update;
    vi.mocked(useFinance).mockReturnValue(model(store.state, append, store.result));
    return <StatementImport reviewRequest={request} />;
  }
  const view = render(<Harness request={0} />);
  view.rerender(<Harness request={1} />);
  return { append, read: () => latest.state, failNext: () => { fail = true; },
    change: (updater: (state: AppState) => AppState) => act(() => setStore((store) => ({ ...store, state: updater(store.state) }))) };
}
function chooseFirst() {
  const section = screen.getByLabelText("Buchung prüfen: Unbekannter Einkauf first");
  fireEvent.change(within(section).getByLabelText("Kategorie"), { target: { value: "Freizeit" } });
  return within(section).getByRole<HTMLButtonElement>("button", { name: "Zuordnung übernehmen" });
}

describe("responsive review actions", () => {
  it("shows progress before processing, blocks duplicate clicks and uses the latest ledger", () => {
    const view = renderReview();
    const button = chooseFirst();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(view.append).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Zuordnung wird übernommen");
    expect(button.disabled).toBe(true);
    expect(view.read().transactions[0].category).toBe("Prüfen");
    const concurrent = { ...row("concurrent"), category: "Lebensmittel" as const, categoryOverride: true };
    view.change((state) => ({ ...state, transactions: [...state.transactions, concurrent] }));
    act(() => { vi.advanceTimersByTime(1); });
    expect(view.append).toHaveBeenCalledTimes(1);
    expect(view.read().transactions).toHaveLength(3);
    expect(view.read().transactions[0]).toMatchObject({ ...row("first"), category: "Freizeit", categoryOverride: true, includeInPlan: true });
    expect(view.read().transactions[2]).toEqual(concurrent);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByLabelText("Buchung prüfen: Unbekannter Einkauf first")).toBeNull();
    expect(screen.getByLabelText("Buchung prüfen: Unbekannter Einkauf second")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Später prüfen" }).disabled).toBe(false);
  });

  it("keeps the selection after failure and permits one safe retry", () => {
    const view = renderReview();
    const before = JSON.stringify(view.read());
    view.failNext();
    fireEvent.click(chooseFirst());
    act(() => { vi.advanceTimersByTime(1); });
    expect(JSON.stringify(view.read())).toBe(before);
    expect(screen.queryByRole("status")).toBeNull();
    const section = screen.getByLabelText("Buchung prüfen: Unbekannter Einkauf first");
    expect(within(section).getByLabelText<HTMLSelectElement>("Kategorie").value).toBe("Freizeit");
    const button = within(section).getByRole<HTMLButtonElement>("button", { name: "Zuordnung übernehmen" });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    act(() => { vi.advanceTimersByTime(1); });
    expect(view.append).toHaveBeenCalledTimes(2);
    expect(view.read().transactions).toHaveLength(2);
    expect(view.read().transactions[0].category).toBe("Freizeit");
    expect(view.read().transactions[0].amount).toBe(-100);
  });

  it("does not scan sharing candidates while closed or reclassify them on selection/filter changes", () => {
    const bookings = Array.from({ length: 60 }, (_, i) => ({ ...row(String(i)), category: "Freizeit" as const, categoryOverride: true }));
    vi.mocked(useFinance).mockReturnValue(model(fixture(), vi.fn()));
    const classify = vi.spyOn(calc, "classify");
    render(<SharedCosts bookings={bookings} items={[]} />);
    expect(classify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Geteilt" }));
    expect(classify).toHaveBeenCalledTimes(bookings.length);
    classify.mockClear();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.change(screen.getByLabelText("Geteilte Buchungen suchen"), { target: { value: "Einkauf" } });
    expect(classify).not.toHaveBeenCalled();
  });
});
