// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PayrollTaxes } from "@/components/payroll-taxes";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState } from "@/lib/types";
import type { Payslip } from "@/lib/payslip-schema";
import { currency, monthLabel } from "@/lib/format";
import { payrollPresentation } from "@/components/payroll-presentation";

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
let externalUpdate: (updater: (state: AppState) => AppState) => void;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  pdf.parse.mockReset().mockResolvedValue({ drafts: [january], issues: [] });
});
afterEach(cleanup);

function Fixture({ initial = seed(), storageError = null }: { initial?: AppState; storageError?: string | null }) {
  const [state, setState] = useState(initial);
  useEffect(() => { externalUpdate = setState; latest = state; }, [state]);
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
function selectPdf(files = [file()]) {
  fireEvent.change(screen.getByLabelText("Lohnabrechnungen als PDF auswählen"), { target: { files } });
}
const moneyText = (value: number) => currency(value).replace(/\s/g, " ");
function expectNoManualInputs() {
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Abrechnung manuell ergänzen" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Abrechnung bearbeiten/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Prognose anpassen" })).toBeNull();
  expect(screen.queryByText(/Manuelle Jahressechstel-Berechnung/)).toBeNull();
}

const bonusPayslips = () => Array.from({ length: 8 }, (_, index) => ({
  ...january, month: index + 1, regularGross: 4000, baseSalary: 3000,
  monthlyTaxableBase: 3200, regularTax: 500,
  ...(index === 5 ? { specialGross: 3000, specialSv: 512.1 } : {}),
}));

it("shows additional gross bonus room with the isolated tariff example collapsed by default", () => {
  render(<Fixture initial={{ ...seed(), payslips: bonusPayslips() }} />);
  const bonus = within(screen.getByRole("region", { name: "Zusätzlicher Prämien-Spielraum" }));
  expect(bonus.getByText(moneyText(2000))).toBeTruthy();
  expect(bonus.getByText(/Auszahlung im November 2026/)).toBeTruthy();
  expect(bonus.getByText(/Geplante Sonderzahlungen bereits reserviert:/).textContent).toContain(currency(3000));
  const example = within(bonus.getByRole("group", { name: "Steuerbeispiel Zusatzprämie" }));
  expect(bonus.getByRole("group", { name: "Steuerbeispiel Zusatzprämie" }).closest("details")?.open).toBe(false);
  fireEvent.click(bonus.getByText("Steuerbeispiel für 1.000 €"));
  expect(bonus.getByRole("group", { name: "Steuerbeispiel Zusatzprämie" }).closest("details")?.open).toBe(true);
  expect(example.getByText("40 %")).toBeTruthy();
  for (const value of [170.7, 331.72, 502.42, 497.58]) expect(example.getByText(moneyText(value))).toBeTruthy();
  expect(bonus.getByText(/nicht für die ganze Prämie/)).toBeTruthy();
  expect(bonus.getByText(/keine verbindliche Abrechnung/)).toBeTruthy();
  expectNoManualInputs();
});

it("shows a conservative bonus range when February's sixth classification is unresolved", () => {
  const payslips = bonusPayslips().map((entry) => entry.month === 2
    ? { ...entry, unresolvedSixthBonus: 1000, specialSv: 141.2 } : entry);
  render(<Fixture initial={{ ...seed(), payslips }} />);
  const bonus = within(screen.getByRole("region", { name: "Zusätzlicher Prämien-Spielraum" }));
  expect(bonus.getByText(`${moneyText(1000)} – ${moneyText(2166.67)}`)).toBeTruthy();
  expect(bonus.getByText(/vorsichtig am unteren Wert orientieren/)).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" })).getAllByText("Noch offen")).toHaveLength(3);
});

it("does not substitute zero bonus room or zero net when historical payrolls are missing", () => {
  render(<Fixture initial={{ ...seed(), payslips: bonusPayslips().filter((entry) => entry.month !== 2) }} />);
  const bonus = within(screen.getByRole("region", { name: "Zusätzlicher Prämien-Spielraum" }));
  expect(bonus.getByText("Noch offen")).toBeTruthy();
  expect(bonus.queryByText(moneyText(0))).toBeNull();
  expect(bonus.getByText(/Steuer und Netto noch offen/)).toBeTruthy();
});

