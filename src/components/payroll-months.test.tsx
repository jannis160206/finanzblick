// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PayrollMonths } from "./payroll-months";
import { payrollEstimate, payrollMonthTiles, payrollPeriod, payrollPresentation } from "./payroll-presentation";
import { currency, monthLabel } from "@/lib/format";
import type { Payslip } from "@/lib/payslip-schema";
import { salaryForecast } from "@/lib/salary-forecast";
import { payrollEmployer, payrollFixture } from "../../tests/fixtures/payroll-state";

afterEach(cleanup);

const january = (): Payslip => payrollFixture().payslips!.find(
  (entry) => entry.employer === payrollEmployer && entry.year === 2026 && entry.month === 1,
)!;
function setup(payslips: Payslip[], asOf = "2026-02-10") {
  const state = payrollFixture();
  const view = payrollPresentation(payslips, 2026, payrollEmployer, asOf);
  const forecast = salaryForecast({ ...state, transactions: [], settings: { ...state.settings, asOf }, payslips });
  return { view, forecast, tiles: payrollMonthTiles({ view, payslips, employer: payrollEmployer, forecast }) };
}
const label = (month: number) => monthLabel(payrollPeriod(2026, month));
const tile = (month: number) => screen.getByRole("button", { name: new RegExp(`^${label(month)},`) });
const openMonth = (month: number) => {
  fireEvent.click(tile(month));
  return within(screen.getByRole("region", { name: label(month) }));
};

it("renders twelve payout months and reveals the expected payout of every forecast month", () => {
  const { view, forecast, tiles } = setup([january()]);
  render(<PayrollMonths year={2026} tiles={tiles} selectedMonth={1} />);
  const list = within(screen.getByRole("list", { name: "Monate 2026" }));
  expect(list.getAllByRole("listitem")).toHaveLength(12);
  // The January payslip is paid out in February.
  expect(list.getAllByRole("listitem")[1].getAttribute("aria-current")).toBe("true");
  expect(tile(2).textContent?.replace(/\s/g, " ")).toContain(`${label(2)}, netto 2.780 €, belegt, Abrechnung ${label(1)}`);
  for (const planned of forecast.months.filter((month) => month.month.startsWith("2026"))) {
    const month = Number(planned.month.slice(5));
    const gross = view.analysis.forecast.months.find((entry) => entry.month === month - 1)!;
    const details = openMonth(month);
    expect(tile(month).getAttribute("aria-expanded")).toBe("true");
    expect(details.getByText(`Abrechnung ${label(month - 1)}`)).toBeTruthy();
    expect(details.getByLabelText(`${label(month)} Netto`).textContent).toBe(currency(planned.total));
    expect(details.getByLabelText(`${label(month)} Gehalt`).textContent).toBe(currency(planned.salary.amount));
    expect(details.getByText(planned.salary.reason)).toBeTruthy();
    expect(details.getByLabelText(`${label(month)} Laufendes Brutto`).textContent).toBe(currency(gross.regularGross));
    expect(details.getByLabelText(`${label(month)} Sonderzahlung brutto`).textContent).toBe(
      gross.specialGross > 0 ? currency(gross.specialGross) : "Keine geplant",
    );
    expect(details.getByLabelText(`${label(month)} Jahressechstel`).textContent).toBe(
      payrollEstimate(view.analysis.sixthEstimates.find((entry) => entry.month === month - 1)),
    );
    expect(details.getByText("geschätzt")).toBeTruthy();
  }
});

it("marks payout months with a special payment and explains the legend", () => {
  const { tiles } = setup([january()]);
  render(<PayrollMonths year={2026} tiles={tiles} />);
  for (const month of [7, 12]) {
    expect(tile(month).textContent).toMatch(/, mit Sonderzahlung/);
    expect(openMonth(month).getByLabelText(`${label(month)} Sonderzahlung brutto`).textContent).not.toBe("Keine geplant");
  }
  expect(tile(3).textContent).not.toMatch(/Sonderzahlung/);
  const legend = within(screen.getByRole("list", { name: "Legende Monatsübersicht" }));
  expect(legend.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["belegt", "geschätzt", "offen", "Sonderzahlung"]);
});

