// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PayrollModelSettings } from "@/components/payroll-model-settings";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import type { Payslip } from "@/lib/payslip-schema";
import { appStateSchema, type AppState } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);

const slip = (month: number, extra: Partial<Payslip> = {}): Payslip => ({
  year: 2026, month, employer: "Musterbetrieb GmbH", monthlyPayroll: true, baseSalary: 3000, regularGross: 3400,
  onCallGross: 300, specialGross: 0, regularSv: 612, regularTax: 400, netPay: 2388, ...extra,
});

let latest: AppState;
function Fixture({ payslips }: { payslips?: Payslip[] }) {
  const [state, setState] = useState(() => {
    const seed = createSeed();
    seed.settings.asOf = "2026-11-10";
    if (payslips) seed.payslips = payslips;
    return seed;
  });
  useEffect(() => { latest = state; }, [state]);
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: undefined as never, update: (updater) => setState((current) => appStateSchema.parse(updater(current))),
    replace: vi.fn(), openReviewCount: 0, ready: true, saved: true, storageError: null,
    retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return <PayrollModelSettings />;
}

it("keeps the Successbonus at 138,5 % by default and saves a new share only after a change", () => {
  render(<Fixture />);
  const input = screen.getByLabelText<HTMLInputElement>("Successbonus");
  expect(input.value).toBe("138,5");
  expect(screen.getByText("Kommt mit dem Dezember-Lohn, ausgezahlt im Jänner.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Speichern" })).toBeNull();

  fireEvent.change(input, { target: { value: "abc" } });
  fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
  expect(screen.getByRole("alert").textContent).toContain("0 bis 500 %");
  expect(latest.settings.successBonusPercent).toBeUndefined();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe("138,5");

  fireEvent.change(input, { target: { value: "120,5" } });
  fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
  expect(latest.settings.successBonusPercent).toBe(120.5);
  expect(screen.queryByRole("button", { name: "Speichern" })).toBeNull();
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.submit(input.closest("form")!);
  expect(latest.settings.successBonusPercent).toBe(0);
});

it("shows the learned profile and the tax logic as short rows, details behind the info buttons", () => {
  const payslips = Array.from({ length: 10 }, (_, index) => slip(index + 1, index === 5 ? { specialGross: 3000, specialSv: 512.1, specialTax: 112.07, netPay: 4763.83 } : {}));
  render(<Fixture payslips={payslips} />);
  expect(screen.getByText(/≈ 4\.155\s€ brutto bei aktuellem Grundgehalt/)).toBeTruthy();
  const learned = within(screen.getByRole("region", { name: "Gelernt aus 10 Abrechnungen" }));
  expect(learned.getByText("Rufbereitschaft").nextElementSibling?.textContent).toMatch(/^300,00\s€ im Monat · 2026$/);
  expect(learned.getByText("Sonderzahlungen").nextElementSibling?.textContent).toBe("Jun · je 1 Grundgehalt");
  const tax = within(screen.getByRole("region", { name: "Steuer" }));
  expect(tax.getByText("Lohnsteuer").nextElementSibling?.textContent).toBe("Tarif AT 2026 progressiv");
  expect(tax.getByText("Sonderzahlungen").nextElementSibling?.textContent).toBe("6 % im Jahressechstel · 620 € frei");
  expect(tax.getByRole("button", { name: "Info: Steuer" })).toBeTruthy();
  expect(screen.queryByText(/Steuerklasse/)).toBeNull();
});