it("updates bonus headroom automatically when a newer payslip changes the model", async () => {
  render(<Fixture initial={{ ...seed(), payslips: bonusPayslips() }} />);
  pdf.parse.mockResolvedValueOnce({ drafts: [{
    ...january, month: 9, regularGross: 5000, baseSalary: 3000, monthlyTaxableBase: 4000, regularTax: 700,
  }], issues: [] });
  selectPdf();
  await waitFor(() => expect(latest.payslips).toHaveLength(9));
  const bonus = within(screen.getByRole("region", { name: "Zusätzlicher Prämien-Spielraum" }));
  expect(bonus.getByText(moneyText(2545.45))).toBeTruthy();
  expectNoManualInputs();
});

it("automatically imports dropped PDFs without a form and keeps secrets and bank data untouched", async () => {
  render(<Fixture />);
  const before = latest;
  expectNoManualInputs();
  expect(pdf.parse).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("PDF-Passwort"), { target: { value: "synthetic-password" } });
  fireEvent.drop(screen.getByRole("group", { name: "PDF-Ablage für Lohnabrechnungen" }), { dataTransfer: { files: [file()] } });
  await waitFor(() => expect(latest.payslips).toEqual([january]));
  expect(pdf.parse).toHaveBeenCalledWith(expect.any(ArrayBuffer), "synthetic-password");
  expect(latest.transactions).toEqual(before.transactions);
  expect(latest.financeRows).toEqual(before.financeRows);
  expect(localStorage.getItem("payroll-test")).not.toContain("synthetic-password");
  expect(screen.queryByRole("dialog")).toBeNull();
  expectNoManualInputs();
  const actual = within(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }));
  expect(actual.getAllByText(moneyText(6000)).length).toBeGreaterThan(0);
  expect(actual.getByText(`Stand: ${monthLabel("2026-01")}`)).toBeTruthy();
  expect(screen.getByRole("region", { name: "Monatliche Gehaltsprognose" }).closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("Monatliche Prognose anzeigen"));
  expect(screen.getByRole("region", { name: "Monatliche Gehaltsprognose" }).closest("details")?.open).toBe(true);
  expect(screen.getByRole("region", { name: "Monatliche Gehaltsprognose" })).toBeTruthy();
});

it("retries a protected PDF using only its password, then analyzes it automatically", async () => {
  pdf.parse.mockRejectedValueOnce(new pdf.PasswordError("Bitte das PDF-Passwort eingeben."));
  render(<Fixture />);
  const before = latest;
  selectPdf();
  expect(await screen.findByText("Bitte das PDF-Passwort eingeben.")).toBeTruthy();
  expect(latest).toBe(before);
  fireEvent.change(screen.getByLabelText("PDF-Passwort"), { target: { value: "test-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Mit Passwort erneut lesen" }));
  await waitFor(() => expect(latest.payslips).toEqual([january]));
  expect(pdf.parse).toHaveBeenCalledTimes(2);
  expectNoManualInputs();
});

it("attributes deduplicated document warnings while automatically importing valid values", async () => {
  const firstIssue = "Seite 1 (01/2026): Kontrollwert nicht eindeutig lesbar.";
  const secondIssue = "Seite 1 (02/2026): Kontrollwert nicht eindeutig lesbar.";
  pdf.parse.mockResolvedValueOnce({ drafts: [january], issues: [firstIssue, firstIssue] });
  pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, month: 2 }], issues: [secondIssue] });
  render(<Fixture />);
  selectPdf([file("private-first.pdf"), file("private-second.pdf")]);
  await waitFor(() => expect(latest.payslips).toHaveLength(2));
  expect(screen.getAllByText(`Datei 1: ${firstIssue}`)).toHaveLength(1);
  expect(screen.getAllByText(`Datei 2: ${secondIssue}`)).toHaveLength(1);
  expect(localStorage.getItem("payroll-test")).not.toContain("private-first.pdf");
});

