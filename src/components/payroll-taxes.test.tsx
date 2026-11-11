// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
const monthOptions = () => {
  fireEvent.click(screen.getByLabelText("Monat"));
  return screen.getAllByRole("option");
};

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
const importLog = () => JSON.parse(localStorage.getItem("finanzblick.payslip-log") ?? "[]") as { source: string; issues?: string[]; files?: { name: string }[]; message: string }[];
function expectNoManualInputs() {
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Abrechnung manuell ergänzen" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Abrechnung bearbeiten/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Prognose anpassen" })).toBeNull();
  expect(screen.queryByText(/Manuelle Jahressechstel-Berechnung/)).toBeNull();
}

// The bonus-room tests look at the room itself: without the Successbonus reserved for December.
const withoutBonus = () => {
  const state = seed();
  state.settings.successBonusPercent = 0;
  return state;
};
const bonusPayslips = () => Array.from({ length: 8 }, (_, index) => ({
  ...january, month: index + 1, regularGross: 4000, baseSalary: 3000,
  monthlyTaxableBase: 3200, regularTax: 500,
  ...(index === 5 ? { specialGross: 3000, specialSv: 512.1 } : {}),
}));

it("shows additional gross bonus room with the isolated tariff example collapsed by default", () => {
  render(<Fixture initial={{ ...withoutBonus(), payslips: bonusPayslips() }} />);
  const bonus = within(screen.getByRole("region", { name: "Zusätzlicher Prämien-Spielraum" }));
  expect(bonus.getByText(moneyText(2000))).toBeTruthy();
  expect(bonus.getByText(/Auszahlung im November 2026/)).toBeTruthy();
  expect(bonus.getByText("Geplante Sonderzahlungen").parentElement?.textContent).toContain(currency(3000));
  const example = within(bonus.getByRole("group", { name: "Steuerbeispiel Zusatzprämie" }));
  const disclosure = bonus.getByRole<HTMLDetailsElement>("group", { name: "Steuerbeispiel" });
  expect(bonus.getByRole("group", { name: "Steuerbeispiel Zusatzprämie" }).closest("details")).toBe(disclosure);
  expect(disclosure.open).toBe(false);
  const summary = disclosure.querySelector("summary")!;
  expect(summary.textContent?.replace(/\s/g, " ")).toBe(`+${moneyText(1000)} bruttoergibt${moneyText(497.58)} netto·${moneyText(331.72)} Steuer`);
  fireEvent.click(summary);
  expect(disclosure.open).toBe(true);
  expect(example.getByText("40 %")).toBeTruthy();
  for (const value of [170.7, 331.72, 502.42, 497.58]) expect(example.getByText(moneyText(value))).toBeTruthy();
  expectNoManualInputs();
});

it("shows a conservative bonus range when February's sixth classification is unresolved", () => {
  const payslips = bonusPayslips().map((entry) => entry.month === 2
    ? { ...entry, unresolvedSixthBonus: 1000, specialSv: 141.2 } : entry);
  render(<Fixture initial={{ ...withoutBonus(), payslips }} />);
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
  render(<Fixture initial={{ ...withoutBonus(), payslips: bonusPayslips() }} />);
  pdf.parse.mockResolvedValueOnce({ drafts: [{
    ...january, month: 9, regularGross: 5000, baseSalary: 3000, monthlyTaxableBase: 4000, regularTax: 700,
  }], issues: [] });
  selectPdf();
  await waitFor(() => expect(latest.payslips).toHaveLength(9));
  const bonus = within(screen.getByRole("region", { name: "Zusätzlicher Prämien-Spielraum" }));
  expect(bonus.getByText(moneyText(2545.45))).toBeTruthy();
  expectNoManualInputs();
});

