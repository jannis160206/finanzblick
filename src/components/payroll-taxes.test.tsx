// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PayrollTaxes } from "@/components/payroll-taxes";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState } from "@/lib/types";
import type { Payslip } from "@/lib/payslip-schema";
import { currency, monthLabel } from "@/lib/format";

const pdf = vi.hoisted(() => {
  class PasswordError extends Error {}
  return { parse: vi.fn(), PasswordError };
});
vi.mock("@/lib/import/payslip", () => ({ parsePayslipPdf: pdf.parse, PayslipPasswordError: pdf.PasswordError }));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const january: Payslip = {
  year: 2026, month: 1, employer: "Musterbetrieb GmbH", regularGross: 3000, specialGross: 0,
  regularSv: 540, regularTax: 200, monthlyTaxableBase: 2460, baseSalary: 2800, monthlyPayroll: true,
};
const seed = () => {
  const state = createSeed();
  state.settings.asOf = "2026-09-18";
  return state;
};
let latest: AppState;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  pdf.parse.mockReset().mockResolvedValue({ drafts: [january], issues: [] });
});
afterEach(cleanup);

function Fixture({ initial = seed(), storageError = null }: { initial?: AppState; storageError?: string | null }) {
  const [state, setState] = useState(initial);
  latest = state;
  vi.mocked(useFinance).mockReturnValue({
    state, get dashboard(): never { throw new Error("Payroll must not infer gross from net dashboard data"); },
    update: (updater) => setState((current) => {
      const next = appStateSchema.parse(updater(current));
      localStorage.setItem("payroll-test", JSON.stringify(next));
      return next;
    }),
    replace: vi.fn(), openReviewCount: 0, ready: true, saved: true, storageError,
    retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return <PayrollTaxes />;
}

function file(name = "payroll.pdf") {
  const result = new File(["%PDF-synthetic"], name, { type: "application/pdf" });
  Object.defineProperty(result, "arrayBuffer", { value: async () => new ArrayBuffer(12) });
  return result;
}
function selectPdf() {
  fireEvent.change(screen.getByLabelText("Lohnabrechnungen als PDF auswählen"), { target: { files: [file()] } });
}
async function confirmImport() {
  const dialog = within(await screen.findByRole("dialog", { name: "Lohnabrechnung prüfen" }));
  fireEvent.click(dialog.getByLabelText(/Erkannte Werte und Arbeitgeberzuordnung geprüft/));
  fireEvent.click(dialog.getByRole("button", { name: "Abrechnung übernehmen" }));
}
const moneyText = (value: number) => currency(value).replace(/\s/g, " ");

it("imports by drag and drop only after review, keeps secrets out of state and separates January from the forecast", async () => {
  render(<Fixture />);
  const before = latest;
  expect(screen.getByRole("heading", { name: "Gehalt & Steuern" })).toBeTruthy();
  expect(pdf.parse).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("PDF-Passwort"), { target: { value: "synthetic-password" } });
  fireEvent.drop(screen.getByRole("group", { name: "PDF-Ablage für Lohnabrechnungen" }), { dataTransfer: { files: [file()] } });
  const dialog = within(await screen.findByRole("dialog", { name: "Lohnabrechnung prüfen" }));
  expect(dialog.getByRole<HTMLButtonElement>("button", { name: "Abrechnung übernehmen" }).disabled).toBe(true);
  expect(latest).toBe(before);
  expect(pdf.parse).toHaveBeenCalledWith(expect.any(ArrayBuffer), "synthetic-password");
  await confirmImport();
  expect(latest.payslips).toEqual([january]);
  expect(latest.transactions).toEqual(before.transactions);
  expect(latest.financeRows).toEqual(before.financeRows);
  expect(localStorage.getItem("payroll-test")).not.toContain("synthetic-password");
  const actual = within(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }));
  expect(actual.getAllByText(moneyText(6000)).length).toBeGreaterThan(0);
  expect(actual.getByText(/Nicht der heutige Ist-Stand/)).toBeTruthy();
  expect(screen.getByRole("table", { name: "Monatliche Gehaltsprognose" })).toBeTruthy();
});

it("retries a protected PDF with the entered password and leaves a cancelled import unchanged", async () => {
  pdf.parse.mockRejectedValueOnce(new pdf.PasswordError("Bitte das PDF-Passwort eingeben."));
  render(<Fixture />);
  const before = latest;
  selectPdf();
  expect(await screen.findByText("Bitte das PDF-Passwort eingeben.")).toBeTruthy();
  expect(latest).toBe(before);
  fireEvent.change(screen.getByLabelText("PDF-Passwort"), { target: { value: "test-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Mit Passwort erneut lesen" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Lohnabrechnung prüfen" }));
  fireEvent.click(dialog.getByRole("button", { name: "Abbrechen" }));
  expect(latest).toBe(before);
  expect(pdf.parse).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem("payroll-test")).toBeNull();
});

it("does not duplicate a repeated payslip and requires explicit confirmation before replacing a correction", async () => {
  render(<Fixture initial={{ ...seed(), payslips: [january] }} />);
  selectPdf();
  await confirmImport();
  expect(latest.payslips).toEqual([january]);
  pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, regularGross: 3200 }], issues: [] });
  selectPdf();
  await confirmImport();
  const dialog = within(screen.getByRole("dialog", { name: "Lohnabrechnung prüfen" }));
  expect(dialog.getByRole("alert").textContent).toContain("Ersetzen bitte ausdrücklich bestätigen");
  expect(latest.payslips?.[0].regularGross).toBe(3000);
  fireEvent.click(dialog.getByLabelText(/Abweichende gespeicherte Abrechnungen/));
  fireEvent.click(dialog.getByRole("button", { name: "Abrechnung übernehmen" }));
  expect(latest.payslips).toHaveLength(1);
  expect(latest.payslips?.[0].regularGross).toBe(3200);
});