it("shows the payout split, printed values, the sixth of the latest payslip and offers removal", () => {
  const entries: Payslip[] = [
    { ...january(), netPay: 2700, regularSv: undefined },
    { ...january(), month: 2, specialGross: 3000, specialSv: 512.1, specialTax: 148.74, netPay: 5039.16 },
  ];
  const { view, tiles } = setup(entries, "2026-03-10");
  const onRemove = vi.fn();
  render(<PayrollMonths year={2026} tiles={tiles} selectedMonth={2} onRemove={onRemove} />);
  const february = openMonth(2);
  expect(february.getByLabelText(`${label(2)} Netto`).textContent).toBe(currency(2700));
  expect(february.getByLabelText(`${label(2)} Gehalt`).textContent).toBe(currency(2025));
  expect(february.getByLabelText(`${label(2)} Überstunden`).textContent).toBe(currency(675));
  expect(february.getByLabelText(`${label(2)} Laufendes Brutto`).textContent).toBe(currency(4000));
  expect(february.getByLabelText(`${label(2)} Sonderzahlung brutto`).textContent).toBe("Keine");
  expect(february.getByLabelText(`${label(2)} SV`).textContent).toBe("nicht auf der Abrechnung");
  expect(february.queryByLabelText(`${label(2)} Jahressechstel`)).toBeNull();
  const march = openMonth(3);
  expect(screen.queryByRole("region", { name: label(2) })).toBeNull();
  expect(march.getByLabelText(`${label(3)} Sonderzahlung brutto`).textContent).toBe(currency(3000));
  expect(march.getByLabelText(`${label(3)} Lohnsteuer`).textContent).toBe(currency(648.74));
  expect(march.getByLabelText(`${label(3)} Jahressechstel`).textContent).toBe(currency(view.actual!.sixth));
  fireEvent.click(march.getByRole("button", { name: `Abrechnung ${label(2)} entfernen` }));
  expect(onRemove).toHaveBeenCalledWith(entries[1], expect.any(HTMLButtonElement));
});

it("labels a 2025 payslip as reference that never reaches the budget", () => {
  const { tiles } = setup([{ ...january(), year: 2025, month: 12, netPay: 2650 }, january()]);
  render(<PayrollMonths year={2026} tiles={tiles} />);
  expect(tile(1).textContent?.replace(/\s/g, " ")).toContain("netto 2.650 €, Referenz, Abrechnung Dezember 2025");
  const details = openMonth(1);
  expect(details.getByText("Referenz")).toBeTruthy();
  expect(details.getByText("Nur Muster für die Prognose – nicht im Budget.")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Legende Monatsübersicht" })).getByText("Referenz")).toBeTruthy();
});

it("keeps an unknown special-payment model unknown instead of implying zero", () => {
  const { view, tiles } = setup([{ ...january(), baseSalary: undefined }]);
  expect(view.analysis.hasSpecialPaymentModel).toBe(false);
  render(<PayrollMonths year={2026} tiles={tiles} />);
  for (const month of [3, 7, 12]) {
    expect(openMonth(month).getByLabelText(`${label(month)} Sonderzahlung brutto`).textContent).toBe("Noch offen");
  }
  expect(screen.queryByText("Keine geplant")).toBeNull();
});

it("keeps missing and open months out of the tab order and closes details by keyboard", () => {
  const { tiles } = setup([january(), { ...january(), month: 3 }], "2026-04-10");
  render(<PayrollMonths year={2026} tiles={tiles} />);
  const rows = within(screen.getByRole("list", { name: "Monate 2026" })).getAllByRole("listitem");
  expect(within(rows[0]).queryByRole("button")).toBeNull();
  expect(rows[0].textContent).toContain(`${label(1)}, noch keine Abrechnung`);
  expect(within(rows[2]).queryByRole("button")).toBeNull();
  expect(rows[2].textContent).toContain(`${label(3)}, Abrechnung ${label(2)} fehlt`);
  const may = tile(5);
  fireEvent.click(may);
  expect(screen.getByRole("region", { name: label(5) }).closest(`#${may.getAttribute("aria-controls")}`)).toBeTruthy();
  fireEvent.keyDown(may, { key: "Escape" });
  expect(screen.queryByRole("region", { name: label(5) })).toBeNull();
  expect(may.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(may);
  fireEvent.click(screen.getByRole("button", { name: "Monatsdetails schließen" }));
  expect(screen.queryByRole("region", { name: label(5) })).toBeNull();
  expect(document.activeElement).toBe(may);
  fireEvent.click(may);
  fireEvent.click(may);
  expect(screen.queryByRole("region", { name: label(5) })).toBeNull();
});
