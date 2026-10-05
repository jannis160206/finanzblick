// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { toast } from "sonner";
import { Months } from "./months";
import { createSeed } from "@/lib/seed";
import { currency, number } from "@/lib/format";
import { parseAmexScreenshotLines, type ScreenshotLine } from "@/lib/import/amex-screenshot";
import { prepareStatementImport } from "@/lib/import/review";
import { amexBookingKey } from "@/lib/import/identity";
import type { AppState } from "@/lib/types";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T12:00:00"));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(): AppState {
  const state = createSeed();
  return {
    ...state, settings: { ...state.settings, asOf: "2026-10-05" },
    savingsGoals: [], plannedOneOffs: [], plannedOneOffsSeeded: true,
    financeRows: [{ id: "income", label: "Gehalt", kind: "income", values: { "2026-10": 3000 } }],
    transactions: [{
      id: "card", bank: "Amex", pocket: "Amex", date: "2026-09-25",
      description: "Amazon Bestellung", amount: -500, category: "Shopping", includeInPlan: false, reviewed: true,
    }],
    accountSnapshots: [{ bank: "Revolut", name: "Amex", date: "2026-09-30", balance: 125 }],
  };
}
function mount(initialState = fixture()) {
  let latest: ReturnType<typeof useFinance>;
  function Harness() {
    const finance = useFinance();
    useEffect(() => { latest = finance; }, [finance]);
    return <Months />;
  }
  const view = render(<FinanceProvider initialState={initialState}><Harness /></FinanceProvider>);
  return { ...view, read: () => latest };
}

function monthCell(label: string, month: number) {
  return within(screen.getByRole("row", { name: new RegExp(`^${label} `) })).getAllByRole("cell")[month - 1];
}

it("shows the automatic gap inside variable costs and updates surplus after reserve transfers and reload", () => {
  const view = mount();
  const initial = view.read().state;
  const budgets = initial.financeRows.filter((row) => row.kind === "variable");
  const row = screen.getByRole("row", { name: /^Amex offen / });
  expect(within(row).getByText("Amex offen").getAttribute("title")).toContain(`Rücklage ${currency(125)}`);
  const rows = screen.getAllByRole("row");
  expect(rows.indexOf(row)).toBeGreaterThan(rows.indexOf(screen.getByRole("row", { name: "Variable Ausgaben" })));
  expect(rows.indexOf(row)).toBeLessThan(rows.indexOf(screen.getByRole("row", { name: /^Variabel gesamt / })));
  expect(within(row).queryByRole("button")).toBeNull();
  expect(within(row).queryByRole("textbox")).toBeNull();
  expect(monthCell("Amex offen", 10).textContent).toBe(number(375));
  expect(monthCell("Amex offen", 11).textContent).toBe(number(0));
  expect(monthCell("Variabel gesamt", 10).textContent).toBe(number(view.read().dashboard.current.variablePlan));
  const before = view.read().dashboard.current.surplus;
  expect(monthCell("Überschuss", 10).textContent).toBe(number(before));
  act(() => view.read().update((state) => ({
    ...state, transactions: [...state.transactions, {
      id: "reserve", bank: "Revolut", pocket: "AMEX", date: "2026-10-01",
      description: "Um EUR Amex einzustecken", amount: 200, category: "Transfer intern", includeInPlan: false,
    }],
  })));
  expect(monthCell("Amex offen", 10).textContent).toBe(number(175));
  expect(monthCell("Überschuss", 10).textContent).toBe(number(before + 200));
  expect(view.read().state.financeRows.filter((item) => item.kind === "variable")).toEqual(budgets);
  expect(view.read().state.transactions[0]).toEqual(initial.transactions[0]);
  expect(view.read().saved).toBe(true);
  view.unmount();
  const restored = mount();
  expect(monthCell("Amex offen", 10).textContent).toBe(number(175));
  act(() => restored.read().update((state) => ({ ...state, transactions: state.transactions.filter((item) => item.id !== "card") })));
  expect(monthCell("Amex offen", 10).textContent).toBe(number(0));
});