it("imports complete months but never guesses the gross split of unknown wage code 1509", async () => {
  pdf.parse.mockResolvedValueOnce({
    drafts: [january, { ...january, month: 2, regularGross: undefined, specialGross: undefined }],
    issues: ["Seite 1 (02/2026): Nicht unterstützter Bezugsbestandteil (Lohnart 1509)."],
  });
  render(<Fixture />);
  selectPdf();
  await waitFor(() => expect(latest.payslips).toEqual([january]));
  expect(screen.getByRole("alert").textContent).toContain("nicht übernommen");
  expect(screen.getByRole("alert").textContent).toContain(monthLabel("2026-02"));
  expect(screen.getByText(/Lohnart 1509/)).toBeTruthy();
  expectNoManualInputs();
  expect(screen.queryByRole("button", { name: "Abrechnung übernehmen" })).toBeNull();
});

it.each([
  { ...january, regularGross: undefined, specialGross: undefined },
  { ...january, monthlyPayroll: undefined },
  { ...january, regularTax: 200.123 },
])("does not save an incomplete or invalid upload or offer manual replacement amounts", async (draft) => {
  pdf.parse.mockResolvedValueOnce({ drafts: [draft], issues: [] });
  render(<Fixture />);
  selectPdf();
  expect(await screen.findByText(/Keine Abrechnung übernommen/)).toBeTruthy();
  expect(latest.payslips).toBeUndefined();
  expect(localStorage.getItem("payroll-test")).toBeNull();
  expectNoManualInputs();
});

it("leaves existing records untouched after an unsupported replacement upload", async () => {
  pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, regularGross: undefined }], issues: [] });
  render(<Fixture initial={{ ...seed(), payslips: [january] }} />);
  selectPdf();
  await screen.findByText(/Keine Abrechnung übernommen/);
  expect(latest.payslips).toEqual([january]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("ignores identical uploads and requires only explicit consent for a different same-month PDF", async () => {
  render(<Fixture initial={{ ...seed(), payslips: [january] }} />);
  selectPdf();
  await screen.findByText(/Abrechnungen bereits vorhanden/);
  expect(latest.payslips).toEqual([january]);
  pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, regularGross: 3200 }], issues: [] });
  selectPdf();
  const dialog = within(await screen.findByRole("dialog", { name: "Gespeicherte Abrechnungen ersetzen?" }));
  expect(dialog.queryByRole("spinbutton")).toBeNull();
  expect(latest.payslips?.[0].regularGross).toBe(3000);
  fireEvent.click(dialog.getByRole("button", { name: "Abrechnungen ersetzen" }));
  await waitFor(() => expect(latest.payslips?.[0].regularGross).toBe(3200));
  expect(latest.payslips).toHaveLength(1);
});

it("does not overwrite an existing month when replacement is cancelled", async () => {
  pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, regularGross: 3200 }], issues: [] });
  render(<Fixture initial={{ ...seed(), payslips: [january] }} />);
  selectPdf();
  const dialog = within(await screen.findByRole("dialog", { name: "Gespeicherte Abrechnungen ersetzen?" }));
  fireEvent.click(dialog.getByRole("button", { name: "Abbrechen" }));
  expect(latest.payslips).toEqual([january]);
  expect(localStorage.getItem("payroll-test")).toBeNull();
});

it("does not partially save a batch when a later PDF fails to decrypt", async () => {
  pdf.parse.mockResolvedValueOnce({ drafts: [january], issues: [] })
    .mockRejectedValueOnce(new pdf.PasswordError("PDF-Passwort fehlt."));
  render(<Fixture />);
  selectPdf([file("january.pdf"), file("february.pdf")]);
  await screen.findByText("PDF-Passwort fehlt.");
  expect(latest.payslips).toBeUndefined();
  expect(localStorage.getItem("payroll-test")).toBeNull();
  expect(screen.getByRole("button", { name: "Mit Passwort erneut lesen" })).toBeTruthy();
});