it("shows actionable import errors and prevents reads when local persistence has failed", async () => {
  const view = render(<Fixture />);
  pdf.parse.mockRejectedValueOnce(new Error("Die PDF enthält keinen lesbaren Text."));
  const before = latest;
  selectPdf();
  expect(await screen.findByText("Die PDF enthält keinen lesbaren Text.")).toBeTruthy();
  expect(latest).toBe(before);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.unmount();
  render(<Fixture storageError="Speicher voll" />);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "PDF auswählen" }).disabled).toBe(true);
  fireEvent.drop(screen.getByRole("group", { name: "PDF-Ablage für Lohnabrechnungen" }), { dataTransfer: { files: [file()] } });
  expect(pdf.parse).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Speicher voll")).toBeTruthy();
});

it("invalidates confirmed forecast assumptions after changed payroll and preserves the other employer", async () => {
  const initial = { ...seed(), payslips: [january], payrollForecasts: [
    { year: 2026 as const, employer: january.employer, months: [], standardPayrollConfirmed: true },
    { year: 2026 as const, employer: "Anderer Betrieb", months: [], standardPayrollConfirmed: true },
  ] };
  render(<Fixture initial={initial} />);
  pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, month: 2, regularGross: 3500 }], issues: [] });
  selectPdf();
  await confirmImport();
  expect(latest.payslips).toHaveLength(2);
  expect(latest.payrollForecasts?.find((entry) => entry.employer === january.employer)?.standardPayrollConfirmed).toBe(false);
  expect(latest.payrollForecasts?.find((entry) => entry.employer === "Anderer Betrieb")?.standardPayrollConfirmed).toBe(true);
});

it("removes an explicitly selected payroll and its obsolete forecast without changing bank transactions", () => {
  const initial = { ...seed(), payslips: [january], payrollForecasts: [
    { year: 2026 as const, employer: january.employer, months: [], standardPayrollConfirmed: true },
  ] };
  render(<Fixture initial={initial} />);
  fireEvent.click(screen.getByRole("button", { name: "Abrechnung entfernen: 1/2026" }));
  const dialog = within(screen.getByRole("dialog", { name: "Lohnabrechnung entfernen?" }));
  expect(latest.payslips).toHaveLength(1);
  fireEvent.click(dialog.getByRole("button", { name: "Entfernen" }));
  expect(latest.payslips).toEqual([]);
  expect(latest.payrollForecasts).toEqual([]);
  expect(latest.transactions).toEqual(initial.transactions);
});

it("uses the upcoming November scenario, not missing June as an actual payment, and retains editable assumptions", async () => {
  render(<Fixture initial={{
    ...seed(), payslips: [january], payrollForecasts: [{
      year: 2026, employer: january.employer, standardPayrollConfirmed: true,
      months: [
        { month: 6, regularGross: 3000, specialGross: 4000, specialSv: 680, monthlyTaxableBase: 2460 },
        { month: 11, regularGross: 3000, specialGross: 4000, specialSv: 680, monthlyTaxableBase: 2460 },
      ],
    }],
  }} />);
  const next = within(screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" }));
  expect(next.getByText(new RegExp(monthLabel("2026-11").replace(".", "\\.")))).toBeTruthy();
  expect(next.getByText("Steuerdifferenz durch den Überhang · Schätzung")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Prognose anpassen" }));
  const dialog = within(screen.getByRole("dialog", { name: "Prognoseannahmen 2026" }));
  const november = within(dialog.getByRole("region", { name: `Prognose ${monthLabel("2026-11")}` }));
  fireEvent.change(november.getByLabelText("Sonderzahlung brutto (€)"), { target: { value: "5000" } });
  expect(november.getByLabelText<HTMLInputElement>("SV der Sonderzahlung (für Steuerschätzung) (€)").value).toBe("");
  fireEvent.click(dialog.getByRole("button", { name: "Prognose speichern" }));
  await waitFor(() => expect(latest.payrollForecasts?.[0].months.find((month) => month.month === 11)?.specialGross).toBe(5000));
  expect(latest.payrollForecasts?.[0].standardPayrollConfirmed).toBe(false);
  expect(latest.payslips).toEqual([january]);
});

it("initializes the selected year only after local finance data has hydrated", () => {
  vi.mocked(useFinance).mockReturnValue({
    state: seed(), get dashboard(): never { throw new Error("No dashboard during hydration"); },
    update: vi.fn(), replace: vi.fn(), openReviewCount: 0, ready: false, saved: false, storageError: null,
    retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  const view = render(<PayrollTaxes />);
  expect(screen.getByRole("status").textContent).toContain("geladen");
  expect(screen.queryByLabelText("PDF-Passwort")).toBeNull();
  const state = { ...seed(), settings: { ...seed().settings, asOf: "2027-09-18" } };
  vi.mocked(useFinance).mockReturnValue({
    state, get dashboard(): never { throw new Error("No dashboard after hydration"); },
    update: vi.fn(), replace: vi.fn(), openReviewCount: 0, ready: true, saved: true, storageError: null,
    retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  view.rerender(<PayrollTaxes />);
  expect(screen.getByLabelText<HTMLSelectElement>("Steuerjahr").value).toBe("2027");
});
