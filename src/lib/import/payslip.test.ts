import { describe, expect, it } from "vitest";
import { payslipSchema } from "@/lib/payslip-schema";
import { parsePayslipPages, type PayslipLine, type PayslipPage } from "./payslip";

const line = (y: number, ...items: [number, string, number?][]): PayslipLine => ({
  y, items: items.map(([x, text, width]) => ({ x, text, width })),
});
const table = line(510, [54, "LA-Nr."], [89, "Bezeichnung"], [254, "Menge"],
  [329, "Satz"], [392, "Betrag"], [455, "BMG SV"], [526, "BMG LSt"]);
const wage = (y: number, code: string, label: string, amount: string, sv = amount, tax = amount) =>
  line(y, [54, code], [89, label], [254, "2,00"], [329, "20,00"],
    [379, amount, 36], [451, sv, 35], [525, tax, 37]);

function page(overrides: {
  month?: string; year?: number; employer?: string; days?: string;
  rows?: PayslipLine[]; gross?: string; tail?: PayslipLine[];
} = {}): PayslipPage {
  return {
    lines: [
      line(800, [50, `Lohn / Gehaltsabrechnung ${overrides.month ?? "Jänner"} ${overrides.year ?? 2026}`]),
      line(765, [50, overrides.employer ?? "Fabelwald Robotik GmbH"]),
      line(720, [50, "Arbeitnehmer: Synthetische Testperson"]),
      line(700, [50, "Personalnummer: 777777"]),
      line(550, [290, "LSt-Tg"], [350, "SV-Tg"]),
      line(538, [298, overrides.days ?? "30"], [358, overrides.days ?? "30"]),
      table,
      ...(overrides.rows ?? [
        wage(490, "1000", "Gehalt", "2.810,20"),
        wage(475, "2751", "Telearbeitspauschale frei", "18,00", "", ""),
        wage(460, "3100", "ÜStd-Grundlohn", "140,25"),
        wage(445, "3150", "ÜStd.ZS100%pfl", "55,50"),
        wage(430, "3160", "ÜStd.ZS100%fr", "71,30"),
        wage(415, "4621", "Rufbereitschaft", "302,75"),
        line(400, [54, "7590"], [89, "Telearbeitstage"], [254, "6,00"]),
        line(385, [54, "9110"], [89, "Freibetrag §68(1)"], [525, "-49,10"]),
        line(370, [54, "9120"], [89, "Freibetrag §68(2)"], [525, "-22,20"]),
      ]),
      line(340, [89, "Brutto"], [379, overrides.gross ?? "3.398,00"]),
      line(325, [89, "Abzüge"]),
      line(310, [89, "SV Beitrag lfd"], [379, "-604,32"], [451, "3.380,00"]),
      line(295, [89, "LSt Beitrag lfd"], [379, "-411,60"], [525, "2.704,38"]),
      line(280, [89, "Netto"], [379, "2.382,08"]),
      wage(265, "7999", "Bereits überwiesen", "2.300,00"),
      wage(250, "9590", "Betriebsrat", "7,00"),
      ...(overrides.tail ?? []),
    ],
  };
}

function bonusPage(): PayslipPage {
  const input = page({
    month: "Februar", gross: "4.060,00",
    rows: [
      wage(490, "1000", "Gehalt", "3.000,00"),
      line(475, [61, "1509 VEB-Prämie"], [379, "1.000,00"], [451, "1.000,00"], [525, "1.000,00"]),
      wage(460, "3160", "ÜStd.ZS100%fr", "50,00"),
      wage(445, "2751", "Telearbeitspauschale frei", "10,00", "", ""),
      line(430, [54, "9110"], [89, "Freibetrag §68(1)"], [525, "-50,00"]),
    ],
    tail: [line(302, [89, "SV Beitrag SZ"], [379, "-141,20"], [451, "1.000,00"])],
  });
  return { lines: input.lines.map((entry) => entry.y === 310
    ? line(310, [89, "SV Beitrag lfd"], [379, "-549,00"], [451, "3.050,00"])
    : entry.y === 295
      ? line(295, [89, "LSt Beitrag lfd"], [379, "-300,00"], [525, "3.309,80"])
      : entry) };
}