it("asks before replacing a month that appeared while PDF analysis was running", async () => {
  let finish!: (value: { drafts: Payslip[]; issues: string[] }) => void;
  pdf.parse.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  render(<Fixture />);
  selectPdf();
  await waitFor(() => expect(pdf.parse).toHaveBeenCalledOnce());
  act(() => externalUpdate((current) => ({ ...current, payslips: [{ ...january, regularGross: 3500 }] })));
  await act(async () => { finish({ drafts: [january], issues: [] }); });
  expect(screen.getByRole("dialog", { name: "Gespeicherte Abrechnungen ersetzen?" })).toBeTruthy();
  expect(latest.payslips?.[0].regularGross).toBe(3500);
});

it("does not save when a storage failure is reported during PDF analysis", async () => {
  let finish!: (value: { drafts: Payslip[]; issues: string[] }) => void;
  pdf.parse.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const view = render(<Fixture />);
  selectPdf();
  await waitFor(() => expect(pdf.parse).toHaveBeenCalledOnce());
  view.rerender(<Fixture storageError="Speicher voll" />);
  await act(async () => { finish({ drafts: [january], issues: [] }); });
  expect(screen.getByRole("alert").textContent).toContain("Speicher voll");
  expect(latest.payslips).toBeUndefined();
  expect(localStorage.getItem("payroll-test")).toBeNull();
});

it("rejects conflicting duplicate months in the same upload without changing stored data", async () => {
  pdf.parse.mockResolvedValueOnce({ drafts: [january, { ...january, regularGross: 3200 }], issues: [] });
  render(<Fixture />);
  selectPdf();
  await screen.findByText(/Mehrere unterschiedliche Abrechnungen/);
  expect(latest.payslips).toBeUndefined();
});

it("surfaces import errors and prevents reads when local persistence has failed", async () => {
  const view = render(<Fixture />);
  pdf.parse.mockRejectedValueOnce(new Error("Die PDF enthält keinen lesbaren Text."));
  const before = latest;
  selectPdf();
  expect(await screen.findByText("Die PDF enthält keinen lesbaren Text.")).toBeTruthy();
  expect(latest).toBe(before);
  view.unmount();
  render(<Fixture storageError="Speicher voll" />);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "PDF auswählen" }).disabled).toBe(true);
  fireEvent.drop(screen.getByRole("group", { name: "PDF-Ablage für Lohnabrechnungen" }), { dataTransfer: { files: [file()] } });
  expect(pdf.parse).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Speicher voll")).toBeTruthy();
});

it("refreshes actual and projected sixth values immediately after a newer payroll is uploaded", async () => {
  render(<Fixture initial={{ ...seed(), payslips: [january] }} />);
  pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, month: 2, regularGross: 3600 }], issues: [] });
  selectPdf();
  await waitFor(() => expect(latest.payslips).toHaveLength(2));
  const actual = within(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }));
  expect(actual.getAllByText(moneyText(6600)).length).toBeGreaterThan(0);
  const forecast = within(screen.getByRole("region", { name: "Jahressechstel Prognose" }));
  expect(forecast.getAllByText(moneyText(7100)).length).toBeGreaterThan(0);
  expectNoManualInputs();
});

it("shows current and year-end estimates prominently while a missing February blocks actuals and tax", () => {
  const payslips = Array.from({ length: 8 }, (_, index) => ({ ...january, month: index + 1 }))
    .filter((entry) => entry.month !== 2);
  render(<Fixture initial={{ ...seed(), payslips }} />);
  const actual = within(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }));
  expect(actual.getByText("Noch offen")).toBeTruthy();
  const forecast = within(screen.getByRole("region", { name: "Jahressechstel Prognose" }));
  const estimates = forecast.getAllByText(moneyText(6000));
  expect(estimates).toHaveLength(2);
  expect(estimates.every((entry) => !entry.closest("details"))).toBe(true);
  expect(forecast.getByText(monthLabel("2026-09"))).toBeTruthy();
  expect(forecast.getByText("Jahresende · Dezember 2026")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain(`Fehlende Abrechnung: ${monthLabel("2026-02")}`);
  const special = within(screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" }));
  expect(special.getAllByText("Noch offen")).toHaveLength(3);
  expectNoManualInputs();
});