it("reserves the Successbonus, names the Austrian tax logic and estimates the taxes of forecast months", () => {
  render(<Fixture initial={{ ...seed(), payslips: bonusPayslips() }} />);
  const bonus = within(screen.getByRole("region", { name: "Zusätzlicher Prämien-Spielraum" }));
  // November's Grundgehalt and 138,5 % of it with the December payslip use up the sixth.
  expect(bonus.getByText("Geplante Sonderzahlungen").parentElement?.textContent).toContain(currency(3000 + 4155));
  expect(bonus.queryByText(moneyText(2000))).toBeNull();
  const focus = within(screen.getByRole("region", { name: /^Gehalt / }));
  expect(focus.getByText("Lohnsteuertarif AT 2026 · progressiv + Absetzbeträge lt. Abrechnung")).toBeTruthy();
  expect(screen.queryByText(/Steuerklasse/)).toBeNull();
  // 6 % of November's special payment after SV, estimated with the learned tax credits.
  const special = within(screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" }));
  expect(special.getByText(moneyText(149.27))).toBeTruthy();
});

it("splits every special payment into the part taxed at 6 % and the part taxed fully by the tariff", () => {
  const payslips = bonusPayslips().map((entry) => entry.month === 6 ? { ...entry, specialTax: 112.07 } : entry);
  render(<Fixture initial={{ ...seed(), payslips }} />);
  const card = within(screen.getByRole("region", { name: "Besteuerung je Sonderzahlung" }));
  expect(card.getByText("Jahressechstel 2026 · 6 % im Sechstel, darüber Tarif")).toBeTruthy();
  const text = (node: Element | null) => node?.textContent?.replace(/\s/g, " ") ?? "";
  const rows = card.getAllByRole("listitem");
  expect(rows.map((row) => text(row.querySelector("summary")))).toEqual([
    `UrlaubszuschussJuni-Abrechnung · belegt${moneyText(3000)}brutto${moneyText(3000)}zu 6 %`,
    `WeihnachtsremunerationNovember-Abrechnung · geschätzt${moneyText(3000)}brutto${moneyText(3000)}zu 6 %`,
    // The sixth of 8.000 € leaves 2.000 € after June and November; the rest of the 4.155 € bonus is taxed by the tariff.
    `SuccessbonusDezember-Abrechnung · geschätzt${moneyText(4155)}brutto${moneyText(2000)}zu 6 %${moneyText(2155)}voll versteuert`,
  ]);
  const june = within(rows[0]);
  expect(text(june.getByRole("row", { name: /620-€-Freibetrag/ }))).toBe(`620-€-Freibetrag · 0 %${moneyText(620)}${moneyText(0)}`);
  expect(text(june.getByRole("row", { name: /^6 %/ }))).toBe(`6 %${moneyText(1867.9)}${moneyText(112.07)}`);
  expect(june.getByText("wie Abrechnung")).toBeTruthy();
  const december = within(rows[2]);
  expect(text(december.getByText(/^Sechstel/).parentElement)).toBe(`Sechstel ${moneyText(8000)}·davor genutzt ${moneyText(6000)}·frei ${moneyText(2000)}`);
  expect(text(december.getByRole("row", { name: /^6 %/ }))).toBe(`6 %${moneyText(1658.6)}${moneyText(99.52)}`);
  expect(december.getByRole("row", { name: /^Tarif · Ø \d+(,\d)? %/ })).toBeTruthy();
  expect(december.queryByRole("row", { name: /Freibetrag/ })).toBeNull();
});

it("automatically imports selected PDFs without a form and keeps bank data untouched", async () => {
  render(<Fixture />);
  const before = latest;
  expectNoManualInputs();
  expect(screen.queryByRole("group", { name: "PDF-Ablage für Lohnabrechnungen" })).toBeNull();
  expect(screen.queryByRole("button", { name: "PDF auswählen" })).toBeNull();
  expect(pdf.parse).not.toHaveBeenCalled();
  selectPdf();
  await waitFor(() => expect(latest.payslips).toEqual([january]));
  expect(pdf.parse).toHaveBeenCalledWith(expect.any(ArrayBuffer));
  expect(latest.transactions).toEqual(before.transactions);
  expect(latest.financeRows).toEqual(before.financeRows.map((row) => row.id === "income-salary"
    ? { ...row, values: { ...row.values, "2026-02": 2260 } } : row));
  expect(screen.queryByRole("dialog")).toBeNull();
  expectNoManualInputs();
  const actual = within(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }));
  expect(actual.getAllByText(moneyText(6000)).length).toBeGreaterThan(0);
  expect(actual.getByText(`Stand: ${monthLabel("2026-01")}`)).toBeTruthy();
  expect(screen.getByLabelText("Monat").textContent).toBe("Jänner, importiert");
  expect(screen.getByRole("region", { name: `Gehalt ${monthLabel("2026-01")}` })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Monatsübersicht" })).toBeNull();
});

