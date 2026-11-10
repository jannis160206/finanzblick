// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PayrollResults } from "@/components/payroll-results";
import { payrollShare } from "@/components/payroll-focus";
import { payrollPresentation } from "@/components/payroll-presentation";
import { currency } from "@/lib/format";
import type { Payslip } from "@/lib/payslip-schema";
import { payrollEmployer, payrollFixture } from "../../tests/fixtures/payroll-state";

afterEach(cleanup);

const fixtureView = () => {
  const state = payrollFixture();
  return payrollPresentation(state.payslips ?? [], 2026, payrollEmployer, "2026-10-08");
};
const moneyText = (value: number) => currency(value).replace(/\s/g, " ");
const figure = (region: HTMLElement, label: string) =>
  within(region).getByText(label).closest("div")!.querySelector("dd")!;

it("leads with the estimated net payout of the next special payment and three compact figures", () => {
  const view = fixtureView();
  const tax = view.next?.tax;
  if (!tax || !view.nextPayment) throw new Error("The fixture must project November's special payment.");
  render(<PayrollResults view={view} />);
  expect(screen.getByRole("region", { name: "Sonderzahlung & Jahressechstel" })).toBeTruthy();
  const hero = screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" });
  const card = within(hero);
  expect(card.getByRole("heading", { level: 3, name: "Nächste Sonderzahlung" })).toBeTruthy();
  expect(card.getByText("November 2026")).toBeTruthy();
  expect(card.getByText("geschätzt")).toBeTruthy();
  // Short visible labels, full wording for screen readers.
  expect(card.getByText("Auszahlung netto").getAttribute("aria-hidden")).toBe("true");
  expect(figure(hero, "Geschätzter Auszahlungsanteil netto").textContent).toBe(currency(tax.netSpecial));
  expect(figure(hero, "Geschätzter Auszahlungsanteil netto").className).toContain("text-display");
  expect(figure(hero, "Sonderzahlung brutto").textContent).toBe(currency(view.nextPayment.specialGross));
  expect(figure(hero, "Geschätzte Lohnsteuer").textContent).toBe(currency(tax.total));
  expect(figure(hero, "Mehr-/Mindersteuer durch Sechstelüberhang").textContent).toBe(currency(tax.signedOverflowDelta));
  expect(card.getByRole("button", { name: "Info: Nächste Sonderzahlung" })).toBeTruthy();
  // Net, Lohnsteuer and the model's SV split the gross like the month's Brutto → Netto bar.
  const split = within(card.getByRole("list", { name: "Aufteilung der Sonderzahlung" }));
  expect(split.getAllByRole("listitem").map((item) => item.textContent?.replace(/\s/g, " "))).toEqual([
    `Netto${payrollShare(tax.netSpecial / view.nextPayment.specialGross)}`,
    `Lohnsteuer${payrollShare(tax.total / view.nextPayment.specialGross)}`,
    `SV${payrollShare(view.nextPayment.specialSv! / view.nextPayment.specialGross)}`,
  ].map((text) => text.replace(/\s/g, " ")));
  expect(tax.netSpecial + tax.total + view.nextPayment.specialSv!).toBeCloseTo(view.nextPayment.specialGross, 2);
});

it("shows the documented sixth with its source, the usage meter and the December estimate", () => {
  const view = fixtureView();
  render(<PayrollResults view={view} />);
  const sixth = screen.getByRole("region", { name: "Jahressechstel" });
  const documented = within(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }));
  expect(documented.getByText(moneyText(view.actual!.sixth))).toBeTruthy();
  expect(documented.getByText("berechnet")).toBeTruthy();
  expect(documented.getByText("Stand: September 2026")).toBeTruthy();
  const meter = within(sixth).getByRole("progressbar", { name: "Jahressechstel verbraucht" });
  expect(meter.getAttribute("aria-valuetext")).toBe(
    `Verbraucht ${currency(3000)} von ${currency(view.actual!.sixth)}, Rest ${currency(view.actual!.sixth - 3000)}`,
  );
  // Continuous payslips since January make the usage verifiable: no gross-comparison hint.
  expect(within(sixth).queryByText("Bruttovergleich")).toBeNull();
  expect(within(sixth).queryByText("Überhang")).toBeNull();
  const estimate = within(screen.getByRole("region", { name: "Jahressechstel Prognose" }));
  expect(estimate.getByText("Oktober 2026")).toBeTruthy();
  expect(estimate.getByText("Jahresende · Dezember 2026").nextElementSibling?.textContent).toBe(
    currency(view.yearEndEstimate!.sixth),
  );
});

it("marks a sixth overhang in the meter with its own label and the destructive tone", () => {
  // Without January the usage is not verifiable, so the meter compares gross special payments with the sixth.
  const february: Payslip = {
    year: 2026, month: 2, employer: "Musterbetrieb GmbH", regularGross: 1000, regularGrossYtd: 2000,
    specialGross: 3000, specialGrossYtd: 3000, specialSv: 400, regularSv: 180, regularTax: 0,
    monthlyTaxableBase: 820, baseSalary: 1000, monthlyPayroll: true,
  };
  const view = payrollPresentation([february], 2026, february.employer, "2026-03-08");
  expect(view.actual).toMatchObject({ sixth: 2000, usedSixth: undefined });
  render(<PayrollResults view={view} />);
  const sixth = within(screen.getByRole("region", { name: "Jahressechstel" }));
  expect(sixth.getByRole("progressbar").getAttribute("aria-valuetext")).toContain(`Überhang ${currency(1000)}`);
  const overhang = sixth.getByText("Überhang").closest("div")!.querySelector("dd")!;
  expect(overhang.textContent).toBe(currency(1000));
  expect(overhang.className).toContain("text-destructive");
  expect(sixth.getByText("Bruttovergleich")).toBeTruthy();
  expect(sixth.getByRole("button", { name: "Info: Bruttovergleich" })).toBeTruthy();
});

it("shows the bonus room with its reserved share and keeps the tax example compact until opened", () => {
  const view = fixtureView();
  render(<PayrollResults view={view} />);
  const bonus = within(screen.getByRole("region", { name: "Zusätzlicher Prämien-Spielraum" }));
  expect(bonus.getByText(moneyText(view.bonus.headroom!.minimum))).toBeTruthy();
  expect(bonus.getByText("Geplante Sonderzahlungen").nextElementSibling?.textContent).toBe(
    currency(view.bonus.reservedSpecialGross),
  );
  expect(bonus.queryByText("je nach Prämienzuordnung")).toBeNull();
  const disclosure = bonus.getByRole<HTMLDetailsElement>("group", { name: "Steuerbeispiel" });
  expect(disclosure.open).toBe(false);
  fireEvent.click(disclosure.querySelector("summary")!);
  expect(disclosure.open).toBe(true);
  const example = within(bonus.getByRole("group", { name: "Steuerbeispiel Zusatzprämie" }));
  expect(example.getByText("Netto").closest("div")?.querySelector("dd")?.textContent).toBe(
    currency(view.bonus.taxExample!.net),
  );
});
