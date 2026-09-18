// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "@/components/finance-provider";
import { Transactions } from "@/components/transactions";
import { classify } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const original: Transaction = {
  id: "amazon", date: "2026-09-12", time: "20:04:15", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
  description: "Amazon", rawDescription: "SEPA Amazon Zahlung Bestellung 123",
  rawDetails: ["Verwendungszweck Bestellung 123"], bankReference: "original-reference",
  merchantAlias: "Amazon Marketplace", amount: -37.42, category: "Shopping", includeInPlan: false, occurrence: 1,
};
function mount(state: AppState) {
  let current: ReturnType<typeof useFinance>;
  function Observer() {
    const finance = useFinance();
    useEffect(() => { current = finance; }, [finance]);
    return null;
  }
  const view = render(<FinanceProvider initialState={state}><Observer /><Transactions /></FinanceProvider>);
  fireEvent.change(screen.getByLabelText("Monat filtern"), { target: { value: "" } });
  return { ...view, read: () => current };
}
const persisted = (): AppState => JSON.parse(localStorage.getItem("finanzdashboard.v1")!);

it("saves Amazon pencil changes through the real updater, persists/reloads and reopens Prüfen", async () => {
  const seed = { ...createSeed(), transactions: [original], financeRows: [], fixedReceipts: [], reviewQueue: [] };
  const view = mount(seed);
  fireEvent.click(screen.getByRole("button", { name: "Zuordnung ändern: Amazon" }));
  let dialog = within(screen.getByRole("dialog", { name: "Zuordnung ändern" }));
  fireEvent.change(dialog.getByLabelText("Kategorie"), { target: { value: "Lebensmittel" } });
  expect(dialog.getByText("Manuell zugeordnet")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Zuordnung übernehmen" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(view.read().state.transactions[0]).toEqual({
    ...original, category: "Lebensmittel", includeInPlan: true, categoryOverride: true, manualCategory: true, reviewed: true,
  });
  expect(classify(view.read().state.transactions[0])).toMatchObject({ category: "Lebensmittel", includeInPlan: true, isTransfer: false });
  expect(screen.queryByText(/feste Zuordnung/)).toBeNull();
  await waitFor(() => expect(persisted().transactions[0].manualCategory).toBe(true));
  view.unmount();
  const loaded = mount(seed);
  expect(loaded.read().state.transactions[0].category).toBe("Lebensmittel");
  expect(screen.getByText("Geprüft", { exact: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Zuordnung ändern: Amazon" }));
  dialog = within(screen.getByRole("dialog", { name: "Zuordnung ändern" }));
  fireEvent.change(dialog.getByLabelText("Kategorie"), { target: { value: "Prüfen" } });
  fireEvent.click(dialog.getByRole("button", { name: "Zuordnung übernehmen" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(loaded.read().state.transactions[0]).toMatchObject({
    ...original, category: "Prüfen", manualCategory: true, reviewed: false, includeInPlan: false,
  });
  expect(loaded.read().openReviewCount).toBe(1);
  await waitFor(() => expect(persisted().transactions[0].reviewed).toBe(false));
});

it.each(["BIPA", "Interne Überweisung"])("accepts %s in the actual approval UI without passing manual authority to twins", async (description) => {
  const source = { ...original, description, merchantAlias: undefined, rawDescription: description, category: "Prüfen" as const,
    manualCategory: true, categoryOverride: true, reviewed: false };
  const twin = { ...source, id: "twin", date: "2026-09-13", bankReference: "twin-reference", manualCategory: undefined, categoryOverride: undefined };
  const seed = { ...createSeed(), transactions: [source, twin], financeRows: [], fixedReceipts: [], reviewQueue: [] };
  const view = mount(seed);
  fireEvent.click(screen.getByRole("button", { name: "Zuordnung prüfen", exact: true }));
  const section = within(screen.getByRole("region", { name: `Buchung prüfen: ${description}` }));
  fireEvent.change(section.getByLabelText("Kategorie"), { target: { value: "Gesundheit" } });
  fireEvent.click(section.getByRole("button", { name: "Zuordnung übernehmen" }));
  await waitFor(() => expect(view.read().state.transactions[0].category).toBe("Gesundheit"));
  expect(view.read().state.transactions[0]).toMatchObject({
    ...source, category: "Gesundheit", manualCategory: true, reviewed: true, fixedCost: false, includeInPlan: true,
  });
  expect(view.read().state.transactions[1].manualCategory).toBeUndefined();
  expect(view.read().state.transactions[1].category).toBe(description === "BIPA" ? "Mittagessen" : "Transfer intern");
});
