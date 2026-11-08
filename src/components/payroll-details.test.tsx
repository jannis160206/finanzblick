// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { PayrollDetails } from "./payroll-details";
import {
  payrollPresentation,
  payrollEstimate,
  payrollPeriod,
} from "./payroll-presentation";
import { currency, monthLabel } from "@/lib/format";
import {
  payrollEmployer,
  payrollFixture,
} from "../../tests/fixtures/payroll-state";

afterEach(cleanup);

function januaryView() {
  const state = payrollFixture();
  return payrollPresentation(
    state.payslips!.filter(
      (entry) =>
        entry.employer === payrollEmployer &&
        entry.year === 2026 &&
        entry.month === 1,
    ),
    2026,
    payrollEmployer,
    state.settings.asOf,
  );
}

it("renders every projected month once, in model order, with the unchanged values", () => {
  const view = januaryView();
  const before = structuredClone(view);
  render(<PayrollDetails view={view} />);
  const cards = screen.getAllByRole("article");
  expect(cards).toHaveLength(11);
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(
    view.projectedMonths.map((entry) =>
      monthLabel(payrollPeriod(2026, entry.month)),
    ),
  );
  for (const month of view.projectedMonths) {
    const label = monthLabel(payrollPeriod(2026, month.month));
    const card = within(screen.getByRole("article", { name: label }));
    const forecast = view.analysis.forecast.months.find(
      (entry) => entry.month === month.month,
    )!;
    expect(card.getByLabelText(`${label} Laufendes Brutto`).textContent).toBe(
      currency(forecast.regularGross),
    );
    expect(card.getByLabelText(`${label} Sonderzahlung`).textContent).toBe(
      forecast.specialGross > 0
        ? currency(forecast.specialGross)
        : "Keine geplant",
    );
    expect(card.getByLabelText(`${label} Jahressechstel`).textContent).toBe(
      payrollEstimate(month),
    );
  }
  expect(view).toEqual(before);
});

it("highlights only modelled special-payment months and keeps the forecast collapsible", () => {
  render(<PayrollDetails view={januaryView()} />);
  for (const month of [6, 11]) {
    const label = monthLabel(payrollPeriod(2026, month));
    expect(
      within(screen.getByRole("article", { name: label })).getAllByText(
        "Sonderzahlung",
      ),
    ).toHaveLength(2);
  }
  expect(
    within(
      screen.getByRole("article", { name: monthLabel("2026-02") }),
    ).getAllByText("Sonderzahlung"),
  ).toHaveLength(1);
  const disclosure = screen
    .getByText("Monatliche Prognose anzeigen")
    .closest("details");
  expect(disclosure?.open).toBe(false);
  expect(
    screen.queryByText("Berechnungsdetails, Annahmen & Quellen"),
  ).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});

it("keeps an unknown special-payment model unknown instead of implying zero", () => {
  const view = januaryView();
  const unmodelled = payrollPresentation(
    [{ ...view.latest!, baseSalary: undefined }],
    2026,
    payrollEmployer,
    "2026-10-08",
  );
  expect(unmodelled.analysis.hasSpecialPaymentModel).toBe(false);
  render(<PayrollDetails view={unmodelled} />);
  for (const month of unmodelled.projectedMonths) {
    const label = monthLabel(payrollPeriod(2026, month.month));
    expect(screen.getByLabelText(`${label} Sonderzahlung`).textContent).toBe(
      "Noch offen",
    );
  }
  expect(screen.queryByText("Keine geplant")).toBeNull();
});

it("preserves uncertainty ranges and does not invent a missing monthly gross", () => {
  const view = januaryView();
  view.projectedMonths = view.projectedMonths.map((month) => ({
    ...month,
    sixthUpper: month.sixth + 123.45,
  }));
  view.analysis.forecast.months = [];
  render(<PayrollDetails view={view} />);
  expect(
    screen.getByLabelText(`${monthLabel("2026-02")} Laufendes Brutto`)
      .textContent,
  ).toBe("Noch offen");
  expect(
    screen.getByLabelText(`${monthLabel("2026-02")} Sonderzahlung`).textContent,
  ).toBe("Noch offen");
  expect(
    screen.getByLabelText(`${monthLabel("2026-02")} Jahressechstel`)
      .textContent,
  ).toBe(payrollEstimate(view.projectedMonths[0]));
});

it("does not render an empty disclosure when all months are already documented", () => {
  const view = januaryView();
  render(<PayrollDetails view={{ ...view, projectedMonths: [] }} />);
  expect(screen.queryByText("Monatliche Prognose anzeigen")).toBeNull();
  expect(screen.queryByRole("article")).toBeNull();
});
