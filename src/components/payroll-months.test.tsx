// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PayrollMonths } from "./payroll-months";
import { payrollEstimate, payrollPeriod, payrollPresentation } from "./payroll-presentation";
import { currency, monthLabel } from "@/lib/format";
import type { Payslip } from "@/lib/payslip-schema";
import { payrollEmployer, payrollFixture } from "../../tests/fixtures/payroll-state";

afterEach(cleanup);

function januaryEntries(): Payslip[] {
  return payrollFixture().payslips!.filter(
    (entry) => entry.employer === payrollEmployer && entry.year === 2026 && entry.month === 1,
  );
}
const januaryView = (entries = januaryEntries()) =>
  payrollPresentation(entries, 2026, payrollEmployer, payrollFixture().settings.asOf);
const label = (month: number) => monthLabel(payrollPeriod(2026, month));
const tile = (month: number) => screen.getByRole("button", { name: new RegExp(`^${label(month)},`) });
const openMonth = (month: number) => {
  fireEvent.click(tile(month));
  return within(screen.getByRole("region", { name: label(month) }));
};

it("renders twelve tiles and reveals every forecast month's unchanged values on demand", () => {
  const entries = januaryEntries();
  const view = januaryView(entries);
  const before = structuredClone(view);
  render(<PayrollMonths view={view} entries={entries} selectedMonth={1} />);
  const list = within(screen.getByRole("list", { name: "Monate 2026" }));
  expect(list.getAllByRole("listitem")).toHaveLength(12);
  expect(list.getAllByRole("listitem")[0].getAttribute("aria-current")).toBe("true");
  expect(list.getAllByRole("button")).toHaveLength(12);
  expect(view.projectedMonths).toHaveLength(11);
  for (const month of view.projectedMonths) {
    const name = label(month.month);
    const forecast = view.analysis.forecast.months.find((entry) => entry.month === month.month)!;
    expect(tile(month.month).getAttribute("aria-expanded")).toBe("false");
    const details = openMonth(month.month);
    expect(tile(month.month).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("region")).toHaveLength(2);
    expect(details.getByLabelText(`${name} Laufendes Brutto`).textContent).toBe(currency(forecast.regularGross));
    expect(details.getByLabelText(`${name} Sonderzahlung`).textContent).toBe(
      forecast.specialGross > 0 ? currency(forecast.specialGross) : "Keine geplant",
    );
    expect(details.getByLabelText(`${name} Jahressechstel`).textContent).toBe(payrollEstimate(month));
    expect(details.getByText("geschätzt")).toBeTruthy();
  }
  expect(view).toEqual(before);
});

it("marks only modelled special-payment months and labels forecast amounts as gross", () => {
  const entries = januaryEntries();
  render(<PayrollMonths view={januaryView(entries)} entries={entries} />);
  for (const month of [6, 11]) {
    expect(tile(month).textContent).toMatch(/, mit Sonderzahlung/);
    expect(openMonth(month).getAllByText("Sonderzahlung")).toHaveLength(2);
  }
  expect(tile(2).textContent?.replace(/\s/g, " ")).toContain(`${label(2)}, brutto 4.000 €, geschätzt`);
  expect(tile(2).textContent).not.toMatch(/Sonderzahlung/);
  expect(openMonth(2).getAllByText("Sonderzahlung")).toHaveLength(1);
  const legend = within(screen.getByRole("list", { name: "Legende Monatsübersicht" }));
  expect(legend.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["belegt", "geschätzt", "Sonderzahlung"]);
});