it("replaces the historical total with the screenshot balance on a duplicate-only import and persists the exact remaining gap", () => {
  const initial = fixture();
  initial.transactions[0].date = "2026-08-01";
  initial.transactions[0].amount = -7650.34;
  initial.transactions.push(...[
    { id: "ikea", description: "IKEA KLAGENFURT", amount: -207.82 },
    { id: "airbnb", description: "AIRBNB LONDON", amount: -126 },
    { id: "tapeso", description: "MOLLIE TAPESO", amount: -164.9 },
  ].map((row) => ({ ...initial.transactions[0], ...row, date: "2026-10-02", sharedWithRaphael: true })));
  initial.accountSnapshots = [{ bank: "Revolut", name: "Amex Rückzahlung", date: "2026-10-04", balance: 954 }];
  const view = mount(initial);
  const before = structuredClone(view.read().state.transactions);
  const line = (text: string, y: number, x = 30): ScreenshotLine =>
    ({ text, confidence: 95, bbox: { x0: x, x1: x + 160, y0: y, y1: y + 20 } });
  const result = parseAmexScreenshotLines([
    line("11.09.2026 - Aktuell", 50), line("Kartennummer -12345", 80),
    line("€ 1.619,19", 120), line("45 Transaktionen", 160),
    ...initial.transactions.slice(1).flatMap((row, index) => [
      line(row.description, 240 + index * 100), line("2 Okt 2026", 270 + index * 100),
      line(`€ ${(-row.amount).toFixed(2).replace(".", ",")}`, 255 + index * 100, 500),
    ]),
  ], "WhatsApp Image 2026-10-05 at 09.43.39.jpeg");
  const prepared = prepareStatementImport([result], view.read().state);
  expect(prepared.automatic).toEqual([]);
  expect(prepared.duplicates).toBe(3);
  act(() => view.read().appendStatements([], prepared.duplicates, "capture-balance", [], prepared.metadata));
  expect(view.read().state.transactions).toEqual(before);
  expect(view.read().state.amexBalanceSnapshots).toEqual([{ periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 }]);
  expect(monthCell("Amex offen", 10).textContent).toBe(number(415.83));
  expect(monthCell("Amex offen", 11).textContent).toBe(number(0));
  expect(view.read().dashboard.amex).toMatchObject({ outstanding: 1619.19, ownOutstanding: 1369.83, reserved: 954 });
  expect(view.read().saved).toBe(true);
  view.unmount();
  const loaded = mount();
  expect(monthCell("Amex offen", 10).textContent).toBe(number(415.83));
  act(() => loaded.read().update((state) => ({ ...state, accountSnapshots: state.accountSnapshots!.map((row) =>
    row.name === "Amex Rückzahlung" ? { ...row, balance: 854 } : row) })));
  expect(monthCell("Amex offen", 10).textContent).toBe(number(515.83));
});

it("repairs an already saved legacy screenshot automatically, without a second import, lost edits or duplicate bookings", async () => {
  const initial = fixture();
  initial.transactions[0].date = "2026-08-01";
  initial.transactions[0].amount = -7650.34;
  initial.transactions.push(...[
    { id: "ikea", description: "IKEA KLAGENFURT", amount: -207.82 },
    { id: "airbnb", description: "AIRBNB LONDON", amount: -126 },
    { id: "tapeso", description: "MOLLIE TAPESO", amount: -164.9 },
  ].map((row) => ({ ...initial.transactions[0], ...row, date: "2026-10-02",
    rawDetails: ["Amex-Screenshot"], sharedWithRaphael: true })));
  initial.accountSnapshots = [{ bank: "Revolut", name: "Amex Rückzahlung (EUR)", date: "2026-10-04", balance: 954 }];
  localStorage.setItem("finanzdashboard.v1", JSON.stringify(initial));
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal("fetch", fetch);
  const view = mount();
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  act(() => view.read().update((state) => ({ ...state, transactions: state.transactions.map((row) =>
    row.id === "airbnb" ? { ...row, merchantAlias: "Unsere Unterkunft", manualCategory: true } : row) })));
  const before = structuredClone(view.read().state.transactions);
  await act(async () => resolve(Response.json({ recoveries: [{
    snapshot: { periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 },
    bookingKeys: initial.transactions.slice(1).map(amexBookingKey),
  }] })));
  await waitFor(() => expect(monthCell("Amex offen", 10).textContent).toBe(number(415.83)));
  expect(view.read().state.transactions).toEqual(before);
  expect(view.read().saved).toBe(true);
  expect(view.read().dashboard.amex).toMatchObject({ outstanding: 1619.19, ownOutstanding: 1369.83, reserved: 954 });
  view.unmount();
  const reloaded = mount();
  expect(monthCell("Amex offen", 10).textContent).toBe(number(415.83));
  expect(reloaded.read().state.transactions).toEqual(before);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  { status: 500, body: { error: "OCR failed" } },
  { status: 200, body: { recoveries: [{ snapshot: { balance: 100 }, bookingKeys: [] }] } },
  { status: 200, body: { recoveries: [] } },
])("surfaces an unavailable or unverifiable header without overwriting saved bookings: $status $body", async ({ status, body }) => {
  const initial = fixture();
  initial.transactions[0].rawDetails = ["Amex-Screenshot"];
  localStorage.setItem("finanzdashboard.v1", JSON.stringify(initial));
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
  const view = mount();
  const before = structuredClone(view.read().state.transactions);
  await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
  expect(view.read().state.transactions).toEqual(before);
  expect(view.read().state.amexBalanceSnapshots).toBeUndefined();
  expect(view.read().saved).toBe(true);
  expect(JSON.parse(localStorage.getItem("finanzdashboard.v1")!).transactions).toEqual(before);
});
