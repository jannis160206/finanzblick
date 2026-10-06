// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "@/components/finance-provider";
import { FixedCostSchedule } from "./fixed-cost-schedule";
import { createSeed } from "@/lib/seed";
import { currency } from "@/lib/format";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T12:00:00"));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

const phone: Transaction = {
  id: "phone-sep", bank: "Raiffeisen", pocket: "Giro", date: "2026-09-15",
  description: "A1 Mobilfunk", amount: -20, category: "Telefon & Internet",
  includeInPlan: false, categoryOverride: true, manualCategory: true, reviewed: true,
};
function fixture(): AppState {
  const seed = createSeed();
  return {
    ...seed, settings: { ...seed.settings, asOf: "2026-10-06" },
    transactions: [phone, { ...phone, id: "insurance", date: "2026-10-02",
      description: "Allianz", amount: -65, category: "Versicherungen" }],
    financeRows: [
      { id: "phone", label: "Handyvertrag A1", kind: "fixed", planCategory: "Telefon & Internet",
        values: { "2026-10": 20, "2026-11": 20 } },
      { id: "insurance", label: "Haftpflicht", kind: "fixed", planCategory: "Versicherungen",
        values: { "2026-10": 65, "2026-11": 65 } },
      { id: "unknown", label: "Künftiger Vertrag", kind: "fixed", values: { "2026-10": 5 } },
    ],
    plannedOneOffs: [], plannedOneOffsSeeded: true, fixedReceipts: [], savingsGoals: [], holidayRanges: [],
  };
}
function mount(initialState = fixture()) {
  let latest: ReturnType<typeof useFinance>;
  function Harness() {
    const finance = useFinance();
    useEffect(() => { latest = finance; }, [finance]);
    return <FixedCostSchedule />;
  }
  const view = render(<FinanceProvider initialState={initialState}><Harness /></FinanceProvider>);
  return { ...view, read: () => latest };
}

it("shows outstanding dates, amounts and unknown timing separately from the collapsed booked list", () => {
  mount();
  const section = screen.getByRole("region", { name: "Fixkosten diesen Monat" });
  const open = within(section).getByRole("list", { name: "Offene Fixkosten" });
  expect(within(section).getByRole("heading", { name: "Fixkosten · Oktober 2026" })).toBeTruthy();
  expect(within(section).getByText("Stand 6.10.2026")).toBeTruthy();
  expect(open.textContent).toContain("Handyvertrag A1");
  expect(open.textContent).toContain("ca. 15.10.2026");
  expect(open.textContent).toContain("Raiffeisen · Girokonto");
  expect(open.textContent).toContain("Termin unbekannt");
  expect(open.textContent).not.toContain("Haftpflicht");
  expect(within(section).getByText("Noch offen").textContent).toContain(currency(25));
  const summary = within(section).getByText(/^Bereits abgebucht \(1\)/);
  expect(summary.textContent).toContain(currency(65));
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  expect(within(details).getByRole("list", { name: "Abgebuchte Fixkosten" }).textContent).toContain("2.10.2026");
  expect(within(section).getByRole("link", { name: "Monatsplan" }).getAttribute("href")).toBe("/monate");
});

it("updates immediately after importing or deleting a booking, survives reload and never changes the budget", () => {
  const view = mount();
  const before = view.read().state;
  const surplus = view.read().dashboard.current.surplus;
  act(() => view.read().appendStatements([{ ...phone, id: "phone-oct", date: "2026-10-05" }], 0, "schedule-import"));
  const open = screen.getByRole("list", { name: "Offene Fixkosten" });
  expect(open.textContent).not.toContain("Handyvertrag A1");
  expect(screen.getByText("Noch offen").textContent).toContain(currency(5));
  expect(view.read().state.financeRows).toEqual(before.financeRows);
  expect(view.read().dashboard.current.surplus).toBe(surplus);
  expect(view.read().saved).toBe(true);
  const savedBookings = structuredClone(view.read().state.transactions);
  view.unmount();
  const reloaded = mount();
  expect(screen.getByRole("list", { name: "Offene Fixkosten" }).textContent).not.toContain("Handyvertrag A1");
  expect(reloaded.read().state.transactions).toEqual(savedBookings);
  act(() => reloaded.read().update((state) => ({
    ...state, transactions: state.transactions.filter((row) => row.id !== "phone-oct"),
    fixedReceipts: state.fixedReceipts?.filter((receipt) => receipt.booking?.id !== "phone-oct"),
  })));
  expect(screen.getByRole("list", { name: "Offene Fixkosten" }).textContent).toContain("Handyvertrag A1");
  expect(screen.getByText("Noch offen").textContent).toContain(currency(25));
});

it("rolls the schedule to the new as-of month and distinguishes expected today from unconfirmed old dates", () => {
  const initial = fixture();
  initial.transactions[0].date = "2026-09-06";
  const view = mount(initial);
  expect(screen.getByText("Heute erwartet")).toBeTruthy();
  act(() => view.read().update((state) => ({ ...state, settings: { ...state.settings, asOf: "2026-10-07" } })));
  expect(screen.getByText("Noch nicht bestätigt")).toBeTruthy();
  act(() => view.read().update((state) => ({ ...state, settings: { ...state.settings, asOf: "2026-11-01" } })));
  expect(screen.getByRole("heading", { name: "Fixkosten · November 2026" })).toBeTruthy();
  expect(screen.getByRole("list", { name: "Offene Fixkosten" }).textContent).toContain("Haftpflicht");
  expect(screen.getByText("Noch offen").textContent).toContain(currency(85));
});

it("shows only the still missing part of a category-wide fixed budget, with the remaining contract's expected date", () => {
  const initial = fixture();
  initial.financeRows = [{ id: "all-insurance", label: "Versicherungen", kind: "fixed",
    planCategory: "Versicherungen", values: { "2026-10": 115 } }];
  initial.transactions = [
    { ...phone, id: "allianz-sep", description: "Allianz", category: "Versicherungen", date: "2026-09-02", amount: -65 },
    { ...phone, id: "kasko-sep", description: "Vollkasko", category: "Versicherungen", date: "2026-09-15", amount: -50 },
    { ...phone, id: "allianz-oct", description: "Allianz", category: "Versicherungen", date: "2026-10-02", amount: -65 },
  ];
  mount(initial);
  const open = screen.getByRole("list", { name: "Offene Fixkosten" });
  expect(open.textContent).toContain("ca. 15.10.2026");
  expect(open.textContent).toContain(`${currency(65)} bereits abgebucht`);
  expect(open.textContent).toContain(currency(50));
  expect(screen.getByText("Noch offen").textContent).toContain(currency(50));
});

it("shows all-booked and empty states without inventing new fixed rows or payment controls", () => {
  const initial = fixture();
  initial.transactions.push({ ...phone, id: "phone-oct", date: "2026-10-05" });
  initial.financeRows = initial.financeRows.filter((row) => row.id !== "unknown");
  const view = mount(initial);
  expect(screen.getByText("Alle Fixkosten dieses Monats sind abgebucht.")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Offene Fixkosten" })).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  act(() => view.read().update((state) => ({ ...state, financeRows: state.financeRows.filter((row) => row.kind !== "fixed") })));
  expect(screen.queryByRole("region", { name: "Fixkosten diesen Monat" })).toBeNull();
});
