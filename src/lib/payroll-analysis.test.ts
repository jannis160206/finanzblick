import { describe, expect, it } from "vitest";
import { analyzePayroll, analyzePayrollAutomatically, defaultPayrollForecast, estimatePayrollBonus, payrollTaxSources } from "@/lib/payroll-analysis";
import type { Payslip, PayrollForecast } from "@/lib/payslip-schema";

const slip = (month: number, override: Partial<Payslip> = {}): Payslip => ({
  year: 2026,
  month,
  employer: "Synthetischer Testbetrieb",
  regularGross: 3000,
  specialGross: 0,
  monthlyPayroll: true,
  monthlyTaxableBase: 2450,
  ...override,
});
const months = (last: number, override: Partial<Payslip> = {}) =>
  Array.from({ length: last }, (_, index) => slip(index + 1, override));
const analyze = (entries: Payslip[], forecast?: PayrollForecast) =>
  analyzePayroll(entries, 2026, "Synthetischer Testbetrieb", forecast);
const forecastFor = (entries: Payslip[], override: Partial<PayrollForecast> = {}): PayrollForecast => ({
  ...defaultPayrollForecast(entries, 2026, "Synthetischer Testbetrieb"),
  ...override,
});

describe("estimated additional bonus headroom and isolated tariff example", () => {
  const estimate = (entries: Payslip[], month = 11) => estimatePayrollBonus(
    entries, analyzePayrollAutomatically(entries, 2026, "Synthetischer Testbetrieb"), month,
  );
  const paidThroughAugust = () => months(8, {
    regularGross: 4000, baseSalary: 3000, monthlyTaxableBase: 3200, regularTax: 500,
  }).map((entry) => entry.month === 6 ? { ...entry, specialGross: 3000, specialSv: 512.1 } : entry);

  it("reserves paid and all planned special salaries, not merely the next payment", () => {
    expect(estimate([slip(1, { regularGross: 4000, baseSalary: 3000 })], 6)).toMatchObject({
      reservedSpecialGross: 6000, headroom: { minimum: 2000, maximum: 2000 },
    });
    expect(estimate(paidThroughAugust())).toMatchObject({
      reservedSpecialGross: 3000, headroom: { minimum: 2000, maximum: 2000 },
    });
  });

  it("uses the payment month's capacity even when December would permit a larger bonus", () => {
    const entries = [...months(3, { regularGross: 1000 }), slip(4, { regularGross: 6000, baseSalary: 1500 })];
    expect(estimate(entries, 4).headroom).toEqual({ minimum: 4500, maximum: 4500 });
    expect(estimate(entries, 12).headroom).toEqual({ minimum: 6500, maximum: 6500 });
  });

  it("limits a shrinking sixth by December's control amount and clamps negative capacity to zero", () => {
    const entries = [...months(7, { regularGross: 6000 }), slip(8, { regularGross: 2000, baseSalary: 2000 })];
    expect(estimate(entries, 9).headroom).toEqual({ minimum: 6666.67, maximum: 6666.67 });
    expect(estimate(paidThroughAugust().map((entry) => entry.month === 6
      ? { ...entry, specialGross: 9000 } : entry)).headroom).toEqual({ minimum: 0, maximum: 0 });
  });

  it("shows conservative lower and upper bounds for unresolved VEB instead of unlocking actual tax", () => {
    const entries = paidThroughAugust().map((entry) => entry.month === 2
      ? { ...entry, unresolvedSixthBonus: 1000, specialSv: 141.2 } : entry);
    const original = structuredClone(entries);
    const result = estimate(entries);
    expect(result.headroom).toEqual({ minimum: 1000, maximum: 2166.67 });
    expect(result.taxExample).toBeDefined();
    expect(analyzePayrollAutomatically(entries, 2026, entries[0].employer).nextSpecial).toBeUndefined();
    expect(entries).toEqual(original);
  });

  it("never treats missing payrolls as zero previous bonuses", () => {
    const result = estimate(paidThroughAugust().filter((entry) => entry.month !== 2));
    expect(result.headroom).toBeUndefined();
    expect(result.taxExample).toBeUndefined();
    expect(result.headroomIssues.join()).toContain("nicht vollständig belegt");
    expect(result.taxIssues.join()).toContain("SV-Sonderzahlungsbasis");
  });

  it("accepts documented cumulative history even with absent individual months", () => {
    const result = estimate([slip(8, {
      regularGross: 4000, regularGrossYtd: 32000, specialGrossYtd: 3000, baseSalary: 3000,
    })]);
    expect(result.headroom).toEqual({ minimum: 2000, maximum: 2000 });
    expect(result.taxExample).toBeUndefined();
  });

  it("does not invent future salary reservations when base salary is absent", () => {
    const result = estimate([slip(8, { regularGrossYtd: 24000, specialGrossYtd: 0, regularTax: 200 })]);
    expect(result.headroom).toBeUndefined();
    expect(result.headroomIssues.join()).toContain("Grundgehalt");
    expect(result.taxExample).toBeUndefined();
    expect(result.taxIssues.join()).toContain("Grundgehalt");
  });

  it("keeps the exact estimated gross limit inside the sixth while one additional cent causes overflow", () => {
    const entries = paidThroughAugust();
    const analysis = analyzePayrollAutomatically(entries, 2026, entries[0].employer);
    const allowance = estimatePayrollBonus(entries, analysis, 11).headroom!.minimum;
    const capacity = analysis.projections.filter((entry) => entry.month >= 11)
      .map((entry) => entry.sixth - entry.specialGrossYtd);
    expect(capacity.every((amount) => amount >= allowance)).toBe(true);
    expect(capacity.some((amount) => amount < allowance + 0.01)).toBe(true);
  });

  it.each([
    { entries: [] }, { entries: [slip(8, { monthlyPayroll: false })] },
    { entries: [slip(1), slip(2, { regularGrossYtd: 100 })] },
  ])(
    "does not promise headroom or tax for empty, partial or conflicting records", ({ entries }) => {
      const result = estimate(entries);
      expect(result.headroom).toBeUndefined();
      expect(result.taxExample).toBeUndefined();
    },
  );

  it.each([0, 7, 13, 8.5])("rejects a bonus month outside the available model: %s", (month) => {
    const result = estimate(paidThroughAugust(), month);
    expect(result.headroom).toBeUndefined();
    expect(result.headroomIssues).not.toEqual([]);
  });

  it("shows average tariff, SV, total deductions and net for a hypothetical 1000 EUR tariff-taxed bonus", () => {
    expect(estimate(paidThroughAugust()).taxExample).toEqual({
      gross: 1000, sv: 170.7, tax: 331.72, deductions: 502.42, net: 497.58, effectiveTariffRate: 40,
    });
  });

  it("integrates tax bands rather than multiplying by the starting marginal rate", () => {
    const result = estimate(paidThroughAugust().map((entry) => ({
      ...entry, monthlyTaxableBase: 2800, regularTax: 300,
    }))).taxExample;
    expect(result).toMatchObject({ tax: 306.8, effectiveTariffRate: 37, net: 522.5 });
  });

  it("apportions the monthly special-payment SV and respects the annual SV cap", () => {
    const entries = [slip(8, {
      regularGross: 8000, regularGrossYtd: 64000, specialGrossYtd: 13000,
      baseSalary: 3000, monthlyTaxableBase: 5000, regularTax: 1000,
    })];
    expect(estimate(entries).taxExample?.sv).toBe(36.7);
    expect(estimate([{ ...entries[0], specialGrossYtd: 14000 }]).taxExample?.sv).toBe(0);
  });

  it("includes an unresolved SV-special bonus in the SV cap independently of sixth uncertainty", () => {
    const entries = paidThroughAugust().map((entry) => entry.month === 2
      ? { ...entry, unresolvedSixthBonus: 10000, specialSv: 1707 } : entry);
    expect(estimate(entries).taxExample?.sv).toBe(36.7);
  });

  it("can evaluate December without charging its existing SV-special gross twice", () => {
    const entries = [slip(12, {
      regularGross: 4000, regularGrossYtd: 48000, specialGross: 3000, specialGrossYtd: 13000,
      monthlyTaxableBase: 3200, regularTax: 500,
    })];
    expect(estimate(entries, 12)).toMatchObject({
      reservedSpecialGross: 0, headroom: { minimum: 0, maximum: 0 }, taxExample: { sv: 164.73 },
    });
  });

  it.each([
    { monthlyTaxableBase: undefined }, { regularTax: undefined }, { regularTax: 0 }, { regularTax: 10000 },
  ])("keeps existing tax safeguards and still shows gross room: %j", (override) => {
    const result = estimate(paidThroughAugust().map((entry) => ({ ...entry, ...override })));
    expect(result.headroom).toBeDefined();
    expect(result.taxExample).toBeUndefined();
    expect(result.taxIssues.length).toBeGreaterThan(0);
  });

  it("does not give a bonus allowance from a contradictory printed sixth", () => {
    const result = estimate(paidThroughAugust().map((entry) => entry.month === 8 ? { ...entry, reportedSixth: 100 } : entry));
    expect(result.headroom).toBeUndefined();
    expect(result.taxExample).toBeUndefined();
    expect(result.headroomIssues.join()).toContain("widerspricht");
  });

  it("keeps 2027 gross headroom separate from unavailable automatic SV and net estimates", () => {
    const entries = paidThroughAugust().map((entry): Payslip => ({ ...entry, year: 2027 }));
    const result = estimatePayrollBonus(entries, analyzePayrollAutomatically(entries, 2027, entries[0].employer), 11);
    expect(result.headroom).toEqual({ minimum: 2000, maximum: 2000 });
    expect(result.taxExample).toBeUndefined();
    expect(result.taxIssues.join()).toContain("2027");
  });

  it("keeps employer and year boundaries intact", () => {
    const entries = paidThroughAugust();
    const original = estimate(entries);
    expect(estimate([...entries, slip(12, { employer: "Anderer Betrieb", specialGross: 99999 }), slip(12, { year: 2027 })])).toEqual(original);
  });
});

