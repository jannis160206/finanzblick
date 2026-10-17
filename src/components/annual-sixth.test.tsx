// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnnualSixthCard } from "@/components/annual-sixth";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState } from "@/lib/types";
import { currency } from "@/lib/format";
const moneyText = (value: number) => currency(value).replace(/\s/g, " ");

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
let latest: AppState;
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(cleanup);

function Fixture({ initial = createSeed() }: { initial?: AppState }) {
  const [state, setState] = useState(initial);
  useEffect(() => { latest = state; }, [state]);
  vi.mocked(useFinance).mockReturnValue({
    state, get dashboard(): never { throw new Error("Annual sixth needs payslip inputs, not calculated net cashflow"); },
    update: (updater) => setState((current) => {
      const next = appStateSchema.parse(updater(current));
      localStorage.setItem("annual-sixth-test", JSON.stringify(next));
      return next;
    }),
    replace: vi.fn(), openReviewCount: 0, ready: true, saved: true,
    storageError: null, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return <AnnualSixthCard />;
}

function edit() {
  fireEvent.click(screen.getByRole("button", { name: "Bruttowerte erfassen" }));
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Abrechnungsmonat"), { target: { value: "9" } });
  fireEvent.change(dialog.getByLabelText("Laufendes Brutto seit Jänner"), { target: { value: "27000" } });
  fireEvent.change(dialog.getByLabelText("Sonderzahlungen brutto bisher"), { target: { value: "3000" } });
  fireEvent.change(dialog.getByLabelText("Geplante Sonderzahlung brutto"), { target: { value: "3500" } });
  return dialog;
}

it("does not invent a gross-tax assessment from existing net salary transactions", () => {
  const initial = createSeed();
  initial.transactions = [{
    id: "net-salary", date: "2026-09-01", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
    description: "Nettogehalt", category: "Gehalt", amount: 27000, includeInPlan: false,
  }];
  render(<Fixture initial={initial} />);
  expect(screen.getByText(/Bruttowerte fehlen:/).textContent).toContain("Nettozahlungen");
  expect(screen.queryByText(moneyText(6000))).toBeNull();
  expect(latest.annualSixth).toBeUndefined();
});

it("requires a valid method, saves a payslip-based assessment and restores it after remount", () => {
  const view = render(<Fixture />);
  const before = latest;
  const dialog = edit();
  const save = dialog.getByRole<HTMLButtonElement>("button", { name: "Bruttowerte speichern" });
  expect(save.disabled).toBe(true);
  fireEvent.click(dialog.getByRole("checkbox"));
  expect(save.disabled).toBe(false);
  expect(latest).toBe(before);
  fireEvent.click(save);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(latest.annualSixth).toEqual([{
    year: 2026, month: 9, employer: "", regularGross: 27000, specialGross: 3000,
    plannedSpecialGross: 3500, monthlyPayroll: true,
  }]);
  expect(latest.transactions).toEqual(before.transactions);
  expect(latest.financeRows).toEqual(before.financeRows);
  expect(screen.getByText(moneyText(6000))).toBeTruthy();
  expect(screen.getByText(/500,00.*rechnerischer Überhang/)).toBeTruthy();
  const restored = appStateSchema.parse(JSON.parse(localStorage.getItem("annual-sixth-test")!));
  view.unmount();
  render(<Fixture initial={restored} />);
  expect(screen.getByText(moneyText(6000))).toBeTruthy();
  expect(screen.getByText(/innerhalb des aktuellen Jahressechstels/)).toBeTruthy();
});

it("honors reported sixth values for nonstandard employment and does not save cancelled edits", () => {
  render(<Fixture />);
  const before = latest;
  let dialog = edit();
  fireEvent.click(dialog.getByRole("button", { name: "Abbrechen" }));
  expect(latest).toBe(before);
  dialog = edit();
  fireEvent.change(dialog.getByLabelText("Jahressechstel laut Abrechnung"), { target: { value: "2500" } });
  fireEvent.click(dialog.getByRole("button", { name: "Bruttowerte speichern" }));
  expect(latest.annualSixth?.[0].monthlyPayroll).toBe(false);
  expect(screen.getByText("Jahressechstel · laut Abrechnung")).toBeTruthy();
  expect(screen.getByText(moneyText(2500))).toBeTruthy();
  expect(screen.getByText("Rechnerischer Überhang")).toBeTruthy();
  expect(screen.getByText(/grundsätzlich dem Tarif/)).toBeTruthy();
});

it("keeps annual entries separate and labels future periods as a forecast", () => {
  const initial = createSeed();
  initial.settings.asOf = "2026-09-18";
  initial.annualSixth = [{
    year: 2026, month: 9, employer: "Testbetrieb", regularGross: 27000, specialGross: 3000,
    plannedSpecialGross: 0, monthlyPayroll: true,
  }];
  render(<Fixture initial={initial} />);
  fireEvent.change(screen.getByLabelText("Jahressechstel Jahr"), { target: { value: "2027" } });
  expect(screen.getByText(/Bruttowerte fehlen:/)).toBeTruthy();
  const dialog = edit();
  fireEvent.click(dialog.getByRole("checkbox"));
  fireEvent.click(dialog.getByRole("button", { name: "Bruttowerte speichern" }));
  expect(latest.annualSixth).toHaveLength(2);
  expect(latest.annualSixth?.[0]).toEqual(initial.annualSixth[0]);
  expect(screen.getByText(/Vorausschau: Abrechnungsmonat nach Dashboard-Stichtag/)).toBeTruthy();
});
