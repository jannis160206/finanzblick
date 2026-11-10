// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContractWizard, { type ContractWizardProps } from "./contract-wizard";
import { createEmptyAccountState } from "@/lib/account-state";
import { detectContracts } from "@/lib/contracts";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";

vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
vi.mock("@/components/merchant-marks-provider", () => ({
  MerchantMarksProvider: ({ children }: { children: ReactNode }) => children,
  useMerchantMarks: () => null,
  useMerchantLogoFailure: () => null,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const booking = (id: string, date: string, description: string, amount: number, category: Transaction["category"]): Transaction => ({
  id, date, bank: "Raiffeisen", pocket: "Girokonto", description, amount, category, includeInPlan: true,
});

function stateWith(transactions: Transaction[]): AppState {
  const base = createEmptyAccountState();
  return appStateSchema.parse({ ...base, settings: { ...base.settings, asOf: "2026-09-12", baselineDate: "2026-09-01" }, transactions });
}

const gym = ["06", "07", "08"].map((month) => booking(`gym-${month}`, `2026-${month}-02`, "FITNESS PRO GmbH", -35, "Sport & Fitness"));
const flix = ["05", "06", "07", "08", "09"].map((month) => booking(`flix-${month}`, `2026-${month}-03`, "Streamflix Abo", -12.99, "Abonnements"));

function open(props: Partial<ContractWizardProps> & { state: AppState }) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(<ContractWizard open contract={null} contracts={detectContracts(props.state, "2026-09-12")} today="2026-09-12" disabled={false}
    storageError={null} onClose={onClose} onSave={onSave} {...props} />);
  return { onSave, onClose, dialog: within(screen.getByRole("dialog")) };
}

describe("contract wizard", () => {
  it("creates a contract step by step from picked bookings with a suggested rule", async () => {
    const { onSave, dialog } = open({ state: stateWith([...gym, ...flix]) });
    expect(dialog.getByRole("navigation", { name: "Schritte" })).toBeTruthy();
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Fitnessstudio" } });
    fireEvent.change(dialog.getByLabelText("Betrag je Abbuchung"), { target: { value: "35" } });
    fireEvent.change(dialog.getByLabelText("Kündigungsfrist"), { target: { value: "1" } });
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));

    const rhythm = await screen.findByRole("group", { name: "Rhythmus" });
    expect(within(rhythm).getByRole("radio", { name: /Monatlich/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));

    const bookings = await screen.findByRole("group", { name: "Buchungen" });
    const boxes = within(bookings).getAllByRole("checkbox", { name: /FITNESS PRO GmbH/ });
    expect(boxes).toHaveLength(3);
    for (const box of boxes) fireEvent.click(box);
    const summary = within(bookings).getByRole("region", { name: "Ausgewählte Buchungen" });
    expect(within(summary).getByText("3 Buchungen ausgewählt")).toBeTruthy();
    fireEvent.click(within(summary).getByRole("button", { name: /Nächste/ }));
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));

    const rules = await screen.findByRole("group", { name: "Erkennung" });
    expect(within(rules).getByRole("switch", { name: /Neue Abbuchungen automatisch zuordnen/ }).getAttribute("aria-checked")).toBe("true");
    expect((within(rules).getByLabelText(/Buchungstext enthält/) as HTMLInputElement).value.toLowerCase()).toContain("fitness pro");
    expect(within(rules).getByText((_, element) => element?.tagName === "P" && /^3 Buchungen passen$/.test(element.textContent ?? ""))).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));

    const preview = await screen.findByRole("group", { name: "Vorschau" });
    expect(within(preview).getByText("Fitnessstudio")).toBeTruthy();
    expect(within(preview).getAllByText("2.10.2026").length).toBeGreaterThan(0);
    fireEvent.click(dialog.getByRole("button", { name: "Vertrag anlegen" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0][0];
    expect(patch).toMatchObject({
      name: "Fitnessstudio", amount: 35, interval: "monthly", nextDate: "2026-10-02", manual: true, status: "confirmed",
      notice: { value: 1, unit: "months" }, category: "Abonnements",
    });
    expect([...patch.bookingIds].sort()).toEqual(["gym-06", "gym-07", "gym-08"]);
    expect(patch.excludedBookingIds).toBeUndefined();
    expect(patch.match).toMatchObject({ amountMin: 28, amountMax: 43.75, account: expect.stringMatching(/^Raiffeisen · /) });
  });

  it("stays on a step until its fields are valid", async () => {
    const { onSave, dialog } = open({ state: stateWith([]) });
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
    expect(await dialog.findByText("Bitte einen Namen mit 1 bis 100 Zeichen eingeben.")).toBeTruthy();
    expect(dialog.getByText(/Bitte einen Betrag größer als 0/)).toBeTruthy();
    expect(screen.getByRole("group", { name: "Grunddaten" })).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("edits a detected contract: deselected charges are excluded and the review is confirmed", async () => {
    const state = stateWith(flix);
    const [contract] = detectContracts(state, "2026-09-12");
    expect(contract.status).toBe("review");
    const { onSave, dialog } = open({ state, contract });
    fireEvent.click(dialog.getByRole("button", { name: "3. Buchungen" }));
    const bookings = await screen.findByRole("group", { name: "Buchungen" });
    const latest = within(bookings).getAllByRole("checkbox", { name: /Streamflix Abo/ })
      .find((box) => box.getAttribute("aria-label")?.includes("3.9.2026"));
    expect(latest).toBeTruthy();
    expect((latest as HTMLInputElement).checked).toBe(true);
    fireEvent.click(latest as HTMLElement);
    fireEvent.click(dialog.getByRole("button", { name: "Speichern" }));

    const patch = onSave.mock.calls[0][0];
    expect(patch).toMatchObject({ status: "confirmed", excludedBookingIds: ["flix-09"] });
    expect(patch.bookingIds).toHaveLength(4);
    expect(patch).not.toHaveProperty("name");
    expect(patch).not.toHaveProperty("match");
    expect(patch.manual).toBeUndefined();
  });
});
