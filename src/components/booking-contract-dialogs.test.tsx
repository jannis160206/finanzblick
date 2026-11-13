// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFinance } from "@/components/finance-provider";
import { Transactions } from "@/components/transactions";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { contractOfBooking } from "@/lib/contract-booking";
import { addMonthsToDate, detectContracts } from "@/lib/contracts";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/statement-import", () => ({ StatementImport: () => null }));
vi.mock("@/components/merchant-marks-provider", () => ({
  MerchantMarksProvider: ({ children }: { children: ReactNode }) => children,
  useMerchantMarks: () => null,
  useMerchantLogoFailure: () => null,
}));
vi.mock("next/dynamic", async () => {
  const wizard = await import("@/components/contracts/contract-wizard");
  return { default: () => wizard.default };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const TODAY = "2026-09-12";
const booking = (id: string, date: string, description: string, amount: number, category: Transaction["category"] = "Abonnements"): Transaction => ({
  id, date, bank: "Raiffeisen", pocket: "Girokonto", description, amount, category, includeInPlan: true,
});
const flix = [0, 1, 2, 3].map((index) => booking(`flix-${index}`, addMonthsToDate("2026-05-03", index), "Streamflix Abo", -12.99));
const cinema = booking("cinema", "2026-09-05", "Kino Abendkasse", -12, "Freizeit");
const cloud = booking("cloud", "2026-09-08", "Wolkenspeicher Plus", -4.99, "Prüfen");
const salary = booking("salary", "2026-09-01", "Lohn September", 2400, "Gehalt");

function fixture(): AppState {
  const base = createEmptyAccountState();
  return appStateSchema.parse({
    ...base, settings: { ...base.settings, asOf: TODAY, baselineDate: "2026-05-01" }, transactions: [...flix, cinema, cloud, salary],
  });
}

function renderLedger() {
  let current = fixture();
  function Harness() {
    const [state, setState] = useState(current);
    current = state;
    vi.mocked(useFinance).mockReturnValue({
      state, dashboard: calculateDashboard(state), update: setState, replace: setState,
      openReviewCount: 0, ready: true, saved: true, storageError: null,
      retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
    });
    return <Transactions />;
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Monat filtern"), { target: { value: "" } });
  return { read: () => current };
}

const openSheet = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Weitere Aktionen: ${name}` }));
  return within(screen.getByRole("dialog", { name }));
};

describe("Buchung und Vertrag", () => {
  it("assigns a booking to an existing contract and shows it in the booking sheet", () => {
    const { read } = renderLedger();
    let sheet = openSheet("Kino Abendkasse");
    expect(sheet.getByRole("list", { name: "Vertrag" })).toBeTruthy();
    fireEvent.click(sheet.getByRole("button", { name: "Vertrag zuordnen: Kino Abendkasse" }));

    const picker = within(screen.getByRole("dialog", { name: "Vertrag zuordnen" }));
    const assign = picker.getByRole<HTMLButtonElement>("button", { name: "Zuordnen" });
    expect(assign.disabled).toBe(true);
    fireEvent.click(picker.getByRole("radio", { name: /Streamflix Abo/ }));
    expect(picker.getByText(/12,99\s€ monatlich/)).toBeTruthy();
    act(() => assign.click());

    expect(screen.queryByRole("dialog", { name: "Vertrag zuordnen" })).toBeNull();
    const contracts = detectContracts(read(), TODAY);
    expect(contractOfBooking(contracts, "cinema")?.name).toBe("Streamflix Abo");
    expect(contractOfBooking(contracts, "flix-0")?.name).toBe("Streamflix Abo");

    sheet = openSheet("Kino Abendkasse");
    expect(sheet.getByRole("button", { name: "Vertrag ändern: Streamflix Abo" })).toBeTruthy();
    expect(sheet.queryByRole("button", { name: "Als Vertrag anlegen: Kino Abendkasse" })).toBeNull();
  });

  it("creates a new contract prefilled from the booking, step by step", async () => {
    const { read } = renderLedger();
    const sheet = openSheet("Wolkenspeicher Plus");
    fireEvent.click(sheet.getByRole("button", { name: "Als Vertrag anlegen: Wolkenspeicher Plus" }));

    const dialog = within(await screen.findByRole("dialog", { name: "Als Vertrag anlegen" }));
    expect((dialog.getByLabelText("Name") as HTMLInputElement).value).toBe("Wolkenspeicher Plus");
    expect((dialog.getByLabelText("Betrag je Abbuchung") as HTMLInputElement).value).toBe("4,99");
    expect((dialog.getByLabelText("Kategorie") as HTMLSelectElement).value).toBe("Abonnements");
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));

    const rhythm = await screen.findByRole("group", { name: "Rhythmus" });
    expect(within(rhythm).getByRole("radio", { name: /Monatlich/ }).getAttribute("aria-checked")).toBe("true");
    expect((within(rhythm).getByLabelText("Nächste Abbuchung") as HTMLInputElement).value).toBe("2026-10-08");
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
    const bookings = await screen.findByRole("group", { name: "Buchungen" });
    expect((within(bookings).getByRole("checkbox", { name: /Wolkenspeicher Plus/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
    const rules = await screen.findByRole("group", { name: "Erkennung" });
    expect(within(rules).getByRole("switch", { name: /Neue Abbuchungen automatisch zuordnen/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
    await screen.findByRole("group", { name: "Vorschau" });
    act(() => dialog.getByRole("button", { name: "Vertrag anlegen" }).click());

    const created = read().contracts?.find((entry) => entry.id.startsWith("manual:"));
    expect(created).toMatchObject({
      name: "Wolkenspeicher Plus", amount: 4.99, interval: "monthly", nextDate: "2026-10-08", category: "Abonnements",
      manual: true, status: "confirmed", bookingIds: ["cloud"],
    });
    expect(created?.match).toMatchObject({ amountMin: 3.99, amountMax: 6.24 });
    expect(contractOfBooking(detectContracts(read(), TODAY), "cloud")?.name).toBe("Wolkenspeicher Plus");
  });

  it("offers contracts only for counted expenses", () => {
    renderLedger();
    const sheet = openSheet("Lohn September");
    expect(sheet.queryByRole("list", { name: "Vertrag" })).toBeNull();
    expect(sheet.getByRole("button", { name: "Ignorieren: Lohn September" })).toBeTruthy();
  });
});
