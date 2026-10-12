// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { StatementImport } from "./statement-import";
import { createSeed } from "@/lib/seed";
import { accountLabel } from "@/lib/accounts";
import { currency, dateLabel } from "@/lib/format";
import { actualBookings } from "@/lib/calc";
import { statementFingerprint } from "@/lib/import/identity";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import { prepareStatementImport } from "@/lib/import/review";
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

it.each([
  { accept: true, stored: "pending" }, { accept: false, stored: "pending" },
  { accept: true, stored: "ledger" }, { accept: false, stored: "ledger" },
  { accept: true, stored: "receipt" }, { accept: false, stored: "receipt" },
])("saves a fixed-review alias and remembers later imports ($stored, accept: $accept)", async ({ accept, stored }) => {
  const initial = fixture();
  const change = initial.reviewQueue![0];
  if (change.kind !== "fixed") throw new Error("Expected fixed review");
  initial.financeRows[0].values["2026-11"] = 63.25;
  const original = { ...booking, merchantAlias: undefined,
    description: "SEPA-Lastschrift TEST4711 IBAN Zahlungsempfaenger: AT000000000000000001 BIC Zahlungsempfaenger: TESTATXX",
    rawDetails: ["Originale Bankdetails"], bankReference: "synthetic-reference", manualCategory: true };
  change.change.bookings = [original, { ...original, id: "second", date: "2026-10-03" }];
  if (stored === "ledger") initial.transactions = [original];
  if (stored === "receipt") initial.fixedReceipts = [{
    key: statementFingerprint(original), merchantKey: merchantRuleKey(original), rowId: "insurance-plan",
    date: original.date, amount: original.amount, category: original.category, booking: original,
  }];
  const view = mount(initial);
  fireEvent.click(screen.getByRole("button", { name: "Prüfung öffnen" }));
  const region = within(screen.getByRole("region", { name: "Versicherungen prüfen" }));
  const recognized = within(region.getAllByLabelText(`Erkannte Buchung: ${original.description}`)[0]);
  fireEvent.click(recognized.getByRole("button", { name: "Händlername bearbeiten" }));
  const name = recognized.getByRole("textbox", { name: "Händlername" });
  expect(document.activeElement).toBe(name);
  fireEvent.change(name, { target: { value: "  Meine Versicherung  " } });
  expect(recognized.getByText("Originalbuchung").closest("details")?.open).toBe(false);
  expect(actualBookings(view.read().state).find((row) => row.id === original.id)?.merchantAlias).toBeUndefined();
  expect(view.read().state.merchantRules ?? []).toEqual([]);
  fireEvent.click(region.getByRole("button", { name: accept ? "Neuen Dauerbetrag übernehmen" : "Bisherigen Dauerbetrag behalten" }));
  await waitFor(() => expect(view.read().openReviewCount).toBe(0));
  const saved = view.read().state;
  const renamed = actualBookings(saved).find((row) => statementFingerprint(row) === statementFingerprint(original))!;
  expect(renamed).toMatchObject({ ...original, description: "SEPA-Lastschrift TEST4711",
    rawDescription: original.description, id: renamed?.id, merchantAlias: "Meine Versicherung" });
  expect(statementFingerprint(renamed)).toBe(statementFingerprint(original));
  expect(actualBookings(saved)).toHaveLength(2);
  expect(saved.financeRows.find((row) => row.id === "insurance-plan")!.values["2026-10"]).toBe(accept ? 65 : 63.25);
  expect(saved.financeRows.find((row) => row.id === "insurance-plan")!.values["2026-09"]).toBe(63.25);
  expect(saved.merchantRules).toContainEqual(expect.objectContaining({
    key: merchantRuleKey(original), merchantAlias: "Meine Versicherung", category: "Versicherungen",
  }));
  expect(view.read().saved).toBe(true);
  view.unmount();
  const loaded = mount().read().state;
  expect(actualBookings(loaded).find((row) => statementFingerprint(row) === statementFingerprint(original))?.merchantAlias).toBe("Meine Versicherung");
  const future = { ...original, id: "future", date: "2026-11-02", amount: -70, categoryOverride: undefined, manualCategory: undefined };
  const prepared = prepareStatementImport([{
    file: "synthetic.csv", source: "Raiffeisen", rows: [future], issues: [], skipped: 0,
  }], loaded);
  expect(prepared.review).toHaveLength(1);
  expect(prepared.review[0]).toMatchObject({ kind: "fixed", change: { rowId: "insurance-plan",
    bookings: [expect.objectContaining({ merchantAlias: "Meine Versicherung", category: "Versicherungen" })] } });
});

it("rejects empty aliases and discards an unconfirmed fixed-review rename on close", () => {
  const view = mount();
  const before = view.read().state;
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: "Prüfung öffnen" }));
    return within(screen.getByRole("region", { name: "Versicherungen prüfen" }));
  };
  const region = open();
  fireEvent.click(region.getAllByRole("button", { name: "Händlername bearbeiten" })[0]);
  const name = region.getByRole("textbox", { name: "Händlername" });
  fireEvent.change(name, { target: { value: "  " } });
  for (const label of ["Bisherigen Dauerbetrag behalten", "Neuen Dauerbetrag übernehmen"])
    expect(region.getByRole<HTMLButtonElement>("button", { name: label }).disabled).toBe(true);
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(region.getByText(/Bitte einen Händlernamen/)).toBeTruthy();
  fireEvent.change(name, { target: { value: "Anderer Name" } });
  fireEvent.click(screen.getByRole("button", { name: "Prüfung schließen" }));
  expect(view.read().state).toBe(before);
  expect(open().queryByRole("textbox", { name: "Händlername" })).toBeNull();
  expect(screen.getByText("Meine Haftpflicht")).toBeTruthy();
});