it("removes the technical assumptions and sources block while keeping forecast access", () => {
  render(<Fixture initial={{ ...seed(), payslips: [january] }} />);
  expect(screen.queryByText("Berechnungsdetails, Annahmen & Quellen")).toBeNull();
  expect(screen.queryByText(/Automatisches Standardmodell mit unbestätigten Annahmen/)).toBeNull();
  expect(screen.queryByRole("link", { name: /RIS · § 67/, hidden: true })).toBeNull();
  expect(screen.getByText("Monatliche Prognose anzeigen")).toBeTruthy();
});

it("replaces provisional values with the computed sixth when February closes the historical gap", async () => {
  const payslips = Array.from({ length: 8 }, (_, index) => ({ ...january, month: index + 1 }))
    .filter((entry) => entry.month !== 2);
  render(<Fixture initial={{ ...seed(), payslips }} />);
  pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, month: 2, regularGross: 3600 }], issues: [] });
  selectPdf();
  await waitFor(() => expect(latest.payslips).toHaveLength(8));
  const actual = within(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }));
  expect(actual.getByText(moneyText(6150))).toBeTruthy();
  const forecast = within(screen.getByRole("region", { name: "Jahressechstel Prognose" }));
  expect(forecast.getByText(moneyText(6100))).toBeTruthy();
  expect(screen.queryByText(/Fehlende Abrechnung:/)).toBeNull();
  expect(screen.queryByText("Vorläufig · fehlende Monate geschätzt")).toBeNull();
});

it("automatically saves a recognized February bonus and displays its sixth range without manual fields", async () => {
  const payslips = Array.from({ length: 8 }, (_, index) => ({ ...january, month: index + 1 }))
    .filter((entry) => entry.month !== 2);
  render(<Fixture initial={{ ...seed(), payslips }} />);
  pdf.parse.mockResolvedValueOnce({
    drafts: [{ ...january, month: 2, regularGross: 3050, unresolvedSixthBonus: 1000, specialSv: 141.2 }],
    issues: ["Seite 1 (02/2026): VEB-Prämie erkannt; Sechstelzuordnung bleibt offen."],
  });
  selectPdf();
  await waitFor(() => expect(latest.payslips).toHaveLength(8));
  expect(latest.payslips?.find((entry) => entry.month === 2)?.unresolvedSixthBonus).toBe(1000);
  expect(screen.queryByText(/Fehlende Abrechnung:/)).toBeNull();
  expect(screen.getByText(/Prämie erkannt, Sechstelzuordnung offen/)).toBeTruthy();
  const forecast = within(screen.getByRole("region", { name: "Jahressechstel Prognose" }));
  expect(forecast.getByText(`${moneyText(6011.11)} – ${moneyText(6233.33)}`)).toBeTruthy();
  expect(forecast.getByText(`${moneyText(6008.33)} – ${moneyText(6175)}`)).toBeTruthy();
  expect(screen.getByText(/Datei 1: Seite 1 \(02\/2026\): VEB-Prämie erkannt/).closest("details")?.open).toBe(false);
  expect(within(screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" })).getAllByText("Noch offen")).toHaveLength(3);
  expectNoManualInputs();
});
it("invalidates legacy forecast confirmation after an upload without touching another employer", async () => {
  const initial = { ...seed(), payslips: [january], payrollForecasts: [
    { year: 2026 as const, employer: january.employer, months: [], standardPayrollConfirmed: true },
    { year: 2026 as const, employer: "Anderer Betrieb", months: [], standardPayrollConfirmed: true },
  ] };
  render(<Fixture initial={initial} />);
  pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, month: 2 }], issues: [] });
  selectPdf();
  await waitFor(() => expect(latest.payslips).toHaveLength(2));
  expect(latest.payrollForecasts?.[0].standardPayrollConfirmed).toBe(false);
  expect(latest.payrollForecasts?.[1].standardPayrollConfirmed).toBe(true);
});