it("shows documented values, unknown printed values and the sixth only for the latest payslip", () => {
  const entries: Payslip[] = [
    { ...januaryEntries()[0], netPay: 2700, regularSv: undefined },
    { ...januaryEntries()[0], month: 2, specialGross: 3000, specialSv: 512.1, specialTax: 148.74, netPay: 5039.16 },
  ];
  const view = januaryView(entries);
  render(<PayrollMonths view={view} entries={entries} selectedMonth={2} />);
  expect(tile(1).textContent?.replace(/\s/g, " ")).toContain(`${label(1)}, netto 2.700 €, belegt`);
  const january = openMonth(1);
  expect(january.getByLabelText(`${label(1)} Netto`).textContent).toBe(currency(2700));
  expect(january.getByLabelText(`${label(1)} Laufendes Brutto`).textContent).toBe(currency(4000));
  expect(january.getByLabelText(`${label(1)} Sonderzahlung`).textContent).toBe("Keine");
  expect(january.getByLabelText(`${label(1)} Lohnsteuer`).textContent).toBe(currency(500));
  expect(january.getByLabelText(`${label(1)} SV`).textContent).toBe("nicht auf der Abrechnung");
  expect(january.queryByLabelText(`${label(1)} Jahressechstel`)).toBeNull();
  const february = openMonth(2);
  expect(screen.queryByRole("region", { name: label(1) })).toBeNull();
  expect(february.getByLabelText(`${label(2)} Sonderzahlung`).textContent).toBe(currency(3000));
  expect(february.getByLabelText(`${label(2)} Lohnsteuer`).textContent).toBe(currency(648.74));
  expect(february.getByLabelText(`${label(2)} Jahressechstel`).textContent).toBe(currency(view.actual!.sixth));
  expect(february.getByText("belegt")).toBeTruthy();
});

it("keeps an unknown special-payment model unknown instead of implying zero", () => {
  const entries = [{ ...januaryEntries()[0], baseSalary: undefined }];
  const view = payrollPresentation(entries, 2026, payrollEmployer, "2026-10-08");
  expect(view.analysis.hasSpecialPaymentModel).toBe(false);
  render(<PayrollMonths view={view} entries={entries} />);
  for (const month of view.projectedMonths) {
    expect(openMonth(month.month).getByLabelText(`${label(month.month)} Sonderzahlung`).textContent).toBe("Noch offen");
  }
  expect(screen.queryByText("Keine geplant")).toBeNull();
});

it("preserves uncertainty ranges and does not invent a missing monthly gross", () => {
  const entries = januaryEntries();
  const view = januaryView(entries);
  view.analysis.sixthEstimates = view.analysis.sixthEstimates.map((month) => ({ ...month, sixthUpper: month.sixth + 123.45 }));
  view.analysis.forecast.months = [];
  render(<PayrollMonths view={view} entries={entries} />);
  expect(tile(2).textContent).toContain(`${label(2)}, geschätzt`);
  const february = openMonth(2);
  expect(february.getByLabelText(`${label(2)} Laufendes Brutto`).textContent).toBe("Noch offen");
  expect(february.getByLabelText(`${label(2)} Sonderzahlung`).textContent).toBe("Noch offen");
  expect(february.getByLabelText(`${label(2)} Jahressechstel`).textContent).toBe(
    payrollEstimate(view.analysis.sixthEstimates.find((month) => month.month === 2)),
  );
});

it("keeps missing and open months out of the tab order and closes details by keyboard", () => {
  const base = januaryEntries()[0];
  const entries = [base, { ...base, month: 3 }];
  const view = januaryView(entries);
  view.analysis.forecast.months = view.analysis.forecast.months.filter((month) => month.month < 6);
  view.analysis.sixthEstimates = view.analysis.sixthEstimates.filter((month) => month.month < 6);
  render(<PayrollMonths view={view} entries={entries} />);
  const rows = within(screen.getByRole("list", { name: "Monate 2026" })).getAllByRole("listitem");
  expect(within(rows[1]).queryByRole("button")).toBeNull();
  expect(rows[1].textContent).toContain(`${label(2)}, Abrechnung fehlt`);
  expect(within(rows[6]).queryByRole("button")).toBeNull();
  expect(rows[6].textContent).toContain(`${label(7)}, noch keine Abrechnung`);
  const april = tile(4);
  fireEvent.click(april);
  expect(screen.getByRole("region", { name: label(4) }).closest(`#${april.getAttribute("aria-controls")}`)).toBeTruthy();
  fireEvent.keyDown(april, { key: "Escape" });
  expect(screen.queryByRole("region", { name: label(4) })).toBeNull();
  expect(april.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(april);
  fireEvent.click(screen.getByRole("button", { name: "Monatsdetails schließen" }));
  expect(screen.queryByRole("region", { name: label(4) })).toBeNull();
  expect(document.activeElement).toBe(april);
  fireEvent.click(april);
  fireEvent.click(april);
  expect(screen.queryByRole("region", { name: label(4) })).toBeNull();
});
