// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { StatementImport } from "./statement-import";
import { createSeed } from "@/lib/seed";
import { accountLabel } from "@/lib/accounts";
import { currency, dateLabel } from "@/lib/format";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T12:00:00"));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

const booking: Transaction = {
  id: "insurance", date: "2026-10-02", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
  description: "ALLIANZ ELEMENTAR Versicherungs AG Vertrag 4711", merchantAlias: "Meine Haftpflicht",
  category: "Versicherungen", categoryOverride: true, amount: -65, includeInPlan: false,
};
function fixture(): AppState {
  const seed = createSeed();
  return {
    ...seed, settings: { ...seed.settings, asOf: "2026-10-05" },
    transactions: [], fixedReceipts: [], savingsGoals: [], plannedOneOffs: [], plannedOneOffsSeeded: true,
    financeRows: [{ id: "insurance-plan", label: "Haftpflicht", kind: "fixed", planCategory: "Versicherungen",
      values: { "2026-09": 63.25, "2026-10": 63.25 } }],
    reviewQueue: [{ kind: "fixed", id: "insurance-change", change: {
      id: "insurance-change", category: "Versicherungen", month: "2026-10", previous: 63.25, amount: 65,
      rowId: "insurance-plan", bookings: [booking, { ...booking, id: "insurance-second", date: "2026-10-03", merchantAlias: undefined }],
    } }],
  };
}
function mount(initialState = fixture()) {
  let latest: ReturnType<typeof useFinance>;
  function Harness() {
    const value = useFinance();
    const [request, setRequest] = useState(0);
    useEffect(() => { latest = value; }, [value]);
    return <><button onClick={() => setRequest((current) => current + 1)}>Prüfung öffnen</button><StatementImport reviewRequest={request} /></>;
  }
  const view = render(<FinanceProvider initialState={initialState}><Harness /></FinanceProvider>);
  return { ...view, read: () => latest };
}

it.each([true, false])("shows each recognized booking before preserving the existing rate decision (accept: %s)", async (accept) => {
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: "Prüfung öffnen" }));
  const region = within(screen.getByRole("region", { name: "Versicherungen prüfen" }));
  const recognized = region.getAllByLabelText(`Erkannte Buchung: ${booking.description}`);
  expect(recognized).toHaveLength(2);
  expect(recognized[0].textContent).toContain("Meine Haftpflicht");
  expect(recognized[0].textContent).toContain(booking.description);
  expect(recognized[0].textContent).toContain(currency(-65));
  expect(recognized[0].textContent).toContain(dateLabel(booking.date));
  expect(recognized[0].textContent).toContain(accountLabel(booking));
  expect(recognized[1].textContent).toContain(dateLabel("2026-10-03"));
  expect(region.getByText(/bisher/).textContent).toContain(currency(63.25));
  fireEvent.click(region.getByRole("button", { name: accept ? "Neuen Dauerbetrag übernehmen" : "Bisherigen Dauerbetrag behalten" }));
  await waitFor(() => expect(view.read().openReviewCount).toBe(0));
  const plan = view.read().state.financeRows.find((row) => row.id === "insurance-plan")!;
  expect(plan.values["2026-09"]).toBe(63.25);
  expect(plan.values["2026-10"]).toBe(accept ? 65 : 63.25);
  expect(view.read().state.fixedReceipts).toHaveLength(2);
  expect(view.read().saved).toBe(true);
  view.unmount();
  expect(mount().read().openReviewCount).toBe(0);
});

it("persists the transfer conversion on loading and does not bring old categories back after remount", () => {
  const initial = fixture();
  initial.reviewQueue = [];
  initial.transactions = [{ ...booking, description: "Einzahlung JANNIS BRÜHL", merchantAlias: undefined,
    manualCategory: true, fixedCost: true, sharedWithRaphael: true }];
  localStorage.setItem("finanzdashboard.v1", JSON.stringify(initial));
  const view = mount();
  expect(view.read().state.transactions[0]).toMatchObject({ category: "Transfer", includeInPlan: false,
    fixedCost: false, sharedWithRaphael: false });
  expect(JSON.parse(localStorage.getItem("finanzdashboard.v1")!).transactions).toEqual(view.read().state.transactions);
  view.unmount();
  expect(mount().read().state.transactions[0].category).toBe("Transfer");
});
