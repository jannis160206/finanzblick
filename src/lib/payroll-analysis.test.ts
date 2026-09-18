import { describe, expect, it } from "vitest";
import { analyzePayroll, defaultPayrollForecast, payrollTaxSources } from "@/lib/payroll-analysis";
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