it("asks for the password of a protected PDF in a dialog and never stores it", async () => {
  pdf.parse.mockRejectedValueOnce(new pdf.PasswordError("Bitte das PDF-Passwort eingeben."));
  render(<Fixture />);
  const before = latest;
  selectPdf();
  const dialog = within(await screen.findByRole("dialog", { name: "Geschützte Abrechnung" }));
  expect(latest).toBe(before);
  expect(dialog.queryByRole("switch")).toBeNull();
  expect(dialog.getByText("payroll.pdf")).toBeTruthy();
  const field = dialog.getByLabelText("PDF-Passwort");
  expect(field.getAttribute("type")).toBe("password");
  fireEvent.click(dialog.getByRole("button", { name: "Passwort anzeigen" }));
  expect(field.getAttribute("type")).toBe("text");
  fireEvent.change(field, { target: { value: "test-password" } });
  fireEvent.click(dialog.getByRole("button", { name: "Öffnen" }));
  await waitFor(() => expect(latest.payslips).toEqual([january]));
  expect(pdf.parse).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), "test-password");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(localStorage.getItem("payroll-test")).not.toContain("test-password");
  expectNoManualInputs();
});

it("uses one password for several protected PDFs and keeps the dialog open for a wrong one", async () => {
  const february = { ...january, month: 2 };
  pdf.parse.mockRejectedValueOnce(new pdf.PasswordError("locked")).mockRejectedValueOnce(new pdf.PasswordError("locked"))
    .mockRejectedValueOnce(new pdf.PasswordError("wrong")).mockRejectedValueOnce(new pdf.PasswordError("wrong"))
    .mockResolvedValueOnce({ drafts: [january], issues: [] }).mockResolvedValueOnce({ drafts: [february], issues: [] });
  render(<Fixture />);
  selectPdf([file("januar.pdf"), file("februar.pdf")]);
  const dialog = within(await screen.findByRole("dialog", { name: "2 geschützte Abrechnungen" }));
  const together = dialog.getByRole("switch", { name: "Passwort für alle Dateien verwenden?" });
  expect(together.getAttribute("aria-checked")).toBe("true");
  fireEvent.change(dialog.getByLabelText("PDF-Passwort"), { target: { value: "falsch" } });
  fireEvent.click(dialog.getByRole("button", { name: "Öffnen" }));
  expect(await dialog.findByText("Passwort falsch – bitte erneut eingeben.")).toBeTruthy();
  expect(dialog.getAllByText("Passwort falsch")).toHaveLength(2);
  expect(latest.payslips).toBeUndefined();
  fireEvent.change(dialog.getByLabelText("PDF-Passwort"), { target: { value: "richtig" } });
  fireEvent.click(dialog.getByRole("button", { name: "Öffnen" }));
  await waitFor(() => expect(latest.payslips).toEqual([january, february]));
  expect(pdf.parse).toHaveBeenNthCalledWith(5, expect.any(ArrayBuffer), "richtig");
  expect(pdf.parse).toHaveBeenNthCalledWith(6, expect.any(ArrayBuffer), "richtig");
});

