// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PayrollResults } from "@/components/payroll-results";
import { payrollPresentation } from "@/components/payroll-presentation";
import { payslipSchema, type Payslip } from "@/lib/payslip-schema";
import { parsePayslipPages } from "@/lib/import/payslip";
import { positionedLine, syntheticContextPage } from "../../tests/fixtures/payslip-context";

afterEach(cleanup);

const january: Payslip = {
  year: 2026, month: 1, employer: "Musterbetrieb GmbH",
  regularGross: 3000, specialGross: 0, regularSv: 540, regularTax: 200,
  monthlyTaxableBase: 2460, baseSalary: 3000, monthlyPayroll: true, reportedSixth: 6000,
};

it.each([
  ["buag", "BUAG/BUAK erkannt"],
  ["apprentice", "Lehrverhältnis erkannt"],
  ["employment-ended", "Austritt angegeben"],
  ["context-unknown", "Beschäftigungskontext unklar"],
] as const)("shows a concise %s restriction beside the result without concrete net estimates", (reason, message) => {
  const view = payrollPresentation([{ ...january, payrollContextIssues: [reason] }], 2026, january.employer, "2026-05-01");
  render(<PayrollResults view={view} />);
  const result = screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" });
  expect(within(result).getByRole("status").textContent).toContain(message);
  expect(within(result).getByText("Steuer- und Nettoprognose nicht verfügbar")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }).textContent).toContain("6.000");
  expect(screen.getByText("Laut Lohnabrechnung")).toBeTruthy();
  expect(screen.queryByText("Geschätzter Auszahlungsanteil netto")).toBeNull();
  expect(screen.queryByText("Von 1.000 € bleiben netto")).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(view.analysis.nextSpecial?.tax).toBeUndefined();
  expect(view.bonus.taxExample).toBeUndefined();
});

it.each([
  ["BUAG / BUAK", "BUAG/BUAK erkannt"],
  ["Dienstverhältnis:Lehrling", "Lehrverhältnis erkannt"],
  ["Austritt:31.01.2026", "Austritt angegeben"],
  ["Personengruppe:123", "Beschäftigungskontext unklar"],
  ["Beschäftigungsart:unleserlich", "Beschäftigungskontext unklar"],
])("gates compact results after raw multi-column parsing: %s", (context, message) => {
  const report = parsePayslipPages([syntheticContextPage(positionedLine(700,
    [50, "Eintritt:01.01.2026"], [250, context]))]);
  const entry = payslipSchema.parse(JSON.parse(JSON.stringify(report.drafts[0])));
  const view = payrollPresentation([entry], 2026, entry.employer, "2026-05-01");
  render(<PayrollResults view={view} />);
  const result = screen.getByRole("region", { name: "Steuer nächste Sonderzahlung" });
  expect(within(result).getByRole("status").textContent).toContain(message);
  expect(within(result).getByText("Steuer- und Nettoprognose nicht verfügbar")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }).textContent).toContain("6.000");
  expect(screen.queryByText("Geschätzter Auszahlungsanteil netto")).toBeNull();
  expect(screen.queryByText("Von 1.000 € bleiben netto")).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();
});

it("keeps the standard net model available after raw multi-column parsing", () => {
  const entry = payslipSchema.parse(parsePayslipPages([syntheticContextPage(positionedLine(700,
    [50, "Eintritt:01.01.2026"], [250, "Personengruppe:Angestellter"], [450, "Austritt:-"]))]).drafts[0]);
  const view = payrollPresentation([entry], 2026, entry.employer, "2026-05-01");
  render(<PayrollResults view={view} />);
  expect(screen.getByText("Geschätzter Auszahlungsanteil netto")).toBeTruthy();
  expect(view.analysis.nextSpecial?.tax?.netSpecial).toBeGreaterThan(0);
  expect(view.bonus.taxExample?.net).toBeGreaterThan(0);
  expect(screen.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }).textContent).toContain("6.000");
});