describe("positioned Austrian payslip parsing (entirely synthetic)", () => {
  it("imports a reconciled VEB bonus without confusing tariff taxation with sixth relevance", () => {
    const result = parsePayslipPages([bonusPage()]);
    expect(payslipSchema.parse(result.drafts[0])).toMatchObject({
      month: 2, regularGross: 3050, specialGross: 0, unresolvedSixthBonus: 1000,
      regularSv: 549, specialSv: 141.2, monthlyTaxableBase: 3309.8,
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("VEB-Prämie erkannt");
    expect(result.issues[0]).toContain("Schätzspanne");
    expect(JSON.stringify(result)).not.toContain("Testperson");
  });

  it.each([
    line(475, [61, "1509 VEB-Prämie"], [379, "1.000,00"], [451, "900,00"], [525, "1.000,00"]),
    line(475, [61, "1509 VEB-Prämie"], [379, "1.000,00"], [451, "1.000,00"]),
    line(310, [89, "SV Beitrag lfd"], [379, "-549,00"], [451, "3.000,00"]),
    line(302, [89, "SV Beitrag SZ"], [379, "-141,20"], [451, "900,00"]),
    line(295, [89, "LSt Beitrag lfd"], [379, "-300,00"], [525, "3.309,82"]),
    line(430, [54, "9110"], [89, "Freibetrag §68(1)"]),
    line(445, [54, "2751"], [89, "Telearbeitspauschale frei"], [379, "10,00"], [525, "10,00"]),
  ])("rejects an unsupported or incomplete VEB reconciliation: %j", (replacement) => {
    const result = parsePayslipPages([{
      lines: bonusPage().lines.map((entry) => entry.y === replacement.y ? replacement : entry),
    }]);
    expect(payslipSchema.safeParse(result.drafts[0]).success).toBe(false);
    expect(result.drafts[0].unresolvedSixthBonus).toBeUndefined();
    expect(result.issues.join()).toContain("VEB-Prämie nicht eindeutig");
  });

  it.each([
    (lines: readonly PayslipLine[]) => lines.filter((entry) => entry.y !== 302),
    (lines: readonly PayslipLine[]) => [...lines, line(301, [89, "SV Beitrag SZ"], [379, "-141,20"], [451, "1.000,00"])],
    (lines: readonly PayslipLine[]) => [...lines, line(290, [89, "LSt Beitrag SZ"], [379, "0,00"], [525, "100,00"])],
  ])("does not infer VEB treatment from a missing, duplicate or competing special-payment base", (alter) => {
    const result = parsePayslipPages([{ lines: alter(bonusPage().lines) }]);
    expect(payslipSchema.safeParse(result.drafts[0]).success).toBe(false);
    expect(result.issues.join()).toContain("VEB-Prämie nicht eindeutig");
  });

  it("does not whitelist wage code 1509 or unrelated premium names", () => {
    const result = parsePayslipPages([{
      lines: bonusPage().lines.map((entry) => entry.y === 475
        ? line(475, [61, "1509 Andere Prämie"], [379, "1.000,00"], [451, "1.000,00"], [525, "1.000,00"]) : entry),
    }]);
    expect(payslipSchema.safeParse(result.drafts[0]).success).toBe(false);
    expect(result.issues.join()).toContain("Nicht unterstützter Bezugsbestandteil (Lohnart 1509)");
  });

  it("extracts the company name from a numbered Firma header without storing its internal ID", () => {
    const input = page();
    const result = parsePayslipPages([{
      lines: input.lines.map((entry) => entry.y === 765
        ? line(765, [54, "Firma"], [133, ":"], [144, "123456"], [218, "Fabelwald Robotik GmbH"])
        : entry),
    }]);
    expect(result.issues).toEqual([]);
    expect(result.drafts[0]).toMatchObject({
      employer: "Fabelwald Robotik GmbH", regularGross: 3380, specialGross: 0,
    });
    expect(JSON.stringify(result)).not.toContain("123456");
    expect(JSON.stringify(result)).not.toContain("Testperson");
  });

  it("recognizes a numbered employer in every month without copying it between documents", () => {
    const result = parsePayslipPages(["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August"].map((month) => ({
      lines: page({ month }).lines.map((entry) => entry.y === 765
        ? line(765, [54, "Firma"], [133, ":"], [144, "123456"], [218, "Fabelwald Robotik GmbH"])
        : entry),
    })));
    expect(result.drafts).toHaveLength(8);
    expect(result.drafts.every((draft) => draft.employer === "Fabelwald Robotik GmbH")).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("does not strip digits from ordinary company names or use numbered person headers as employers", () => {
    const input = page();
    const realName = parsePayslipPages([{
      lines: input.lines.map((entry) => entry.y === 765 ? line(765, [54, "Firma:"], [218, "3D Robotik GmbH"]) : entry),
    }]);
    expect(realName.drafts[0].employer).toBe("3D Robotik GmbH");
    const missing = parsePayslipPages([{
      lines: input.lines.map((entry) => entry.y === 765
        ? line(765, [54, "Person"], [133, ":"], [144, "123456"], [218, "Fabelwald Robotik GmbH"])
        : entry),
    }]);
    expect(missing.drafts[0].employer).toBeUndefined();
    expect(missing.issues.join()).toContain("Arbeitgeber nicht eindeutig");
  });

  it("keeps conflicting numbered employer headers unresolved", () => {
    const result = parsePayslipPages([{
      lines: [
        ...page().lines.filter((entry) => entry.y !== 765),
        line(765, [54, "Firma"], [133, ":"], [144, "123456"], [218, "Fabelwald Robotik GmbH"]),
        line(750, [54, "Firma"], [133, ":"], [144, "654321"], [218, "Wolkenrad Technik AG"]),
      ],
    }]);
    expect(result.drafts[0].employer).toBeUndefined();
    expect(result.issues.join()).toContain("Arbeitgeber nicht eindeutig");
  });

  it("uses Betrag rather than the last money and keeps §68 wages in the sixth basis", () => {
    const result = parsePayslipPages([page()]);
    expect(result.issues).toEqual([]);
    expect(result.drafts).toEqual([{
      year: 2026, month: 1, employer: "Fabelwald Robotik GmbH", monthlyPayroll: true,
      regularGross: 3380, specialGross: 0, baseSalary: 2810.2,
      regularSv: 604.32, regularTax: 411.6, monthlyTaxableBase: 2704.38,
      netPay: 2382.08, onCallGross: 302.75,
    }]);
    expect(payslipSchema.safeParse(result.drafts[0]).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Testperson|777777|Freibetrag|bereits überwiesen/i);
  });

  it("reads the already transferred salary and the remaining Auszahlung", () => {
    const result = parsePayslipPages([page({ tail: [line(235, [89, "Auszahlung"], [379, "75,08"])] })]);
    expect(result.drafts[0]).toMatchObject({ netPay: 2382.08, advancePay: 2300, payout: 75.08 });
    const mismatch = parsePayslipPages([page({ tail: [line(235, [89, "Auszahlung"], [379, "90,00"])] })]);
    expect(mismatch.drafts[0].advancePay).toBeUndefined();
    expect(mismatch.drafts[0].payout).toBeUndefined();
  });

  it("never subtracts BMG-only Freibeträge or quantity-only telework days from gross", () => {
    const original = page();
    const altered: PayslipPage = {
      lines: original.lines.map((entry) => entry.y === 385
        ? line(385, [54, "9110"], [89, "Freibetrag §68(1)"], [525, "-999,00"])
        : entry.y === 400
          ? line(400, [54, "7590"], [89, "Telearbeitstage"], [254, "28,00"])
          : entry),
    };
    expect(parsePayslipPages([altered]).drafts[0].regularGross).toBe(3380);
  });

  it("reads a right-aligned amount even when its bases differ", () => {
    const result = parsePayslipPages([page({
      rows: [wage(490, "1000", "Gehalt", "2.345,67", "8.765,43", "9.999,99")],
      gross: "2.345,67",
    })]);
    expect(result.drafts[0].regularGross).toBe(2345.67);
    expect(result.drafts[0].baseSalary).toBe(2345.67);
  });

  it.each(["-411,60", "411,60", "411,60-"])("stores absolute regular tax %s separately from its taxable base", (tax) => {
    const input = page();
    const result = parsePayslipPages([{ lines: input.lines.map((entry) => entry.y === 295
      ? line(295, [89, "LSt Beitrag lfd"], [379, tax], [525, "2.704,38"])
      : entry) }]);
    expect(result.drafts[0]).toMatchObject({ regularTax: 411.6, monthlyTaxableBase: 2704.38 });
  });

  it("distinguishes explicit zero regular tax from a missing regular tax amount", () => {
    const input = page();
    const zero = parsePayslipPages([{ lines: input.lines.map((entry) => entry.y === 295
      ? line(295, [89, "LSt Beitrag lfd"], [379, "0,00"], [525, "2.704,38"])
      : entry) }]);
    const missing = parsePayslipPages([{ lines: input.lines.map((entry) => entry.y === 295
      ? line(295, [89, "LSt Beitrag lfd"], [525, "2.704,38"])
      : entry) }]);
    expect(zero.drafts[0].regularTax).toBe(0);
    expect(missing.drafts[0].regularTax).toBeUndefined();
    expect(missing.drafts[0].monthlyTaxableBase).toBe(2704.38);
    expect(missing.issues.join()).toMatch(/Lohnsteuerbeitrag nicht eindeutig/);
  });

  it("does not mistake special-payment tax for regular tax", () => {
    const input = page();
    const result = parsePayslipPages([{ lines: input.lines.filter((entry) => entry.y !== 295).concat([
      line(295, [89, "LSt Beitrag SZ"], [379, "-125,45"], [525, "2.090,83"]),
    ]) }]);
    expect(result.drafts[0].regularTax).toBeUndefined();
    expect(result.drafts[0].monthlyTaxableBase).toBeUndefined();
  });

  it("omits conflicting repeated regular tax contributions instead of adding them", () => {
    const result = parsePayslipPages([page({ tail: [
      line(220, [89, "LSt Beitrag lfd"], [379, "-520,10"], [525, "2.900,00"]),
    ] })]);
    expect(result.drafts[0].regularTax).toBeUndefined();
    expect(result.drafts[0].monthlyTaxableBase).toBeUndefined();
    expect(result.issues.join()).toMatch(/Mehrere Werte/);
  });

  it("supports column layouts shifted together rather than fixed sample x-coordinates", () => {
    const shifted = page();
    const result = parsePayslipPages([{
      lines: shifted.lines.map((entry) => ({ ...entry, items: entry.items.map((item) => ({
        ...item, x: item.x + 45,
      })) })),
    }]);
    expect(result.drafts[0].regularGross).toBe(3380);
    expect(result.issues).toEqual([]);
  });

  it.each(["Urlaubszuschuss", "Weihnachtsremuneration", "Sonderzahlung", "13. Gehalt", "14.Gehalt", "13./14. Gehalt"])(
    "separates %s and its own social insurance", (label) => {
      const result = parsePayslipPages([page({
        rows: [wage(490, "1000", "Gehalt", "2.810,20"), wage(475, "5100", label, "2.510,80")],
        gross: "5.321,00",
        tail: [line(235, [89, "SV Beitrag SZ"], [379, "-422,45"], [451, "2.510,80"])],
      })]);
      expect(result.drafts[0]).toMatchObject({ regularGross: 2810.2, specialGross: 2510.8, specialSv: 422.45 });
      expect(result.issues).toEqual([]);
    },
  );

  it("does not count employer-only continuation pages", () => {
    const employerOnly = {
      pageNumber: 2,
      lines: [
        line(800, [50, "Lohn / Gehaltsabrechnung Jänner 2026"]),
        line(760, [50, "Fabelwald Robotik GmbH"]),
        line(500, [89, "Dienstgeber"], [379, "710,00"]),
        line(480, [89, "Kommunalsteuer"], [379, "85,00"]),
        line(460, [89, "Gesamtaufwand"], [379, "4.193,00"]),
      ],
    };
    const result = parsePayslipPages([page(), employerOnly]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].regularGross).toBe(3380);
    expect(result.issues).toEqual([]);
  });

  it("leaves unknown or exotic wages incomplete and does not leak their text", () => {
    const result = parsePayslipPages([page({
      rows: [wage(490, "1000", "Gehalt", "2.810,20"), wage(475, "8000", "PrivateNotiz-XY Abfertigung", "900,00")],
      gross: "3.710,20",
    })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.drafts[0].specialGross).toBeUndefined();
    expect(result.issues.join()).toMatch(/nicht unterstützt/i);
    expect(result.issues.join()).toContain("Lohnart 8000");
    expect(result.issues.join()).toContain("01/2026");
    expect(result.issues.join()).not.toContain("Bruttosumme stimmt nicht");
    expect(JSON.stringify(result)).not.toContain("PrivateNotiz");
  });

  it("reports an actual reconciliation difference even when a component is not classified", () => {
    const result = parsePayslipPages([page({
      rows: [wage(490, "1000", "Gehalt", "2.810,20"), wage(475, "8000", "Unbekannter Bezug", "900,00")],
      gross: "3.720,20",
    })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.issues.join()).toContain("Lohnart 8000");
    expect(result.issues.join()).toContain("Bruttosumme stimmt nicht");
  });

  it("does not infer tax treatment from employer-specific wage code 1509 alone", () => {
    const result = parsePayslipPages([page({
      month: "Februar",
      rows: [wage(490, "1000", "Gehalt", "2.810,20"), wage(475, "1509", "Nicht eindeutig ausgewiesener Bezug", "200,00")],
      gross: "3.010,20",
    })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.drafts[0].specialGross).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain("02/2026");
    expect(result.issues[0]).toContain("Lohnart 1509");
  });

  it("does not assume gross eligibility for an unqualified tax-free allowance", () => {
    const result = parsePayslipPages([page({
      rows: [wage(490, "1000", "Gehalt", "2.810,20"), wage(475, "8000", "Zulage steuerfrei", "50,00")],
      gross: "2.860,20",
    })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it.each([
    "Reisekostenersatz steuerfrei", "Reisekostenersatz frei", "Reisekostenersatz §26",
    "Fahrtkostenersatz steuerfrei", "Fahrtkostenersatz frei", "Fahrtkostenersatz § 26 EStG",
    "Kilometergeld steuerfrei", "Kilometergeld frei", "Kilometergeld §26",
  ])("excludes only explicitly tax-free expense reimbursement %s", (label) => {
    const result = parsePayslipPages([page({
      rows: [wage(490, "1000", "Gehalt", "2.810,20"), wage(475, "2700", label, "61,23")],
      gross: "2.871,43",
    })]);
    expect(result.drafts[0]).toMatchObject({ regularGross: 2810.2, specialGross: 0 });
    expect(result.issues).toEqual([]);
  });

  it.each(["Reisekostenersatz", "Fahrtkostenersatz", "Kilometergeld", "Reisekostenersatz steuerpflichtig"])(
    "leaves %s unknown rather than inferring tax-free status from zero BMG columns", (label) => {
      const result = parsePayslipPages([page({
        rows: [wage(490, "1000", "Gehalt", "2.810,20"), wage(475, "2700", label, "61,23", "0,00", "0,00")],
        gross: "2.871,43",
      })]);
      expect(result.drafts[0].regularGross).toBeUndefined();
      expect(result.drafts[0].specialGross).toBeUndefined();
      expect(result.issues.join()).toMatch(/Nicht unterstützter Bezugsbestandteil/);
      expect(result.issues.join()).not.toContain(label);
    },
  );

  it("does not allow an expense label with conflicting tax-free and taxable qualifiers", () => {
    const result = parsePayslipPages([page({
      rows: [wage(490, "1000", "Gehalt", "2.810,20"),
        wage(475, "2700", "Reisekostenersatz §26 steuerpflichtig", "61,23")],
      gross: "2.871,43",
    })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.issues.join()).toMatch(/Nicht unterstützter Bezugsbestandteil/);
  });

  it("requires reconciliation instead of silently using an incomplete total", () => {
    const result = parsePayslipPages([page({ gross: "3.500,00" })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.drafts[0].specialGross).toBeUndefined();
    expect(result.issues.join()).toMatch(/Bruttosumme stimmt nicht/);
  });

  it("leaves gross incomplete when Brutto is missing or duplicated", () => {
    const input = page();
    const missing = parsePayslipPages([{ lines: input.lines.filter((entry) => entry.y !== 340) }]);
    const duplicate = parsePayslipPages([{ lines: [...input.lines, line(335, [89, "Brutto"], [379, "3.398,00"])] }]);
    expect(missing.drafts[0].regularGross).toBeUndefined();
    expect(duplicate.drafts[0].regularGross).toBeUndefined();
  });

  it("refuses to substitute BMG SV when the actual wage amount is missing", () => {
    const result = parsePayslipPages([page({
      rows: [line(490, [54, "1000"], [89, "Gehalt"], [451, "2.810,20"], [525, "2.810,20"])],
      gross: "2.810,20",
    })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("refuses ambiguous two-amount cells", () => {
    const result = parsePayslipPages([page({
      rows: [line(490, [54, "1000"], [89, "Gehalt"], [375, "10,00"], [401, "20,00"])],
      gross: "30,00",
    })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
  });

  it("does not let correction entries cancel positive wages into a confident result", () => {
    const result = parsePayslipPages([page({
      rows: [wage(490, "1000", "Gehalt", "2.810,20"), wage(475, "1000", "Gehalt", "-100,00")],
      gross: "2.710,20",
    })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.issues.join()).toMatch(/Korrektur/);
  });

  it("preserves individual months and employers without combining wages", () => {
    const result = parsePayslipPages([
      page(), page({ month: "Februar" }), page({ employer: "Wolkenrad Technik AG" }),
    ]);
    expect(result.drafts).toHaveLength(3);
    expect(result.drafts.map((draft) => draft.regularGross)).toEqual([3380, 3380, 3380]);
    expect(result.drafts.map((draft) => draft.month)).toEqual([1, 2, 1]);
    expect(result.drafts[2].employer).toBe("Wolkenrad Technik AG");
  });

  it("does not sum duplicate or corrected payslips for the same employer and month", () => {
    const result = parsePayslipPages([page(), page()]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toEqual({ year: 2026, month: 1, employer: "Fabelwald Robotik GmbH" });
    expect(result.issues.join()).toMatch(/keine automatische Addition/);
  });

  it("flags repeated wage components rather than assuming they are additive", () => {
    const result = parsePayslipPages([page({
      rows: [wage(490, "1000", "Gehalt", "2.810,20"), wage(475, "1000", "Gehalt", "2.810,20")],
      gross: "5.620,40",
    })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.issues.join()).toMatch(/Bezugsbestandteil mehrfach/);
  });

  it("allows distinct on-call wage codes without treating them as duplicate rows", () => {
    const result = parsePayslipPages([page({
      rows: [wage(490, "1000", "Gehalt", "2.810,20"), wage(475, "4621", "Rufbereitschaft", "40,00"),
        wage(460, "4622", "Rufbereitschaft", "60,00")],
      gross: "2.910,20",
    })]);
    expect(result.drafts[0].regularGross).toBe(2910.2);
    expect(result.issues).toEqual([]);
  });

  it("separates back-pay sections for earlier months from the month's own values", () => {
    const backPay = (title: string, ...rows: PayslipLine[]) => [line(rows[0].y + 6, [89, title]), ...rows];
    const rows = [
      ...page().lines.filter((entry) => entry.y < 500 && entry.y > 360),
      ...backPay("Nachtrag für Mai", wage(358, "1000", "Gehalt", "60,00")),
      ...backPay("Nachtrag für Juni", wage(346, "1000", "Gehalt", "60,00"), wage(343, "3160", "ÜStd.ZS100%fr", "5,00"),
        wage(341, "5020", "Sonderzahlung", "35,00")),
    ];
    const tail = [
      line(305, [89, "SV Beitrag lfd Vormonate"], [379, "-21,70"], [451, "125,00"]),
      line(303, [89, "SV Beitrag SZ Vormonate"], [379, "-6,00"], [451, "35,00"]),
      line(300, [89, "LSt Beitrag lfd Vormonate"], [379, "-37,50"], [525, "125,00"]),
    ];
    const result = parsePayslipPages([page({ rows, gross: "3.558,00", tail })]);
    expect(payslipSchema.parse(result.drafts[0])).toMatchObject({
      regularGross: 3380, specialGross: 0, baseSalary: 2810.2, onCallGross: 302.75, regularSv: 604.32, regularTax: 411.6,
      backPayGross: 160, backPayDeductions: 65.2,
    });
    expect(result.drafts[0].estimated).toBeUndefined();
    expect(result.issues).toEqual(["Seite 1 (01/2026): Nachzahlung für Vormonate erkannt; sie wird getrennt vom Monatswert übernommen."]);
    // A repeated component within one back-pay section is still not added up.
    const repeated = [...rows, wage(340.5, "1000", "Gehalt", "60,00")];
    expect(parsePayslipPages([page({ rows: repeated, gross: "3.618,00", tail })]).issues.join()).toMatch(/Bezugsbestandteil mehrfach/);
  });

  it("keeps budget years strict but completes 2025 reference payslips with the last value or the SV bases", () => {
    const repeatedTax = [line(220, [89, "LSt Beitrag lfd"], [379, "-420,10"], [525, "2.720,00"])];
    expect(parsePayslipPages([page({ tail: repeatedTax })]).drafts[0].regularTax).toBeUndefined();
    const reference = parsePayslipPages([page({ year: 2025, tail: repeatedTax })]);
    expect(reference.drafts[0]).toMatchObject({ regularTax: 420.1, monthlyTaxableBase: 2720, estimated: true });
    expect(reference.issues.join()).toMatch(/Mehrere Werte für Lohnsteuer laufend; als Referenz wurde der letzte Wert übernommen/);
    // A correction that does not reconcile: budget years stay incomplete, 2025 takes the gross from the SV bases.
    const corrected = { rows: [wage(490, "1000", "Gehalt", "3.480,00"), wage(475, "1000", "Gehalt", "-100,00")], gross: "3.380,00" };
    expect(parsePayslipPages([page(corrected)]).drafts[0].regularGross).toBeUndefined();
    const estimated = parsePayslipPages([page({ ...corrected, year: 2025 })]);
    expect(payslipSchema.parse(estimated.drafts[0])).toMatchObject({ regularGross: 3380, specialGross: 0, netPay: 2382.08, estimated: true });
    expect(estimated.issues.join()).toMatch(/aus den SV-Bemessungsgrundlagen geschätzt/);
  });

  it("does not turn an unsupported year into the selected or current year", () => {
    const result = parsePayslipPages([page({ year: 2024 })]);
    expect(result.drafts[0].year).toBeUndefined();
    expect(result.issues.join()).toMatch(/2025 \(als Referenz\), 2026 und 2027/);
  });

  it("reads 2025 payslips as reference without an issue", () => {
    const result = parsePayslipPages([page({ year: 2025 })]);
    expect(result.drafts[0]).toMatchObject({ year: 2025 });
    expect(result.issues.join()).not.toMatch(/Abrechnungsjahr/);
  });

  it("accepts the second supported year and numeric month headers", () => {
    const input = page({ year: 2027 });
    const numeric = { lines: input.lines.map((entry) => entry.y === 800
      ? line(800, [50, "Gehaltsabrechnung 02/2027"]) : entry) };
    expect(parsePayslipPages([numeric]).drafts[0]).toMatchObject({ year: 2027, month: 2 });
  });

  it("does not infer the employer from employee labels or personal numbers", () => {
    const result = parsePayslipPages([page({ employer: "Arbeitnehmer: Nur Testperson" })]);
    expect(result.drafts[0].employer).toBeUndefined();
    expect(result.issues.join()).toMatch(/Arbeitgeber nicht eindeutig/);
    expect(JSON.stringify(result)).not.toContain("Nur Testperson");
  });

  it("accepts a clearly labelled employer without requiring a legal suffix", () => {
    expect(parsePayslipPages([page({ employer: "Arbeitgeber: Musterbetrieb Nord" })]).drafts[0].employer)
      .toBe("Musterbetrieb Nord");
  });

  it("does not choose between conflicting employer headers", () => {
    const input = page();
    const result = parsePayslipPages([{ lines: [...input.lines, line(750, [50, "Wolkenrad Technik AG"])] }]);
    expect(result.drafts[0].employer).toBeUndefined();
  });

  it("marks a partial month and does not manufacture zero special pay", () => {
    const result = parsePayslipPages([page({ days: "16" })]);
    expect(result.drafts[0]).toMatchObject({ monthlyPayroll: false, regularGross: 3380 });
    expect(result.drafts[0].specialGross).toBeUndefined();
    expect(result.issues.join()).toMatch(/Teilmonat/);
  });

  it("leaves unknown monthly status and special pay absent for manual review", () => {
    const input = page();
    const result = parsePayslipPages([{ lines: input.lines.filter((entry) => entry.y !== 550 && entry.y !== 538) }]);
    expect(result.drafts[0].monthlyPayroll).toBeUndefined();
    expect(result.drafts[0].specialGross).toBeUndefined();
  });

  it("does not treat 31 LSt days as a confirmed standard full month", () => {
    const result = parsePayslipPages([page({ days: "31" })]);
    expect(result.drafts[0].monthlyPayroll).toBeUndefined();
    expect(result.drafts[0].specialGross).toBeUndefined();
    expect(result.issues.join()).toMatch(/Abrechnungstage sind nicht eindeutig/);
  });

  it("does not manufacture regular zero for a standalone special payment", () => {
    const result = parsePayslipPages([page({
      rows: [wage(490, "5100", "Urlaubszuschuss", "2.110,00")], gross: "2.110,00",
    })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.drafts[0].specialGross).toBe(2110);
  });

  it("imports explicit control values, never guesses missing YTD values", () => {
    expect(parsePayslipPages([page()]).drafts[0].reportedSixth).toBeUndefined();
    const result = parsePayslipPages([page({ tail: [
      line(220, [89, "Jahressechstel"], [379, "6.710,00"]),
      line(205, [89, "Verbrauchtes Jahressechstel"], [379, "3.100,00"]),
      line(190, [89, "Laufende Bezüge kumuliert"], [379, "19.540,00"]),
      line(175, [89, "Sonderzahlungen kumuliert"], [379, "3.500,00"]),
      line(160, [89, "Steuerpflichtige Sonderzahlungen kumuliert innerhalb Jahressechstel nach SV vor 620"], [379, "2.800,00"]),
    ] })]);
    expect(result.drafts[0]).toMatchObject({
      reportedSixth: 6710, usedSixth: 3100, regularGrossYtd: 19540,
      specialGrossYtd: 3500, specialTaxableYtd: 2800,
    });
  });

  it.each([
    "Steuerpflichtige Sonderzahlungen kumuliert",
    "Steuerpflichtige Sonderzahlungen YTD",
    "Steuerpflichtige Sonderzahlungen kumuliert nach 620",
    "Steuerpflichtige Sonderzahlungen kumuliert innerhalb Jahressechstel nach SV",
    "Steuerpflichtige Sonderzahlungen kumuliert nach SV vor 620",
    "Steuerpflichtige Sonderzahlungen kumuliert innerhalb Jahressechstel vor 620",
    "Steuerpflichtige Sonderzahlungen kumuliert innerhalb Jahressechstel nach SV vor 620 inklusive Überhang",
  ])("leaves ambiguous cumulative special-tax basis undefined: %s", (label) => {
    const result = parsePayslipPages([page({ tail: [line(160, [89, label], [379, "2.800,00"])] })]);
    expect(result.drafts[0].specialTaxableYtd).toBeUndefined();
    expect(result.issues.join()).toMatch(/Sonderzahlungs-Steuerbasis nicht eindeutig/);
    expect(result.issues.join()).not.toContain(label);
  });

  it("accepts only an explicitly within-sixth, after-SV, before-allowance cumulative taxable basis", () => {
    const result = parsePayslipPages([page({ tail: [
      line(160, [89, "Steuerpflichtige Sonderzahlungen YTD innerhalb des Jahressechstels nach SV vor 620 EUR-Freibetrag"],
        [379, "2.800,00"]),
    ] })]);
    expect(result.drafts[0].specialTaxableYtd).toBe(2800);
    expect(result.issues).toEqual([]);
  });

  it("does not choose between repeated control values", () => {
    const result = parsePayslipPages([page({ tail: [
      line(220, [89, "Jahressechstel"], [379, "6.710,00"]),
      line(205, [89, "Jahressechstel"], [379, "6.900,00"]),
    ] })]);
    expect(result.drafts[0].reportedSixth).toBeUndefined();
    expect(result.issues.join()).toMatch(/Mehrere Werte/);
  });

  it("keeps unsupported tables reviewable rather than guessing amounts from line endings", () => {
    const input = page();
    const result = parsePayslipPages([{ lines: input.lines.filter((entry) => entry.y !== 510) }]);
    expect(result.drafts[0]).toMatchObject({ year: 2026, month: 1 });
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.drafts[0].specialGross).toBeUndefined();
    expect(result.issues.join()).toMatch(/Spaltenlayout/);
  });

  it("flags unassigned continuation pages and invalidates potentially partial totals", () => {
    const result = parsePayslipPages([page(), { pageNumber: 2, lines: [line(700, [89, "Sonstiger privater Abschnitt"])] }]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.issues.join()).toMatch(/Seite 2/);
    expect(JSON.stringify(result)).not.toContain("privater Abschnitt");
  });

  it("does not treat corrections as a new complete monthly statement", () => {
    const result = parsePayslipPages([page({ tail: [line(220, [89, "Aufrollung"])] })]);
    expect(result.drafts[0].regularGross).toBeUndefined();
    expect(result.issues.join()).toMatch(/Korrektur erkannt/);
  });

  it("rejects scans, unrelated documents and excessive page/text counts explicitly", () => {
    expect(() => parsePayslipPages([{ lines: [] }])).toThrow(/gescannte/i);
    expect(() => parsePayslipPages([{ lines: [line(700, [50, "Unrelated private document"])] }])).toThrow(/Keine unterstützte/);
    expect(() => parsePayslipPages(Array.from({ length: 101 }, () => ({ lines: [] })))).toThrow(/100 Seiten/);
    expect(() => parsePayslipPages([{ lines: [line(700, [50, "x".repeat(100_001)])] }])).toThrow(/zu viel Text/);
  });

  it("does not mutate the positioned input", () => {
    const input = page();
    const before = JSON.stringify(input);
    parsePayslipPages([input]);
    expect(JSON.stringify(input)).toBe(before);
  });
});
