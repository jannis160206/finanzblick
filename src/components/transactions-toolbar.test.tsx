// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFinance } from "./finance-provider";
import { Transactions } from "./transactions";
import { calculateDashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";

vi.mock("./finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(storageError: string | null = null) {
  const seed = createSeed();
  const state = { ...seed, transactions: [], fixedReceipts: [], holidayRanges: [],
    plannedOneOffs: [], plannedOneOffsSeeded: true, financeRows: [], savingsGoals: [] };
  const update = vi.fn();
  vi.mocked(useFinance).mockReturnValue({ state, dashboard: calculateDashboard(state), update,
    replace: vi.fn(), ready: true, saved: true, storageError, retrySave: vi.fn(),
    openReviewCount: 0, appendStatements: vi.fn(), statementImport: undefined });
  render(<Transactions />);
  return { update, state };
}

it("keeps statement upload directly in the drop zone and toolbar actions icon-only", () => {
  const { update } = mount();
  const toolbar = screen.getByRole("group", { name: "Umsatz-Werkzeugleiste" });
  const buttons = within(toolbar).getAllByRole("button");
  expect(within(toolbar).queryByRole("button", { name: "Dateien auswählen" })).toBeNull();
  for (const button of buttons) {
    expect(button.getAttribute("data-size")).toBe("icon");
    expect(button.querySelector("svg")).toBeTruthy();
  }
  const drop = screen.getByRole("region", { name: "Kontoauszüge importieren" });
  const files = within(drop).getByRole("button", { name: "Dateien auswählen" });
  expect(screen.getAllByRole("button", { name: "Dateien auswählen" })).toHaveLength(1);
  const input = screen.getByLabelText<HTMLInputElement>("Kontoauszüge auswählen");
  const click = vi.spyOn(input, "click");
  fireEvent.click(files);
  expect(click).toHaveBeenCalledOnce();
  expect(input.accept).toContain(".pdf");
  expect(input.accept).toContain(".jpeg");
  fireEvent.change(screen.getByRole("textbox", { name: "Umsätze durchsuchen" }), { target: { value: "BILLA" } });
  expect(within(drop).getByRole("button", { name: "Dateien auswählen" })).toBe(files);
  fireEvent.click(within(toolbar).getByRole("button", { name: "Geteilt" }));
  expect(screen.getByRole("dialog", { name: "Geteilt" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
  fireEvent.click(within(toolbar).getByRole("button", { name: "Urlaub" }));
  expect(screen.getByRole("dialog", { name: "Urlaubs-Zeiträume" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Fertig" }));
  fireEvent.click(within(toolbar).getByRole("button", { name: "Weitere Filter" }));
  expect(screen.getByRole("checkbox", { name: "Transfers anzeigen" })).toBeTruthy();
  expect(update).not.toHaveBeenCalled();
});

it("retains filter reset and disables the same existing actions on storage errors", () => {
  mount("Speichern fehlgeschlagen");
  const toolbar = within(screen.getByRole("group", { name: "Umsatz-Werkzeugleiste" }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Dateien auswählen" }).disabled).toBe(true);
  for (const label of ["Geteilt", "Urlaub", "Zuordnung prüfen"])
    expect(toolbar.getByRole<HTMLButtonElement>("button", { name: label }).disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Umsätze durchsuchen" }), { target: { value: "BILLA" } });
  const reset = toolbar.getByRole("button", { name: "Zurücksetzen" });
  expect(reset.textContent).toBe("");
  expect(reset.getAttribute("data-size")).toBe("icon");
  fireEvent.click(reset);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Umsätze durchsuchen" }).value).toBe("");
});