it("asks for one password per file when the shared password is switched off", async () => {
  const february = { ...january, month: 2 };
  pdf.parse.mockRejectedValueOnce(new pdf.PasswordError("locked")).mockRejectedValueOnce(new pdf.PasswordError("locked"))
    .mockResolvedValueOnce({ drafts: [january], issues: [] }).mockResolvedValueOnce({ drafts: [february], issues: [] });
  render(<Fixture />);
  selectPdf([file("januar.pdf"), file("februar.pdf")]);
  const dialog = within(await screen.findByRole("dialog", { name: "2 geschützte Abrechnungen" }));
  fireEvent.click(dialog.getByRole("switch", { name: "Passwort für alle Dateien verwenden?" }));
  expect(dialog.queryByLabelText("PDF-Passwort")).toBeNull();
  fireEvent.change(dialog.getByLabelText("Passwort für januar.pdf"), { target: { value: "eins" } });
  expect(dialog.getByRole<HTMLButtonElement>("button", { name: "Öffnen" }).disabled).toBe(true);
  fireEvent.change(dialog.getByLabelText("Passwort für februar.pdf"), { target: { value: "zwei" } });
  fireEvent.click(dialog.getByRole("button", { name: "Öffnen" }));
  await waitFor(() => expect(latest.payslips).toEqual([january, february]));
  expect(pdf.parse).toHaveBeenNthCalledWith(3, expect.any(ArrayBuffer), "eins");
  expect(pdf.parse).toHaveBeenNthCalledWith(4, expect.any(ArrayBuffer), "zwei");
});

it("attributes deduplicated document warnings while automatically importing valid values", async () => {
  const firstIssue = "Seite 1 (01/2026): Kontrollwert nicht eindeutig lesbar.";
  const secondIssue = "Seite 1 (02/2026): Kontrollwert nicht eindeutig lesbar.";
  pdf.parse.mockResolvedValueOnce({ drafts: [january], issues: [firstIssue, firstIssue] });
  pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, month: 2 }], issues: [secondIssue] });
  render(<Fixture />);
  selectPdf([file("private-first.pdf"), file("private-second.pdf")]);
  await waitFor(() => expect(latest.payslips).toHaveLength(2));
  // Import hints go to the JSON log, not onto the page.
  expect(screen.queryByText(/Kontrollwert/)).toBeNull();
  await waitFor(() => expect(importLog()).toHaveLength(1));
  const [entry] = importLog();
  expect(entry.issues).toEqual([`Datei 1: ${firstIssue}`, `Datei 2: ${secondIssue}`]);
  expect(entry.files?.map((item) => item.name)).toEqual(["private-first.pdf", "private-second.pdf"]);
  expect(entry.source).toBe("upload");
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
  expect(screen.getByRole("alert").textContent).toBe("1 Abrechnung nicht übernommen · Import-Protokoll");
  expect(screen.getByRole("link", { name: "Import-Protokoll" }).getAttribute("href")).toBe("/einstellungen#import-protokoll");
  expect(screen.queryByText(/Lohnart 1509/)).toBeNull();
  await waitFor(() => expect(importLog()[0]?.issues?.[0]).toMatch(/Lohnart 1509/));
  // The toast only counts; which payslip went to which month with which net is in the import log.
  const { toast } = await import("sonner");
  expect(vi.mocked(toast.success).mock.calls.at(-1)?.[0]).toBe("1 Abrechnung übernommen");
  expect(importLog()[0]).toMatchObject({ message: "1 Abrechnung übernommen", income: [{ payroll: "2026-01", month: "2026-02", net: 2260 }] });
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
  await screen.findByText("Bereits vorhanden – nichts doppelt übernommen");
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