describe("automatic document-driven payroll model", () => {
  const automatic = (entries: Payslip[]) => analyzePayrollAutomatically(entries, 2026, "Synthetischer Testbetrieb");
  const overflowSlip = (override: Partial<Payslip> = {}) => slip(9, {
    regularGross: 5000, regularGrossYtd: 45000, specialGrossYtd: 7000,
    usedSixth: 7000, specialTaxableYtd: 620, baseSalary: 4000,
    monthlyTaxableBase: 4000, regularTax: 500, ...override,
  });

  it("calculates only an explicitly unconfirmed standard model without changing legacy confirmation", () => {
    const entries = [slip(1, { baseSalary: 3000 })];
    const result = automatic(entries);
    expect(result).toMatchObject({
      mode: "automatic-standard-model", hasSpecialPaymentModel: true,
      forecast: { standardPayrollConfirmed: false },
      actual: { month: 1, sixth: 6000, specialGrossYtd: 0 },
    });
    expect(result.nextSpecial).toMatchObject({
      month: 6, source: "scenario",
      tax: { preferential: 112.07, tariff: 0, total: 112.07, netSpecial: 2375.83 },
      taxIssues: [],
    });
    expect(result.projections.find((entry) => entry.month === 11)?.tax?.total).toBe(149.27);
    expect(result.assumptions.join(" ")).toMatch(/unbestätigten Annahmen/);
    expect(result.assumptions.join(" ")).toContain("Absetzbeträge");
    expect(result.assumptions.join(" ")).toContain("nicht durch das Modell bestätigt");
    expect(result.nextSpecial?.taxAssumptions.join(" ")).toContain("unbestätigten automatischen");
    expect(analyze(entries).nextSpecial?.tax).toBeUndefined();
    expect(defaultPayrollForecast(entries, 2026, entries[0].employer).standardPayrollConfirmed).toBe(false);
  });

  it("does not use or mutate persisted manual forecasts", () => {
    const entries = [slip(1, { baseSalary: 3000 })];
    const saved = forecastFor(entries, {
      standardPayrollConfirmed: true,
      months: [{ month: 11, regularGross: 99999, specialGross: 99999, specialSv: 0 }],
    });
    const original = structuredClone({ entries, saved });
    expect(analyze(entries, saved).forecast.months.find((entry) => entry.month === 11)?.regularGross).toBe(99999);
    expect(automatic(entries).forecast.months.find((entry) => entry.month === 11)).toMatchObject({
      regularGross: 3000, specialGross: 3000, specialSv: 512.1,
    });
    expect({ entries, saved }).toEqual(original);
  });

  it("replaces modeled months and refreshes all remaining defaults after a newer statement", () => {
    const january = slip(1, { baseSalary: 3000 });
    const before = automatic([january]);
    const after = automatic([january, slip(2, {
      regularGross: 3500, baseSalary: 3200, monthlyTaxableBase: 2800,
    })]);
    expect(before.yearEnd?.regularGrossYtd).toBe(36000);
    expect(after.actual).toMatchObject({ month: 2, regularGrossYtd: 6500 });
    expect(after.projections[0].month).toBe(3);
    expect(after.forecast.months.every((entry) => entry.regularGross === 3500 && entry.monthlyTaxableBase === 2800)).toBe(true);
    expect(after.nextSpecial).toMatchObject({ month: 6, specialGross: 3200 });
    expect(after.yearEnd?.regularGrossYtd).toBe(41500);
  });

  it("keeps missing actual months unknown instead of replacing their history with the model", () => {
    const result = automatic([slip(1, { baseSalary: 3000 }), slip(9, { baseSalary: 3000, reportedSixth: 6000 })]);
    expect(result.actual?.sixth).toBe(6000);
    expect(result.actual?.specialGrossYtd).toBeUndefined();
    expect(result.projections).toEqual([]);
    expect(result.missingMonths).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("shows an explicitly separate rough sixth estimate while a missing month blocks actuals and tax", () => {
    const entries = Array.from({ length: 8 }, (_, index) => slip(index + 1, {
      regularGross: index === 7 ? 4000 : 3000, baseSalary: 3000,
    })).filter((entry) => entry.month !== 2);
    const original = structuredClone(entries);
    const result = automatic(entries);
    expect(result.actual).toBeUndefined();
    expect(result.projections).toEqual([]);
    expect(result.nextSpecial).toBeUndefined();
    expect(result.estimatedHistoryMonths).toEqual([2]);
    expect(result.sixthEstimates.find((entry) => entry.month === 9)?.sixth).toBe(6476.19);
    expect(result.sixthEstimates.at(-1)?.sixth).toBe(6857.14);
    expect(entries).toEqual(original);
  });

  it("uses a printed cumulative anchor rather than estimating the months it covers", () => {
    const result = automatic([
      slip(3, { regularGross: 3000, regularGrossYtd: 9000, baseSalary: 3000 }),
      slip(5, { regularGross: 4000, baseSalary: 3000 }),
    ]);
    expect(result.estimatedHistoryMonths).toEqual([4]);
    expect(result.sixthEstimates[0]).toMatchObject({ month: 5, regularGrossYtd: 16500, sixth: 6600 });
    expect(result.sixthEstimates.at(-1)?.sixth).toBe(7416.67);
    expect(result.actual).toBeUndefined();
    expect(result.nextSpecial).toBeUndefined();
  });

  it("can project the sixth from known running gross even if special-payment history is missing", () => {
    const result = automatic([slip(8, { regularGross: 3000, regularGrossYtd: 24000, baseSalary: 3000 })]);
    expect(result.estimatedHistoryMonths).toEqual([]);
    expect(result.sixthEstimates.at(-1)?.sixth).toBe(6000);
    expect(result.actual?.sixth).toBe(6000);
    expect(result.nextSpecial).toBeUndefined();
  });

  it("replaces the rough estimate with documented history when the missing PDF is imported", () => {
    const entries = [slip(1, { baseSalary: 3000 }), slip(3, { baseSalary: 3000 })];
    const incomplete = automatic(entries);
    expect(incomplete.estimatedHistoryMonths).toEqual([2]);
    const complete = automatic([...entries, slip(2, { regularGross: 3600, baseSalary: 3000 })]);
    expect(complete.estimatedHistoryMonths).toEqual([]);
    expect(complete.actual?.sixth).toBe(6400);
    expect(complete.sixthEstimates.at(-1)?.sixth).toBe(6100);
    expect(complete.yearEnd?.sixth).toBe(6100);
  });

  it("does not show an indicative estimate for partial or internally conflicting payrolls", () => {
    expect(automatic([slip(8, { monthlyPayroll: false })]).sixthEstimates).toEqual([]);
    expect(automatic([slip(1), slip(2, { regularGrossYtd: 100 })]).sixthEstimates).toEqual([]);
    expect(automatic([]).sixthEstimates).toEqual([]);
  });

  it("keeps a reconciled tariff-taxed bonus separate and shows both sixth hypotheses without fabricating actuals", () => {
    const entries = [slip(1), slip(2, {
      regularGross: 3050, unresolvedSixthBonus: 1000, specialSv: 141.2,
      baseSalary: 3000, monthlyTaxableBase: 3309.8,
    })];
    const original = structuredClone(entries);
    const result = automatic(entries);
    expect(result.missingMonths).toEqual([]);
    expect(result.estimatedHistoryMonths).toEqual([]);
    expect(result.unresolvedSixthMonths).toEqual([2]);
    expect(result.actual).toBeUndefined();
    expect(result.projections).toEqual([]);
    expect(result.sixthEstimates[0]).toMatchObject({ month: 2, sixth: 6050, sixthUpper: 7050 });
    expect(result.sixthEstimates.at(-1)).toMatchObject({ sixth: 6091.67, sixthUpper: 6258.33 });
    expect(result.forecast.months.every((entry) => entry.regularGross === 3050 && entry.monthlyTaxableBase === 2451)).toBe(true);
    expect(result.issues.join()).toContain("§ 67 Abs. 10");
    expect(entries).toEqual(original);
  });

  it("accounts for the bonus in the separate SV-special annual cap even though its sixth treatment is unknown", () => {
    const result = automatic([slip(1), slip(2, {
      unresolvedSixthBonus: 9500, specialSv: 1621.65, baseSalary: 5000,
    })]);
    expect(result.forecast.months.find((entry) => entry.month === 6)?.specialSv).toBe(744.25);
    expect(result.forecast.months.find((entry) => entry.month === 11)?.specialSv).toBe(0);
    expect(result.nextSpecial).toBeUndefined();
    expect(automatic([slip(2, { unresolvedSixthBonus: 1000, baseSalary: 3000 })])
      .forecast.months.find((entry) => entry.month === 6)?.specialSv).toBeUndefined();
  });

  it("lets a later cumulative regular basis replace the range but not invent historical preferential taxation", () => {
    const entries = [
      slip(1), slip(2, { regularGross: 3050, unresolvedSixthBonus: 1000, specialSv: 141.2 }),
      slip(3, { regularGrossYtd: 10050, specialGrossYtd: 0, baseSalary: 3000 }),
    ];
    const result = automatic(entries);
    expect(result.actual?.sixth).toBe(6700);
    expect(result.actual?.usedSixth).toBeUndefined();
    expect(result.unresolvedSixthMonths).toEqual([]);
    expect(result.sixthEstimates.every((entry) => entry.sixthUpper === undefined)).toBe(true);
    expect(result.nextSpecial?.tax).toBeUndefined();
    const proven = automatic(entries.map((entry) => entry.month === 3 ? {
      ...entry, usedSixth: 0, specialTaxableYtd: 0,
    } : entry));
    expect(proven.actual?.usedSixth).toBe(0);
    expect(proven.nextSpecial?.tax).toBeDefined();
  });

  it("accepts an independent same-month cumulative basis inside the bonus range, never an inconsistent basis", () => {
    const input = { regularGross: 3050, unresolvedSixthBonus: 1000, specialSv: 141.2 };
    expect(automatic([slip(1), slip(2, { ...input, regularGrossYtd: 7050 })]).actual?.sixth).toBe(7050);
    expect(automatic([slip(1), slip(2, { ...input, regularGrossYtd: 7051 })]).sixthEstimates).toEqual([]);
    expect(automatic([slip(1), slip(2, { ...input, specialSv: 1001 })]).sixthEstimates).toEqual([]);
    expect(automatic([slip(1), slip(2, input), slip(3, { regularGrossYtd: 10051 })]).sixthEstimates).toEqual([]);
  });

  it("requires documentary historical utilization even when gross anchors allow a projection", () => {
    const result = automatic([overflowSlip({ usedSixth: undefined, specialTaxableYtd: undefined })]);
    expect(result.yearEnd).toBeDefined();
    expect(result.nextSpecial?.tax).toBeUndefined();
    expect(result.nextSpecial?.utilizationSource).toBe("gross-comparison");
    expect(result.nextSpecial?.taxIssues.join(" ")).toContain("Sechstelverbrauch");
  });

  it("can model overflow with sufficient anchors and observed positive ordinary withholding", () => {
    const result = automatic([overflowSlip()]);
    expect(result.nextSpecial).toMatchObject({
      month: 11, eligibleGross: 3000, overflowGross: 1000, taxIssues: [],
      tax: { preferential: 149.27, tariff: 331.72, total: 480.99, signedOverflowDelta: 281.96 },
    });
    expect(result.forecast.standardPayrollConfirmed).toBe(false);
    expect(result.yearEnd?.tax).toBeUndefined();
  });

  it.each([
    { monthlyTaxableBase: undefined, expected: "LSt-Basis" },
    { regularTax: undefined, expected: "Absetzbeträge" },
    { regularTax: 0, expected: "nicht positiv" },
    { regularTax: 2000, expected: "übersteigt den normalisierten Tarif" },
    { reportedSixth: 5000, expected: "weicht" },
  ])("retains tax safeguards in automatic mode: %j", ({ expected, ...override }) => {
    const result = automatic([overflowSlip(override)]);
    expect(result.nextSpecial?.tax).toBeUndefined();
    expect(result.nextSpecial?.taxIssues.join(" ")).toContain(expected);
  });

  it("does not invent a special salary from gross, net or the ordinary tax base", () => {
    const result = automatic([slip(1, { regularGross: 3600, monthlyTaxableBase: 2800 })]);
    expect(result.hasSpecialPaymentModel).toBe(false);
    expect(result.nextSpecial).toBeUndefined();
    expect(result.yearEnd?.sixth).toBe(7200);
    expect(result.issues.join(" ")).toContain("PDF-Abrechnung hochladen");
    expect(automatic([slip(1, { baseSalary: 0 })]).hasSpecialPaymentModel).toBe(false);
  });

  it("never uses partial months for future projections", () => {
    const result = automatic([slip(1, { baseSalary: 3000, monthlyPayroll: false, reportedSixth: 4000 })]);
    expect(result.actual?.sixth).toBe(4000);
    expect(result.projections).toEqual([]);
    expect(result.issues.join(" ")).toContain("Teilmonate");
  });

  it("retains historical free-limit warnings despite explicit cumulative anchors", () => {
    const result = automatic([
      slip(1, { regularGross: 1000, specialGross: 1000, specialSv: 0 }),
      slip(2, {
        regularGross: 4000, specialGross: 1000, specialSv: 0,
        usedSixth: 2000, specialTaxableYtd: 2000, baseSalary: 1000,
      }),
    ]);
    expect(result.nextSpecial?.tax).toBeUndefined();
    expect(result.nextSpecial?.taxIssues.join(" ")).toContain("Freigrenzenbehandlung");
  });

  it("blocks 2027 SV estimates without asking for manually entered amounts", () => {
    const entries = [slip(1, { year: 2027, baseSalary: 3000 })];
    const result = analyzePayrollAutomatically(entries, 2027, entries[0].employer);
    expect(result.nextSpecial?.tax).toBeUndefined();
    expect(result.nextSpecial?.taxIssues.join(" ")).toContain("SV-Tabellen 2027 sind nicht verifiziert");
    expect(result.nextSpecial?.taxIssues.join(" ")).toContain("PDF-Abrechnung");
    expect(result.nextSpecial?.taxAssumptions.join(" ")).not.toContain("eingetragene");
  });

  it("isolates employer and year and handles empty or completed years", () => {
    const result = automatic([
      slip(1, { baseSalary: 3000 }),
      slip(9, { year: 2027, baseSalary: 9999 }),
      slip(11, { employer: "Anderer Betrieb", baseSalary: 8888 }),
    ]);
    expect(result.latest?.month).toBe(1);
    expect(result.nextSpecial?.specialGross).toBe(3000);
    expect(automatic([])).toMatchObject({ projections: [], hasSpecialPaymentModel: false });
    expect(automatic(months(12, { baseSalary: 3000 }))).toMatchObject({
      actual: { month: 12, controlSixth: 6000 }, projections: [],
    });
  });
});

describe("payroll actual aggregation", () => {
  it("supports the empty initial screen without an employer or imported records", () => {
    const result = analyzePayroll([], 2026, "");
    expect(result).toMatchObject({
      missingMonths: [],
      forecast: { year: 2026, employer: "", months: [], standardPayrollConfirmed: false },
      projections: [],
    });
    expect(result.actual).toBeUndefined();
    expect(result.latest).toBeUndefined();
    expect(result.nextSpecial).toBeUndefined();
    expect(result.yearEnd).toBeUndefined();
    expect(result.issues.join(" ")).toContain("noch keine Abrechnung");
  });

  it("reports January as January, never as the current calendar month", () => {
    const result = analyze([slip(1)]);
    expect(result.actual).toMatchObject({
      month: 1, regularGrossYtd: 3000, specialGrossYtd: 0, sixth: 6000,
      source: "calculated", usedSixth: 0, specialTaxableYtd: 0, remaining: 6000,
    });
    expect(result.forecast.standardPayrollConfirmed).toBe(false);
    expect(result.projections.find((entry) => entry.month === 9)?.source).toBe("scenario");
    expect(result.yearEnd?.regularGrossYtd).toBe(36000);
  });

  it("does not invent missing gross or historical special payments", () => {
    const result = analyze([slip(1), slip(9)]);
    expect(result.missingMonths).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(result.actual).toBeUndefined();
    expect(result.projections).toEqual([]);
    expect(result.issues.join(" ")).toContain("nicht 0 € Sonderzahlungen");
  });

  it("can show a reported sixth without invented cumulative totals", () => {
    const result = analyze([slip(9, { reportedSixth: 5100 })]);
    expect(result.actual).toMatchObject({ month: 9, sixth: 5100, source: "reported" });
    expect(result.actual?.regularGrossYtd).toBeUndefined();
    expect(result.actual?.specialGrossYtd).toBeUndefined();
    expect(result.actual?.remaining).toBeUndefined();
    expect(result.projections).toEqual([]);
  });

  it("accepts explicit cumulative values for a later employment without assuming missing months zero", () => {
    const result = analyze([slip(9, {
      regularGrossYtd: 9000, specialGrossYtd: 0,
    })]);
    expect(result.actual).toMatchObject({
      regularGrossYtd: 9000, specialGrossYtd: 0, sixth: 2000,
      usedSixth: 0, specialTaxableYtd: 0,
    });
    expect(result.yearEnd).toMatchObject({ regularGrossYtd: 18000, sixth: 3000 });
  });

  it("carries an explicit cumulative anchor forward only over contiguous actual months", () => {
    const anchor = slip(7, { regularGrossYtd: 15000, specialGrossYtd: 2400 });
    const complete = analyze([anchor, slip(8), slip(9)]);
    expect(complete.actual).toMatchObject({ regularGrossYtd: 21000, specialGrossYtd: 2400 });
    const incomplete = analyze([anchor, slip(9, { reportedSixth: 4800 })]);
    expect(incomplete.actual?.regularGrossYtd).toBeUndefined();
    expect(incomplete.projections).toEqual([]);
  });

  it("prefers the payslip sixth, including an explicit zero", () => {
    expect(analyze([slip(1, { reportedSixth: 5250 })]).actual?.sixth).toBe(5250);
    expect(analyze([slip(1, { reportedSixth: 0 })]).actual?.sixth).toBe(0);
  });

  it("does not infer a sixth before the first ordinary payment", () => {
    const result = analyze([slip(1, { regularGross: 0, specialGross: 1000 })]);
    expect(result.actual).toBeUndefined();
    expect(result.projections).toEqual([]);
    expect(result.issues.join(" ")).toContain("ersten laufenden Bezug");
    expect(analyze([slip(1, { regularGross: 0, specialGross: 0 })]).actual?.sixth).toBe(0);
  });

  it("isolates year and normalized employer for actuals and forecast defaults", () => {
    const entries = [
      slip(1, { employer: "  SYNTHETISCHER   Testbetrieb  ", regularGross: 3100 }),
      slip(11, { year: 2027, regularGross: 9999 }),
      slip(12, { employer: "Anderer Arbeitgeber", regularGross: 8000 }),
    ];
    expect(analyze(entries).actual).toMatchObject({ month: 1, regularGrossYtd: 3100 });
    expect(defaultPayrollForecast(entries, 2026, "Synthetischer Testbetrieb").months[0].regularGross).toBe(3100);
  });

  it("rejects duplicate periods rather than double counting", () => {
    const result = analyze([slip(1), slip(1, { employer: "SYNTHETISCHER TESTBETRIEB" })]);
    expect(result.actual).toBeUndefined();
    expect(result.projections).toEqual([]);
    expect(result.issues.join(" ")).toContain("doppelte Abrechnung");
  });

  it("does not use a partial-month payslip to infer a sixth or future payroll", () => {
    const result = analyze([slip(1, { monthlyPayroll: false, reportedSixth: 4000 })]);
    expect(result.actual).toMatchObject({ sixth: 4000, source: "reported" });
    expect(result.projections).toEqual([]);
    expect(result.issues.join(" ")).toContain("Teilmonate");
  });

  it("reports December control separately from a reported actual sixth", () => {
    const result = analyze([...months(11), slip(12, { reportedSixth: 6500 })]);
    expect(result.actual).toMatchObject({ sixth: 6500, controlSixth: 6000 });
    expect(result.projections).toEqual([]);
    expect(result.yearEnd).toBeUndefined();
  });

  it.each([
    { regularSv: 3001 },
    { specialSv: 1 },
    { regularGrossYtd: 2999 },
    { specialGrossYtd: 100, specialGross: 101 },
    { usedSixth: 1 },
    { specialTaxableYtd: 1 },
    { regularGross: 3000.001 },
    { regularGross: -1 },
    { regularGross: Infinity },
    { month: 0 },
    { month: 13 },
    { month: 1.5 },
  ])("blocks inconsistent actual input %j", (invalid) => {
    const result = analyze([slip(1, invalid)]);
    expect(result.actual).toBeUndefined();
    expect(result.projections).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("detects cumulative totals inconsistent with complete actual months", () => {
    const result = analyze([slip(1), slip(2, { regularGrossYtd: 6500 })]);
    expect(result.actual).toBeUndefined();
    expect(result.issues.join(" ")).toContain("Korrektur");
  });

  it("rejects cumulative totals smaller than known months even when intervening months are missing", () => {
    const result = analyze([slip(3), slip(9, { regularGrossYtd: 5000, specialGrossYtd: 0 })]);
    expect(result.actual).toBeUndefined();
    expect(result.issues.join(" ")).toContain("Summe der vorhandenen Monatsbeträge");
  });

  it("blocks downward utilization corrections rather than silently treating them as allowance", () => {
    const result = analyze([
      slip(8, { regularGrossYtd: 24000, specialGrossYtd: 3000, usedSixth: 3000, specialTaxableYtd: 2400 }),
      slip(9, { usedSixth: 2800, specialTaxableYtd: 2200 }),
    ]);
    expect(result.actual).toBeUndefined();
    expect(result.issues.join(" ")).toContain("Aufrollung");
  });

  it("returns a clear empty result without accessing other employers", () => {
    const result = analyze([slip(1, { employer: "Nicht ausgewählt" })]);
    expect(result.latest).toBeUndefined();
    expect(result.forecast.months).toEqual([]);
    expect(result.actual).toBeUndefined();
    expect(result.issues).toHaveLength(1);
  });
});

describe("explicit future payroll scenarios", () => {
  it("retains intervening modeled specials when the UI selects an upcoming September-or-later payment", () => {
    const result = analyze([slip(1, { baseSalary: 3000 })]);
    const upcoming = result.projections.find((projection) => projection.month >= 9 && projection.specialGross > 0);
    expect(result.projections.map((projection) => projection.month)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(result.nextSpecial?.month).toBe(6);
    expect(upcoming).toMatchObject({ month: 11, specialGrossYtd: 6000, remaining: 0 });
    expect(result.actual).toMatchObject({ month: 1, specialGrossYtd: 0 });
    expect(payrollTaxSources.every((source) => source.href.startsWith("https://"))).toBe(true);
  });

  it("suggests June and November using explicit base salary, not a variable month", () => {
    const entries = [slip(1, { regularGross: 3600, baseSalary: 2800 })];
    const defaults = forecastFor(entries);
    expect(defaults.standardPayrollConfirmed).toBe(false);
    expect(defaults.months.filter((entry) => entry.specialGross > 0).map((entry) => [entry.month, entry.specialGross]))
      .toEqual([[6, 2800], [11, 2800]]);
    expect(defaults.months.every((entry) => entry.regularGross === 3600)).toBe(true);
    expect(defaults.months.filter((entry) => entry.specialGross > 0).map((entry) => entry.specialSv)).toEqual([477.96, 477.96]);
    expect(analyze(entries).nextSpecial?.tax).toBeUndefined();
    expect(analyze(entries).nextSpecial?.taxAssumptions.join(" ")).toContain("kein festgestellter");
    expect(forecastFor([slip(1, { regularGross: 3600 })]).months.every((entry) => entry.specialGross === 0)).toBe(true);
  });

  describe("confirmed Austrian payroll tax scenarios", () => {
    function scenario(options: {
      year?: 2026 | 2027;
      regularGross?: number;
      regularGrossYtd?: number;
      specialGrossYtd?: number;
      usedSixth?: number;
      specialTaxableYtd?: number;
      monthlyTaxableBase?: number;
      regularTax?: number;
      specialGross: number;
      specialSv?: number;
      projectedBase?: number;
      projectedGross?: number;
      confirmed?: boolean;
    }) {
      const year = options.year ?? 2026;
      const latest = slip(9, {
        year,
        regularGross: options.regularGross ?? 5000,
        regularGrossYtd: options.regularGrossYtd ?? 45000,
        specialGrossYtd: options.specialGrossYtd ?? 7000,
        usedSixth: options.usedSixth ?? 7000,
        specialTaxableYtd: options.specialTaxableYtd ?? 620,
        monthlyTaxableBase: options.monthlyTaxableBase,
        regularTax: options.regularTax,
      });
      return analyzePayroll([latest], year, latest.employer, {
        year,
        employer: latest.employer,
        standardPayrollConfirmed: options.confirmed ?? true,
        months: [{
          month: 10,
          regularGross: options.projectedGross ?? latest.regularGross,
          specialGross: options.specialGross,
          specialSv: options.specialSv,
          monthlyTaxableBase: options.projectedBase ?? latest.monthlyTaxableBase,
        }],
      });
    }

    it("matches the verified proportional-SV overflow example in the 40% bracket", () => {
      const result = scenario({
        specialGross: 4000, specialSv: 682.8, monthlyTaxableBase: 4000, regularTax: 500,
      });
      expect(result.nextSpecial).toMatchObject({ eligibleGross: 3000, overflowGross: 1000 });
      expect(result.nextSpecial?.tax).toEqual({
        preferential: 149.27, tariff: 331.72, total: 480.99, extraDueToOverflow: 281.96,
        reductionDueToOverflow: 0, signedOverflowDelta: 281.96, netSpecial: 2836.21,
      });
      expect(result.nextSpecial?.taxIssues).toEqual([]);
    });

    it("computes clean confirmed January scenarios with assumed standard SV and uses 620 only once", () => {
      const entries = [slip(1, { baseSalary: 3000 })];
      const result = analyze(entries, forecastFor(entries, { standardPayrollConfirmed: true }));
      expect(result.nextSpecial?.tax).toMatchObject({
        preferential: 112.07, tariff: 0, total: 112.07, extraDueToOverflow: 0, netSpecial: 2375.83,
      });
      expect(result.projections.find((entry) => entry.month === 11)?.tax).toMatchObject({
        preferential: 149.27, tariff: 0, total: 149.27,
      });
      expect(result.actual?.month).toBe(1);
      expect(result.yearEnd?.tax).toBeUndefined();
    });

    it("does not calculate monetary estimates until the whole standard scenario is confirmed", () => {
      const result = scenario({
        specialGross: 4000, specialSv: 682.8, monthlyTaxableBase: 4000, regularTax: 500, confirmed: false,
      });
      expect(result.nextSpecial?.tax).toBeUndefined();
      expect(result.nextSpecial?.taxIssues.join(" ")).toContain("noch nicht bestätigt");
    });

    it("requires explicit future SV when an edited special no longer uses the template", () => {
      const result = scenario({ specialGross: 4000, monthlyTaxableBase: 4000, regularTax: 500 });
      expect(result.nextSpecial?.tax).toBeUndefined();
      expect(result.nextSpecial?.taxIssues.join(" ")).toContain("SV der geplanten");
    });

    it("keeps an explicitly cleared ordinary tax base unknown at unchanged gross", () => {
      const entries = [slip(9, {
        regularGross: 5000, regularGrossYtd: 45000, specialGrossYtd: 7000,
        usedSixth: 7000, specialTaxableYtd: 620, monthlyTaxableBase: 4000, regularTax: 500,
      })];
      const result = analyze(entries, forecastFor(entries, {
        standardPayrollConfirmed: true,
        months: [{ month: 10, regularGross: 5000, specialGross: 4000, specialSv: 682.8 }],
      }));
      expect(result.nextSpecial?.tax).toBeUndefined();
      expect(result.nextSpecial?.taxIssues.join(" ")).toContain("LSt-Basis");
      expect(result.forecast.months[0].monthlyTaxableBase).toBeUndefined();
    });

    it("preserves the reported sixth but blocks tax based on an inconsistent reconstructed gross", () => {
      const entries = [slip(1, { reportedSixth: 5000, baseSalary: 3000 })];
      const result = analyze(entries, forecastFor(entries, { standardPayrollConfirmed: true }));
      expect(result.actual?.sixth).toBe(5000);
      expect(result.yearEnd?.sixth).toBe(6000);
      expect(result.nextSpecial?.tax).toBeUndefined();
      expect(result.nextSpecial?.taxIssues.join(" ")).toContain("weicht");
    });

    it("does not clear a known historical exemption transition using only gross and base anchors", () => {
      const entries = [
        slip(1, { regularGross: 1000, specialGross: 1000, specialSv: 0 }),
        slip(2, { regularGross: 4000, specialGross: 1000, specialSv: 0, usedSixth: 2000, specialTaxableYtd: 2000 }),
      ];
      const result = analyze(entries, forecastFor(entries, {
        standardPayrollConfirmed: true,
        months: [{ month: 3, regularGross: 4000, specialGross: 1000, specialSv: 0 }],
      }));
      expect(result.nextSpecial?.tax).toBeUndefined();
      expect(result.nextSpecial?.taxIssues.join(" ")).toContain("Freigrenzenbehandlung");
    });

    it("propagates unknown SV from an intervening projected payment rather than reusing 620", () => {
      const entries = [slip(1, { baseSalary: 3000 })];
      const result = analyze(entries, forecastFor(entries, {
        standardPayrollConfirmed: true,
        months: [
          { month: 6, regularGross: 3000, specialGross: 3000 },
          { month: 11, regularGross: 3000, specialGross: 3000, specialSv: 512.1 },
        ],
      }));
      const november = result.projections.find((entry) => entry.month === 11);
      expect(november?.tax).toBeUndefined();
      expect(november?.taxIssues.join(" ")).toContain("modellierter Sonderzahlungen ist unbekannt");
    });

    it.each([
      { monthlyTaxableBase: undefined, regularTax: 500, expected: "LSt-Basis" },
      { monthlyTaxableBase: 4000, regularTax: undefined, expected: "Absetzbeträge" },
      { monthlyTaxableBase: 4000, regularTax: 0, expected: "nicht positiv" },
      { monthlyTaxableBase: 4000, regularTax: 2000, expected: "übersteigt den normalisierten Tarif" },
    ])("blocks unsafe ordinary withholding assumptions %j", ({ expected, ...ordinary }) => {
      const result = scenario({ ...ordinary, specialGross: 4000, specialSv: 682.8 });
      expect(result.nextSpecial?.tax).toBeUndefined();
      expect(result.nextSpecial?.taxIssues.join(" ")).toContain(expected);
    });

    it("checks positive projected withholding after reducing the future ordinary tax base", () => {
      const result = scenario({
        specialGross: 4000, specialSv: 682.8, monthlyTaxableBase: 4000, regularTax: 500,
        projectedBase: 1500,
      });
      expect(result.nextSpecial?.tax).toBeUndefined();
      expect(result.nextSpecial?.taxIssues.join(" ")).toContain("Prognosemonat nicht positiv");
    });

    it("subtracts the annual 132 allowance before applying monthly marginal brackets", () => {
      const result = scenario({
        specialGross: 3100, specialSv: 0, monthlyTaxableBase: 36458 / 12 + 11 - 50,
        regularTax: 400,
      });
      // Monetary inputs must be cent-precise; use a separate rounded boundary scenario.
      expect(result.projections).toEqual([]);
      const rounded = scenario({
        specialGross: 3100, specialSv: 0, monthlyTaxableBase: 2999.17, regularTax: 400,
      });
      expect(rounded.nextSpecial?.tax?.tariff).toBe(35);
    });

    it("preserves negative overflow deltas as reductions, never negative extra tax", () => {
      const result = scenario({
        specialGross: 4000, specialSv: 0, monthlyTaxableBase: 0, regularTax: undefined,
      });
      expect(result.nextSpecial?.tax).toMatchObject({
        preferential: 180, tariff: 0, total: 180, signedOverflowDelta: -60,
        extraDueToOverflow: 0, reductionDueToOverflow: 60, netSpecial: 3820,
      });
    });

    it.each([
      [2026, 1307.5, 2615],
      [2027, 1337.5, 2675],
    ] as const)("honors the inclusive %i sixth free limit", (year, gross, sixth) => {
      const result = scenario({
        year, regularGross: gross, regularGrossYtd: gross * 9,
        specialGrossYtd: 0, usedSixth: 0, specialTaxableYtd: 0,
        specialGross: 2000, specialSv: 300,
      });
      expect(result.nextSpecial).toMatchObject({ sixth, tax: { preferential: 0, total: 0 } });
    });

    it("still applies the monthly tariff to overflow despite an exempt inside-sixth portion", () => {
      const result = scenario({
        regularGross: 1300, regularGrossYtd: 11700,
        specialGrossYtd: 0, usedSixth: 0, specialTaxableYtd: 0,
        monthlyTaxableBase: 1200, regularTax: 5,
        specialGross: 4000, specialSv: 0,
      });
      expect(result.nextSpecial?.tax).toMatchObject({ preferential: 0, tariff: 355.63, total: 355.63 });
    });

    it("blocks an exemption-regime change after a previous projected special", () => {
      const entries = [slip(1, { regularGross: 1000, monthlyTaxableBase: 800 })];
      const result = analyze(entries, forecastFor(entries, {
        standardPayrollConfirmed: true,
        months: [
          { month: 2, regularGross: 1000, specialGross: 1000, specialSv: 141.2 },
          { month: 3, regularGross: 4000, specialGross: 1000, specialSv: 141.2, monthlyTaxableBase: 3300 },
        ],
      }));
      expect(result.nextSpecial?.tax?.total).toBe(0);
      const march = result.projections.find((entry) => entry.month === 3);
      expect(march?.tax).toBeUndefined();
      expect(march?.taxIssues.join(" ")).toContain("Freigrenzenbehandlung");
    });

    it.each([
      [24000, 2000, 330],
      [49000, 2000, 627.5],
      [620, 1000, 60],
      [0, 620, 0],
    ])("uses cumulative preferential bands from %i plus %i", (prior, gross, tax) => {
      const result = scenario({
        regularGross: 50000, regularGrossYtd: 450000,
        specialGrossYtd: prior, usedSixth: prior, specialTaxableYtd: prior,
        specialGross: gross, specialSv: 0,
      });
      expect(result.nextSpecial?.tax?.preferential).toBe(tax);
    });

    it("blocks the upper preferential-band excess instead of plateauing the tax", () => {
      const result = scenario({
        regularGross: 50000, regularGrossYtd: 450000,
        specialGrossYtd: 83000, usedSixth: 83000, specialTaxableYtd: 83000,
        specialGross: 334, specialSv: 0,
      });
      expect(result.nextSpecial?.tax).toBeUndefined();
      expect(result.nextSpecial?.taxIssues.join(" ")).toContain("83.333");
    });

    it("supports enacted 2027 income tax while requiring explicit 2027 SV", () => {
      const entries = [slip(1, { year: 2027, baseSalary: 3000 })];
      expect(defaultPayrollForecast(entries, 2027, entries[0].employer).months.every((entry) => entry.specialSv === undefined)).toBe(true);
      const blocked = scenario({ year: 2027, specialGross: 4000, monthlyTaxableBase: 4000, regularTax: 500 });
      expect(blocked.nextSpecial?.taxIssues.join(" ")).toContain("SV-Tabellen 2027");
      const result = scenario({
        year: 2027, specialGross: 4000, specialSv: 682.8, monthlyTaxableBase: 4000, regularTax: 500,
      });
      expect(result.nextSpecial?.tax).toMatchObject({ preferential: 149.27, tariff: 331.72, total: 480.99 });
    });

    it.each([[2026, 395.08], [2027, 388.19]] as const)(
      "uses the enacted %i tariff thresholds when the overflow crosses a bracket",
      (year, tariff) => {
        const result = scenario({
          year, specialGross: 4000, specialSv: 0, monthlyTaxableBase: 3000, regularTax: 300,
        });
        expect(result.nextSpecial?.tax?.tariff).toBe(tariff);
      },
    );

    it("does not turn the December annual gross gap into a second tax liability", () => {
      const result = scenario({
        specialGross: 4000, specialSv: 682.8, monthlyTaxableBase: 4000, regularTax: 500,
      });
      expect(result.nextSpecial?.tax?.extraDueToOverflow).toBe(281.96);
      expect(result.yearEnd?.overhang).toBe(1000);
      expect(result.yearEnd?.tax).toBeUndefined();
      expect(result.yearEnd?.taxAssumptions.join(" ")).toContain("keine neue Dezember-Steuerschuld");
      expect(result.nextSpecial?.taxAssumptions.join(" ")).toContain("30%-Einschleif-Aufrollung");
    });
  });

  describe("2026 standard employee SV forecast templates", () => {
    it.each([
      [2225, 314.17],
      [2225.01, 336.42],
      [2427, 366.96],
      [2427.01, 391.23],
      [2630, 423.96],
      [2630.01, 448.94],
    ])("uses gross %i for the monthly reduced AV band", (gross, sv) => {
      const defaults = forecastFor([slip(1, { baseSalary: gross })]);
      expect(defaults.months.find((entry) => entry.month === 6)?.specialSv).toBe(sv);
      expect(defaults.standardPayrollConfirmed).toBe(false);
    });

    it("limits annual SV gross and tests low AV on gross before the cap", () => {
      const entries = [slip(9, {
        regularGrossYtd: 27000, specialGrossYtd: 13000, baseSalary: 3000,
        usedSixth: 6000, specialTaxableYtd: 4900,
      })];
      expect(forecastFor(entries).months.find((entry) => entry.month === 11)?.specialSv).toBe(146.8);
    });

    it("recalculates newly filled template months after an earlier saved gross payment", () => {
      const entries = [slip(1, { baseSalary: 10000 })];
      const result = analyze(entries, forecastFor(entries, {
        months: [{ month: 6, regularGross: 3000, specialGross: 13000, specialSv: 2219.1 }],
      }));
      expect(result.forecast.months.find((entry) => entry.month === 11)?.specialSv).toBe(146.8);
    });

    it("does not estimate historical or future SV from an unknown previous annual gross", () => {
      const defaults = forecastFor([slip(9, { baseSalary: 3000, regularGrossYtd: 27000 })]);
      expect(defaults.months.every((entry) => entry.specialSv === undefined)).toBe(true);
    });
  });

  it("merges only missing future months and never counts forecast actual months", () => {
    const entries = months(9);
    const saved = forecastFor(entries, {
      standardPayrollConfirmed: true,
      months: [
        { month: 1, regularGross: 99999, specialGross: 99999 },
        { month: 11, regularGross: 3500, specialGross: 2800, specialSv: 470 },
      ],
    });
    const result = analyze(entries, saved);
    expect(result.forecast.months.map((entry) => entry.month)).toEqual([10, 11, 12]);
    expect(result.yearEnd).toMatchObject({
      regularGrossYtd: 36500, specialGrossYtd: 2800, sixth: 6083.33,
    });
    expect(result.forecast.months[1].monthlyTaxableBase).toBeUndefined();
    expect(result.forecast.months[0].monthlyTaxableBase).toBe(2450);
    expect(result.nextSpecial?.month).toBe(11);
  });

  it("preserves user future values when a new import changes the monthly basis", () => {
    const entries = [...months(8), slip(9, { regularGross: 3700 })];
    const saved = forecastFor(months(8), { months: [
      { month: 10, regularGross: 3200, specialGross: 0, monthlyTaxableBase: 2600 },
    ] });
    const result = analyze(entries, saved);
    expect(result.forecast.months[0]).toMatchObject({ regularGross: 3200, monthlyTaxableBase: 2600 });
    expect(result.forecast.months[1].regularGross).toBe(3700);
  });

  it("does not reuse a different employer's saved assumptions or confirmation", () => {
    const entries = [slip(1)];
    const result = analyze(entries, forecastFor(entries, {
      employer: "Anderer Betrieb", standardPayrollConfirmed: true,
    }));
    expect(result.forecast.standardPayrollConfirmed).toBe(false);
    expect(result.issues.join(" ")).toContain("anderen Jahr oder Arbeitgeber");
  });

  it("separates current, next-payment and year-end sixth under variable future pay", () => {
    const entries = months(5);
    const result = analyze(entries, forecastFor(entries, {
      months: [
        { month: 6, regularGross: 3600, specialGross: 4000 },
        { month: 11, regularGross: 3300, specialGross: 4000 },
      ],
    }));
    expect(result.actual?.sixth).toBe(6000);
    expect(result.nextSpecial).toMatchObject({ month: 6, sixth: 6200, eligibleGross: 4000, overflowGross: 0 });
    expect(result.projections.find((entry) => entry.month === 11)).toMatchObject({
      sixth: 6163.64, eligibleGross: 2163.64, overflowGross: 1836.36,
    });
    expect(result.yearEnd).toMatchObject({ sixth: 6150, controlSixth: 6150, overhang: 1850 });
  });

  it("does not claim a current special payment is entirely eligible after previous overflow", () => {
    const entries = [...months(5), slip(6, { specialGross: 6500, specialSv: 1100 })];
    const result = analyze(entries, forecastFor(entries, {
      standardPayrollConfirmed: true,
      months: [{ month: 11, regularGross: 3000, specialGross: 3000, specialSv: 500 }],
    }));
    expect(result.actual?.usedSixth).toBe(6000);
    expect(result.nextSpecial).toMatchObject({ eligibleGross: 0, overflowGross: 3000 });
    expect(result.nextSpecial?.tax).toBeUndefined();
    expect(result.nextSpecial?.taxIssues.join(" ")).toContain("Früherer Sechstelüberhang");
  });

  it("requires historical eligible tax base even if cumulative gross is available", () => {
    const entries = [slip(9, { regularGrossYtd: 27000, specialGrossYtd: 3000 })];
    const result = analyze(entries, forecastFor(entries, {
      standardPayrollConfirmed: true,
      months: [{ month: 11, regularGross: 3000, specialGross: 3000, specialSv: 500 }],
    }));
    expect(result.actual?.usedSixth).toBeUndefined();
    expect(result.nextSpecial?.tax).toBeUndefined();
    expect(result.nextSpecial?.taxIssues.join(" ")).toContain("Sechstelverbrauch");
    expect(result.nextSpecial?.utilizationSource).toBe("gross-comparison");
    expect(result.nextSpecial?.taxAssumptions.join(" ")).toContain("keine gesicherte Aufteilung");
  });

  it("accepts reported utilization as an explicit historical anchor", () => {
    const result = analyze([slip(9, {
      regularGrossYtd: 27000, specialGrossYtd: 3000, usedSixth: 2800, specialTaxableYtd: 2300,
    })]);
    expect(result.actual).toMatchObject({ usedSixth: 2800, specialTaxableYtd: 2300, remaining: 3200 });
  });

  it("requires past special SV rather than treating it as zero", () => {
    const entries = [...months(5), slip(6, { specialGross: 3000 })];
    const result = analyze(entries, forecastFor(entries, {
      months: [{ month: 11, regularGross: 3000, specialGross: 3000, specialSv: 500 }],
    }));
    expect(result.nextSpecial?.taxIssues.join(" ")).toContain("SV früherer");
    expect(result.actual?.specialTaxableYtd).toBeUndefined();
  });

  it("does not mutate imported or saved objects", () => {
    const entries = [slip(1, { baseSalary: 2800 })];
    const saved = forecastFor(entries);
    const before = JSON.stringify({ entries, saved });
    analyze(entries, saved);
    expect(JSON.stringify({ entries, saved })).toBe(before);
  });
});