it("removes an explicitly selected payroll without changing bank transactions", () => {
  const initial = { ...seed(), payslips: [january], payrollForecasts: [
    { year: 2026 as const, employer: january.employer, months: [], standardPayrollConfirmed: true },
  ] };
  render(<Fixture initial={initial} />);
  fireEvent.click(screen.getByText("Gespeicherte Abrechnungen (1)"));
  fireEvent.click(screen.getByRole("button", { name: "Abrechnung entfernen: 1/2026" }));
  const dialog = within(screen.getByRole("dialog", { name: "Lohnabrechnung entfernen?" }));
  fireEvent.click(dialog.getByRole("button", { name: "Entfernen" }));
  expect(latest.payslips).toEqual([]);
  expect(latest.payrollForecasts).toEqual([]);
  expect(latest.transactions).toEqual(initial.transactions);
});

it("uses a document-derived November scenario instead of old manual forecast overrides", () => {
  render(<Fixture initial={{
    ...seed(), payslips: [january], payrollForecasts: [{
      year: 2026, employer: january.employer, standardPayrollConfirmed: true,
      months: [{ month: 11, regularGross: 9000, specialGross: 9999, specialSv: 680, monthlyTaxableBase: 2460 }],
    }],
  }} />);
  const next = within(screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" }));
  expect(next.getByText(new RegExp(monthLabel("2026-11").replace(".", "\\.")))).toBeTruthy();
  expect(next.getAllByText(moneyText(2800)).length).toBeGreaterThan(0);
  expect(next.queryByText(moneyText(9999))).toBeNull();
  expectNoManualInputs();
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

it("offers a useful empty year without invented zero results or tax cards", () => {
  render(<Fixture />);
  expect(screen.getByText("Noch keine Lohnabrechnungen für 2026")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Jahressechstel Abrechnungsstand" })).toBeNull();
  expect(screen.queryByText("Noch offen")).toBeNull();
  expect(screen.getByRole("link", { name: "Abrechnung hinzufügen" }).getAttribute("href")).toBe("#payroll-import");
  expect(screen.getByRole("region", { name: "Lohnabrechnungen importieren" }).id).toBe("payroll-import");
});

it("shows the existing net special-payment model and never infers it from bank receipts", () => {
  const payslips = bonusPayslips();
  const initial = { ...seed(), payslips };
  render(<Fixture initial={initial} />);
  const view = payrollPresentation(payslips, 2026, january.employer, initial.settings.asOf);
  const special = within(screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" }));
  const net = view.next?.tax?.netSpecial;
  if (net === undefined) throw new Error("Synthetic payroll fixture must have a projected net payment.");
  expect(special.getByText("Geschätzter Auszahlungsanteil netto").nextElementSibling?.textContent).toBe(currency(net));
  expect(special.getByText(/kein bestätigter Auszahlungsbetrag/)).toBeTruthy();
  expect(latest).toBe(initial);
});

it("filters years and employers without merging their payroll data or saving view choices", () => {
  const other: Payslip = { ...january, employer: "Anderer Betrieb", regularGross: 6000 };
  const future: Payslip = { ...january, year: 2027 };
  const initial = { ...seed(), payslips: [january, other, future] };
  render(<Fixture initial={initial} />);
  fireEvent.change(screen.getByLabelText("Dienstverhältnis"), { target: { value: other.employer } });
  expect(within(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" })).getByText(moneyText(12000))).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Steuerjahr"), { target: { value: "2027" } });
  expect(screen.getByLabelText<HTMLSelectElement>("Dienstverhältnis").value).toBe(january.employer);
  expect(within(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" })).getByText(moneyText(6000))).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" })).getAllByText("Noch offen")).toHaveLength(3);
  expect(latest).toBe(initial);
  expect(localStorage.getItem("payroll-test")).toBeNull();
});

it("keeps saved records and optional PDF passwords collapsed without hiding the import action", () => {
  render(<Fixture initial={{ ...seed(), payslips: bonusPayslips() }} />);
  expect(screen.getByText("Gespeicherte Abrechnungen (8)").closest("details")?.open).toBe(false);
  expect(screen.getByLabelText("PDF-Passwort").closest("details")?.open).toBe(false);
  expect(screen.getByRole("button", { name: "PDF auswählen" }).closest("details")).toBeNull();
});