it("saves nothing while a later PDF waits for its password and imports the rest after skipping it", async () => {
  const { toast } = await import("sonner");
  pdf.parse.mockResolvedValueOnce({ drafts: [january], issues: [] })
    .mockRejectedValueOnce(new pdf.PasswordError("PDF-Passwort fehlt."));
  render(<Fixture />);
  selectPdf([file("january.pdf"), file("february.pdf")]);
  const dialog = within(await screen.findByRole("dialog", { name: "Geschützte Abrechnung" }));
  expect(dialog.getByText("february.pdf")).toBeTruthy();
  expect(dialog.queryByText("january.pdf")).toBeNull();
  expect(latest.payslips).toBeUndefined();
  expect(localStorage.getItem("payroll-test")).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Überspringen" }));
  await waitFor(() => expect(latest.payslips).toEqual([january]));
  expect(vi.mocked(toast.success).mock.calls.at(-1)?.[0]).toBe("1 Abrechnung übernommen · 1 ohne Passwort");
  expect(pdf.parse).toHaveBeenCalledTimes(2);
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
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Abrechnungen hochladen" }).disabled).toBe(true);
  selectPdf();
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
  expect(estimates.every((entry) => entry.closest("details") === null)).toBe(true);
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
  // All twelve months are listed; only the imported January can be chosen.
  const options = monthOptions();
  expect(options).toHaveLength(12);
  expect(options.filter((option) => option.getAttribute("aria-disabled") === "true")).toHaveLength(11);
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
  await waitFor(() => expect(importLog()[0]?.issues).toEqual(["Datei 1: Seite 1 (02/2026): VEB-Prämie erkannt; Sechstelzuordnung bleibt offen."]));
  // The glossary explains the term; without consent nothing is looked up online.
  expect((importLog()[0] as { lookups?: unknown[] }).lookups).toEqual(expect.arrayContaining([
    expect.objectContaining({ term: "VEB-Prämie", source: "glossar" }), { term: "VEB-Prämie", source: "nicht-nachgeschlagen" },
  ]));
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
  fireEvent.click(screen.getByRole("button", { name: `Abrechnung ${monthLabel("2026-01")} entfernen` }));
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
  expect(screen.getByRole("button", { name: "Abrechnungen hochladen" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Abrechnungen" })).toBeNull();
  expect(screen.queryByLabelText("PDF-Passwort")).toBeNull();
});

it("shows the existing net special-payment model and never infers it from bank receipts", () => {
  const payslips = bonusPayslips();
  const initial = { ...seed(), payslips };
  render(<Fixture initial={initial} />);
  const view = payrollPresentation(payslips, 2026, january.employer, initial.settings.asOf);
  const special = within(screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" }));
  const net = view.next?.tax?.netSpecial;
  if (net === undefined) throw new Error("Synthetic payroll fixture must have a projected net payment.");
  expect(special.getByText("Geschätzter Auszahlungsanteil netto").closest("div")?.querySelector("dd")?.textContent).toBe(currency(net));
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

it("shows a short summary instead of records, read values or the Steuer-Mappe and keeps the upload action in the header", () => {
  render(<Fixture initial={{ ...seed(), payslips: bonusPayslips() }} />);
  const summary = within(screen.getByRole("region", { name: "Abrechnungen" }));
  expect(summary.getByRole("heading", { name: "8 Abrechnungen übernommen" })).toBeTruthy();
  expect(summary.getByText(`zuletzt ${monthLabel("2026-08")}`)).toBeTruthy();
  expect(summary.getByRole("button", { name: "Erneut prüfen" })).toBeTruthy();
  for (const removed of [/Gespeicherte Abrechnungen/, /Automatisch gelesene Werte/, /Importhinweise/, /Steuer-Mappe/, /Spenden/])
    expect(screen.queryByText(removed)).toBeNull();
  expect(screen.queryByLabelText("PDF-Passwort")).toBeNull();
  expect(screen.queryByText("Passwortgeschützte PDF")).toBeNull();
  expect(screen.getByRole("button", { name: "Abrechnungen hochladen" }).closest("[role=group]")?.getAttribute("aria-label")).toBe("Abrechnungsauswahl");
});

it("re-applies stored payslips to the budget on \"Erneut prüfen\" and logs the check", async () => {
  const initial = { ...seed(), payslips: [january] };
  render(<Fixture initial={initial} />);
  expect(latest.financeRows.find((row) => row.id === "income-salary")?.values["2026-02"]).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Erneut prüfen" }));
  await waitFor(() => expect(latest.financeRows.find((row) => row.id === "income-salary")?.values["2026-02"]).toBe(2260));
  expect(await screen.findByText("1 Abrechnung abgeglichen")).toBeTruthy();
  await waitFor(() => expect(importLog().map((entry) => entry.source)).toEqual(["recheck"]));
  expect(latest.payslips).toEqual([january]);
});

it("keeps an uploaded 2025 payslip as reference: stored, counted in the summary, never in the budget", async () => {
  const december: Payslip = { ...january, year: 2025, month: 12, netPay: 2300 };
  pdf.parse.mockResolvedValueOnce({ drafts: [december], issues: [] });
  const initial = { ...seed(), payslips: [january] };
  render(<Fixture initial={initial} />);
  selectPdf();
  await waitFor(() => expect(latest.payslips).toHaveLength(2));
  expect(latest.financeRows).toEqual(initial.financeRows);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(await screen.findByText("1 Abrechnung als Referenz übernommen")).toBeTruthy();
  expect(screen.getByLabelText<HTMLSelectElement>("Steuerjahr").value).toBe("2026");
  expect(screen.getByLabelText("Monat").textContent).toBe("Jänner, importiert");
  expect(within(screen.getByRole("region", { name: "Abrechnungen" })).getByText(/1 aus 2025 als Referenz/)).toBeTruthy();
});

it("keeps a contradicting payslip out of the budget, marks it for review and takes it in after confirmation", async () => {
  // Gross minus SV and tax is 2.260 €, but the payslip prints 2.700 € net.
  const broken: Payslip = { ...january, netPay: 2700 };
  pdf.parse.mockResolvedValueOnce({ drafts: [broken], issues: [] });
  const initial = seed();
  render(<Fixture initial={initial} />);
  selectPdf();
  await waitFor(() => expect(latest.payslips).toEqual([broken]));
  expect(latest.financeRows).toEqual(initial.financeRows);
  expect(await screen.findByText("1 Abrechnung übernommen · 1 zur Prüfung")).toBeTruthy();
  const [entry] = importLog();
  expect(entry).toMatchObject({ validation: [expect.objectContaining({ period: "2026-01", consistent: false, held: true })] });
  const summary = within(screen.getByRole("region", { name: "Abrechnungen" }));
  expect(summary.getByRole("heading", { name: "Noch keine Abrechnung übernommen" })).toBeTruthy();
  expect(screen.getByLabelText("Monat").textContent).toBe("Jänner, zur Prüfung");
  fireEvent.click(summary.getByRole("button", { name: "Abrechnung Jän. 2026 prüfen" }));
  const card = screen.getByRole("region", { name: `Gehalt ${monthLabel("2026-01")}` });
  await waitFor(() => expect(document.activeElement).toBe(card));
  const details = within(card);
  expect(details.getByRole("note").textContent).toMatch(/Nicht im Budget – die Zahlen passen nicht zusammen.*gedruckt sind 2\.700,00\s€ Netto/);
  fireEvent.click(details.getByRole("button", { name: "Ins Budget übernehmen" }));
  await waitFor(() => expect(latest.financeRows.find((row) => row.id === "income-salary")?.values["2026-02"]).toBe(2700));
  expect(latest.payrollBudget?.confirmed).toHaveLength(1);
  expect(screen.getByLabelText("Monat").textContent).toBe("Jänner, importiert");
  expect(details.queryByRole("note")).toBeNull();
  expect(details.queryByRole("button", { name: "Ins Budget übernehmen" })).toBeNull();
  expect(summary.queryByRole("button", { name: /^Abrechnung .* prüfen$/ })).toBeNull();
  expect(summary.getByRole("heading", { name: "1 Abrechnung übernommen" })).toBeTruthy();
});

it("looks up an unclear term on Wikipedia after the import only when allowed", async () => {
  const fetcher = vi.fn(async () => Response.json({ hit: { topic: "VEB-Prämie", title: "Prämie", text: "Eine Prämie …", url: "https://de.wikipedia.org/wiki/Pr%C3%A4mie", source: "Wikipedia" } }));
  vi.stubGlobal("fetch", fetcher);
  try {
    pdf.parse.mockResolvedValueOnce({ drafts: [{ ...january, month: 2 }], issues: ["Seite 1 (02/2026): VEB-Prämie erkannt."] });
    const initial = seed();
    initial.settings.payslipTermLookup = true;
    render(<Fixture initial={initial} />);
    selectPdf();
    await waitFor(() => expect(importLog()).toHaveLength(1));
    expect(fetcher).toHaveBeenCalledWith("/api/knowledge?q=VEB-Pr%C3%A4mie", expect.objectContaining({ cache: "no-store" }));
    expect((importLog()[0] as { lookups?: unknown[] }).lookups).toContainEqual({ term: "VEB-Prämie", source: "wikipedia", title: "Prämie", text: "Eine Prämie …", url: "https://de.wikipedia.org/wiki/Pr%C3%A4mie" });
  } finally {
    vi.unstubAllGlobals();
  }
});
