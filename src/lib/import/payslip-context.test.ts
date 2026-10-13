import { describe, expect, it } from "vitest";
import { parsePayslipPages, type PayslipLine } from "./payslip";
import { payslipSchema } from "@/lib/payslip-schema";
import { analyzePayroll, analyzePayrollAutomatically, defaultPayrollForecast, estimatePayrollBonus } from "@/lib/payroll-analysis";
import { positionedLine, syntheticContextPage } from "../../../tests/fixtures/payslip-context";

function read(context: string | PayslipLine) {
  return parsePayslipPages([syntheticContextPage(context)]);
}

describe("payroll context gates from synthetic positioned documents", () => {
  it("reproduces a full-month January record unlocking June in the standard model", () => {
    const entry = payslipSchema.parse(read("Beschäftigungsart: Angestellter").drafts[0]);
    const analysis = analyzePayrollAutomatically([entry], 2026, entry.employer);
    expect(entry.monthlyPayroll).toBe(true);
    expect(analysis.nextSpecial?.month).toBe(6);
    expect(analysis.nextSpecial?.tax?.netSpecial).toBeGreaterThan(0);
    expect(estimatePayrollBonus([entry], analysis, 6).taxExample?.net).toBeGreaterThan(0);
  });

  it.each([
    ["BUAG", "buag"],
    ["BUAK / BUAG", "buag"],
    ["Dienstverhältnis: Lehrling", "apprentice"],
    ["Austritt31.01.2026", "employment-ended"],
    ["Austritt31.01", "employment-ended"],
    ["Austritt: 31.01.", "employment-ended"],
    ["Beschäftigungsart: Unbekannter Sonderstatus", "context-unknown"],
    ["Personengruppe: 123", "context-unknown"],
    ["Austritt: unleserlich", "context-unknown"],
    ["Eintritt:01.01.2026 Personengruppe:123", "context-unknown"],
    ["Eintritt:01.01.2026 Versicherungsgruppe:123", "context-unknown"],
    ["Eintritt:01.01.2026 SV-Gruppe:123", "context-unknown"],
    ["Eintritt:01.01.2026 Beschäftigungsart:unleserlich", "context-unknown"],
    ["Eintritt:01.01.2026 Dienstverhältnis:Lehrling", "apprentice"],
    ["Eintritt:01.01.2026 Dienstverhältnis:BUAK / BUAG", "buag"],
    ["Eintritt:01.01.2026 Austritt:31.01.2026 Personengruppe:Angestellter", "employment-ended"],
    ["Eintritt:01.01.2026 Austritt:unleserlich Personengruppe:Angestellter", "context-unknown"],
    ["Eintritt:01.01.2026 Personengruppe:", "context-unknown"],
  ])("retains documentary values but blocks net estimates for %s", (context, reason) => {
    const report = read(context);
    const entry = payslipSchema.parse(JSON.parse(JSON.stringify(report.drafts[0])));
    expect(entry).toMatchObject({
      monthlyPayroll: true, regularGross: 3000, baseSalary: 3000, reportedSixth: 6000,
      payrollContextIssues: [reason],
    });
    expect(JSON.stringify(entry)).not.toContain("synthetische Identität");
    expect(defaultPayrollForecast([entry], 2026, entry.employer).months).toEqual([]);
    const automatic = analyzePayrollAutomatically([entry], 2026, entry.employer);
    expect(automatic.actual).toMatchObject({ sixth: 6000, source: "reported" });
    expect(automatic.projections).toEqual([]);
    expect(automatic.sixthEstimates).toEqual([]);
    expect(automatic.contextIssues.length).toBeGreaterThan(0);
    const bonus = estimatePayrollBonus([entry], automatic, 6);
    expect(bonus.taxExample).toBeUndefined();
    expect(bonus.headroom).toBeUndefined();
    expect(bonus.taxIssues).toEqual(automatic.contextIssues);
    const confirmed = analyzePayroll([entry], 2026, entry.employer, {
      year: 2026, employer: entry.employer, standardPayrollConfirmed: true,
      months: [{ month: 6, regularGross: 3000, specialGross: 3000, specialSv: 512.1, monthlyTaxableBase: 2460 }],
    });
    expect(confirmed.projections).toEqual([]);
  });

  it.each([
    "Dienstverhältnis", "Beschäftigungsverhältnis", "Beschäftigungsart",
    "Personengruppe", "Versicherungsgruppe", "SV-Gruppe",
  ])("reads unknown %s from split positioned items in a later header column", (label) => {
    const report = read(positionedLine(700,
      [50, "Eintritt:"], [100, "01.01.2026"], [250, label], [335, ":"], [345, "123"],
      [420, "Personalnummer:"], [500, "777777"]));
    const entry = payslipSchema.parse(report.drafts[0]);
    expect(entry.payrollContextIssues).toEqual(["context-unknown"]);
    expect(entry.reportedSixth).toBe(6000);
    expect(analyzePayrollAutomatically([entry], 2026, entry.employer).nextSpecial).toBeUndefined();
    expect(JSON.stringify(report)).not.toMatch(/123|777777|synthetische Identität/);
  });

  it.each([
    "Personengruppe Beratung GmbH", "Austritt Beratung GmbH",
    "BUAK Bau GmbH", "Lehrling Beratung GmbH",
    "Firma: Personengruppe Beratung GmbH",
  ])("does not mistake the employer name %s for employee context", (employer) => {
    const entry = payslipSchema.parse(parsePayslipPages([syntheticContextPage("", employer)]).drafts[0]);
    expect(entry.payrollContextIssues).toBeUndefined();
    expect(analyzePayrollAutomatically([entry], 2026, entry.employer).nextSpecial?.tax).toBeDefined();
  });

  it("does not infer an unknown employee group from a positioned wage code", () => {
    const input = syntheticContextPage("");
    const entry = payslipSchema.parse(parsePayslipPages([{
      lines: input.lines.map((line) => line.y === 490
        ? positionedLine(490, [54, "123"], [89, "Gehalt"], [379, "3.000,00"], [451, "3.000,00"], [525, "3.000,00"])
        : line),
    }]).drafts[0]);
    expect(entry.payrollContextIssues).toBeUndefined();
    expect(analyzePayrollAutomatically([entry], 2026, entry.employer).nextSpecial?.tax).toBeDefined();
  });

  it.each([
    ["Arbeitgeber: Personengruppe Beratung GmbH Personengruppe:Angestellter", undefined],
    ["Firma: Dienstverhältnis Beratung GmbH Personengruppe:123", ["context-unknown"]],
    ["Firma: Musterbetrieb GmbH Personengruppe 123", ["context-unknown"]],
  ])("keeps employer-name words separate from actual later header fields: %s", (context, reasons) => {
    expect(read(context).drafts[0].payrollContextIssues).toEqual(reasons);
  });

  it("does not infer employment eligibility from a numeric group or 30 tax days", () => {
    const entry = payslipSchema.parse(read("Beschäftigungsart: 1000").drafts[0]);
    const later = { ...payslipSchema.parse(read("").drafts[0]), month: 2 };
    const analysis = analyzePayrollAutomatically([entry, later], 2026, entry.employer);
    expect(analysis.projections).toEqual([]);
    expect(estimatePayrollBonus([entry, later], analysis, 6).taxExample).toBeUndefined();
  });

  it.each([
    "", "Austritt: -", "Austritt: 00.00.0000", "Dienstverhältnis: Angestellte",
    "Eintritt:01.01.2026 Personengruppe:Angestellter Austritt:-",
    "Eintritt:01.01.2026 Dienstverhältnis:Angestellte Personalnummer:777777",
    "Eintritt:01.01.2026 Austritt:00.00.0000 Personengruppe:Arbeiter",
    "Eintritt:01.01.2026 Austritt: Personengruppe:Angestellter",
  ])(
    "does not turn an absent/empty termination or ordinary context into a restriction: %s", (context) => {
      const entry = payslipSchema.parse(read(context).drafts[0]);
      expect(entry.payrollContextIssues).toBeUndefined();
      expect(analyzePayrollAutomatically([entry], 2026, entry.employer).nextSpecial?.tax).toBeDefined();
    },
  );
});
