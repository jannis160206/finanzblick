// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PayrollYearCard } from "@/components/payroll-year";
import { PayrollTaxes } from "@/components/payroll-taxes";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import { currency } from "@/lib/format";
import type { Payslip, PayrollForecastMonth } from "@/lib/payslip-schema";
import type { AppState } from "@/lib/types";

vi.mock("@/lib/import/payslip", () => ({ parsePayslipPdf: vi.fn(), PayslipPasswordError: class extends Error {} }));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);

const base: Payslip = {
  year: 2026, month: 1, employer: "Musterbetrieb GmbH", regularGross: 4000, specialGross: 0,
  regularSv: 720, regularTax: 500, netPay: 2700, baseSalary: 3000, monthlyPayroll: true,
};
const money = (value: number) => currency(value).replace(/\s/g, " ");
const entries: Payslip[] = [
  base,
  { ...base, month: 3, netPay: undefined },
  { ...base, month: 4, specialGross: 3000, specialSv: 512.1, specialTax: 148.74, netPay: 5039.16 },
];
const forecast: PayrollForecastMonth[] = [5, 6, 7, 8, 9, 10, 11, 12].map((month) => ({
  month, regularGross: 4000, specialGross: month === 6 ? 3000 : 0,
}));

it("sums the documented year, names how many months a total covers and the average deduction rate", () => {
  render(<PayrollYearCard year={2026} entries={entries} forecast={forecast} selectedMonth={4} onSelectMonth={vi.fn()} />);
  const card = within(screen.getByRole("region", { name: "Jahr bisher" }));
  expect(card.getByText("3 Monate mit Abrechnung")).toBeTruthy();
  const figure = (label: string) => within(card.getByText(label, { selector: "dt" }).parentElement!);
  expect(figure("Brutto").getByText(money(15000))).toBeTruthy();
  expect(figure("Netto").getByText(money(7739.16))).toBeTruthy();
  expect(figure("Netto").getByText("aus 2 Monaten")).toBeTruthy();
  expect(figure("Lohnsteuer").getByText(money(1648.74))).toBeTruthy();
  expect(figure("Lohnsteuer").queryByText(/aus/)).toBeNull();
  expect(card.getByText(/^29,6\s%$/)).toBeTruthy();
  expect(card.getByRole("button", { name: "Info: Durchschnittliche Abzüge" })).toBeTruthy();
});

it("renders twelve month columns with accessible labels and selects a documented month on click", () => {
  const onSelectMonth = vi.fn();
  render(<PayrollYearCard year={2026} entries={entries} forecast={forecast} selectedMonth={4} onSelectMonth={onSelectMonth} />);
  const strip = within(screen.getByRole("list", { name: "Monatsleiste 2026" }));
  expect(strip.getAllByRole("listitem")).toHaveLength(12);
  const columns = strip.getAllByRole("button");
  expect(columns.map((column) => column.getAttribute("aria-label")?.replace(/\s/g, " "))).toEqual([
    `Jänner 2026: Netto ${money(2700)}`,
    `März 2026: Brutto ${money(4000)}, Netto nicht auf der Abrechnung`,
    `April 2026: Netto ${money(5039.16)}, mit Sonderzahlung`,
  ]);
  expect(columns.map((column) => column.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
  expect(strip.getByText("Februar 2026: Abrechnung fehlt")).toBeTruthy();
  expect(strip.getByText(`Juni 2026: Prognose, Brutto ${money(7000)}, mit Sonderzahlung`)).toBeTruthy();
  expect(strip.getByText(`Mai 2026: Prognose, Brutto ${money(4000)}`)).toBeTruthy();
  const april = columns[2];
  expect([...april.querySelectorAll<HTMLElement>("[data-segment]")].map((node) => node.dataset.segment)).toEqual(["net", "tax", "sv", "other"]);
  fireEvent.click(columns[0]);
  expect(onSelectMonth).toHaveBeenCalledWith(1);
  const legend = within(screen.getByRole("list", { name: "Legende Monatsleiste" }));
  expect(legend.getByText("Prognose")).toBeTruthy();
  expect(legend.getByText("Sonderzahlung")).toBeTruthy();
});

function Fixture({ payslips }: { payslips: Payslip[] }) {
  const [state] = useState<AppState>(() => {
    const seed = createSeed();
    seed.settings.asOf = "2026-09-18";
    return { ...seed, payslips };
  });
  vi.mocked(useFinance).mockReturnValue({
    state, get dashboard(): never { throw new Error("Payroll must not use dashboard data"); },
    update: vi.fn(), replace: vi.fn(), openReviewCount: 0, ready: true, saved: true, storageError: null,
    retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return <PayrollTaxes />;
}

it("moves the focus card, month select and month list to the clicked column", () => {
  render(<Fixture payslips={entries} />);
  expect(screen.getByRole("region", { name: "Gehalt April 2026" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Jänner 2026:/ }));
  expect(screen.getByRole("region", { name: "Gehalt Jänner 2026" })).toBeTruthy();
  expect(screen.getByLabelText<HTMLSelectElement>("Monat").value).toBe("1");
  expect(screen.getByRole("button", { name: /^Jänner 2026:/ }).getAttribute("aria-pressed")).toBe("true");
  const months = within(screen.getByRole("list", { name: "Monate 2026" }));
  const rows = months.getAllByRole("listitem");
  expect(rows).toHaveLength(12);
  expect(rows[0].getAttribute("aria-current")).toBe("true");
  expect(within(rows[0]).getByText("belegt")).toBeTruthy();
  expect(within(rows[1]).getByText("fehlt")).toBeTruthy();
  expect(within(rows[5]).getByText("geschätzt")).toBeTruthy();
  expect(within(rows[2]).getByText("Netto").nextElementSibling?.textContent).toBe("–nicht auf der Abrechnung");
});
