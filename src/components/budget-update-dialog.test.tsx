// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetReview, BudgetUpdateDialog } from "./budget-update-dialog";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import type { BudgetCorrection } from "@/lib/budget-corrections";
import { syncPayrollBudget } from "@/lib/payroll-budget";
import type { SalaryForecast } from "@/lib/salary-forecast";

vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const item = (rowId: string, label: string, kind: BudgetCorrection["kind"], month: string, from: number, to: number, reason: string, create?: true): BudgetCorrection =>
  ({ id: `${rowId}|${month}`, rowId, label, kind, month, from, to, reason, ...(create ? { create } : {}) });
const items: BudgetCorrection[] = [
  ...["2027-01", "2027-02", "2027-03"].map((month) => item("income-salary", "Gehalt", "salary", month, 2400, 2500, "laufendes Netto lt. Abrechnung Nov. 2026")),
  item("income-special-payments", "Sonderzahlungen", "special", "2026-12", 0, 2396, "wie Dez. 2025 · +4,17 %", true),
  item("income-special-payments", "Sonderzahlungen", "special", "2027-01", 0, 1979, "wie Jän. 2026 · +4,17 %", true),
  item("income-other", "Weitere Einnahmen", "duplicate", "2026-12", 2400, 0, "doppelt zur Sonderzahlung 2.396,00 €"),
];
const forecast: SalaryForecast = {
  history: [], months: [], actualThrough: "2026-12",
  level: { amount: 2500, reason: "laufendes Netto lt. Abrechnung Nov. 2026" }, raise: { factor: 1.0417, since: "2025-12" },
};

function open(onApply = vi.fn()) {
  render(<BudgetUpdateDialog open items={items} forecast={forecast} disabled={false} onOpenChange={vi.fn()} onApply={onApply} />);
  return { onApply, dialog: within(screen.getByRole("dialog", { name: "Budgetwerte prüfen" })) };
}

describe("Budgetwerte prüfen", () => {
  it("lists the proposals per row with old and new values, months with the same change in one line", () => {
    const { dialog } = open();
    expect(dialog.getByText(/^2\.500,00\s€$/, { selector: "dd" })).toBeTruthy();
    expect(dialog.getByText("+4,17 %")).toBeTruthy();
    const salary = within(dialog.getByRole("region", { name: "Gehalt" }));
    expect(salary.getAllByRole("checkbox")).toHaveLength(1);
    expect(salary.getByRole("checkbox", { name: /^Gehalt, Jän\. 2027 – März 2027: 2\.500,00\s€ statt 2\.400,00\s€$/ })).toBeTruthy();
    expect(salary.getByText("laufendes Netto lt. Abrechnung Nov. 2026")).toBeTruthy();
    const special = within(dialog.getByRole("region", { name: /^Sonderzahlungen/ }));
    expect(special.getByText("neu")).toBeTruthy();
    expect(special.getAllByRole("checkbox")).toHaveLength(2);
    expect(special.getByText("wie Dez. 2025 · +4,17 %")).toBeTruthy();
    expect(within(dialog.getByRole("region", { name: /^Weitere Einnahmen/ })).getByText("doppelt")).toBeTruthy();
    expect(dialog.getByText(/^6 Werte/)).toBeTruthy();
  });

  it("applies only the selected values after confirmation", () => {
    const { dialog, onApply } = open();
    fireEvent.click(dialog.getByRole("checkbox", { name: /^Weitere Einnahmen, Dezember 2026/ }));
    fireEvent.click(dialog.getByRole("button", { name: "Sonderzahlungen: alle abwählen" }));
    expect(dialog.getByText(/^3 Werte/).textContent).toMatch(/\+300,00\s€/);
    fireEvent.click(dialog.getByRole("button", { name: "Sonderzahlungen: alle auswählen" }));
    fireEvent.click(dialog.getByRole("checkbox", { name: /^Sonderzahlungen, Jänner 2027/ }));
    fireEvent.click(dialog.getByRole("button", { name: "Übernehmen" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].map((entry: BudgetCorrection) => entry.id)).toEqual([
      "income-salary|2027-01", "income-salary|2027-02", "income-salary|2027-03", "income-special-payments|2026-12",
    ]);
  });

  it("keeps everything when nothing is selected and does nothing while storage is unavailable", () => {
    const { dialog, onApply } = open();
    for (const name of ["Gehalt: alle abwählen", "Sonderzahlungen: alle abwählen", "Weitere Einnahmen: alle abwählen"])
      fireEvent.click(dialog.getByRole("button", { name }));
    expect(dialog.getByText(/6 bleiben/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Alle beibehalten" }));
    expect(onApply).toHaveBeenCalledWith([]);
    cleanup();
    render(<BudgetUpdateDialog open items={items} forecast={forecast} disabled onOpenChange={vi.fn()} onApply={onApply} />);
    expect((within(screen.getByRole("dialog")).getByRole("button", { name: "Übernehmen" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("shows no button while everything goes in automatically and offers only values changed by hand", () => {
    const seed = createSeed();
    seed.settings = { ...seed.settings, asOf: "2026-11-10", baselineDate: "2026-11-01" };
    seed.payslips = [{ year: 2026, month: 10, employer: "Musterbetrieb GmbH", monthlyPayroll: true, regularGross: 3000, specialGross: 0, netPay: 2100 }];
    const update = vi.fn();
    const mock = (state: typeof seed) => vi.mocked(useFinance).mockReturnValue({ state, update, storageError: null } as unknown as ReturnType<typeof useFinance>);
    mock(seed);
    const { container } = render(<BudgetReview />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button", { name: /Budget aktualisieren/ })).toBeNull();
    cleanup();
    const synced = syncPayrollBudget(seed, 1).state;
    const edited = { ...synced, financeRows: synced.financeRows.map((row) => row.id === "income-salary" ? { ...row, values: { ...row.values, "2027-02": 1900 } } : row) };
    mock(edited);
    render(<BudgetReview />);
    fireEvent.click(screen.getByRole("button", { name: "1 Budgetwert prüfen" }));
    const dialog = within(screen.getByRole("dialog", { name: "Budgetwerte prüfen" }));
    expect(dialog.getByRole("checkbox", { name: /^Gehalt, Februar 2027: 2\.100,00\s€ statt 1\.900,00\s€$/ })).toBeTruthy();
    expect(dialog.getByText(/^von Hand geändert · /)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Übernehmen" }));
    const next = update.mock.calls[0][0](edited);
    expect(next.financeRows.find((row: { id: string }) => row.id === "income-salary").values["2027-02"]).toBe(2100);
  });
});