import { expect, it } from "vitest";
import {
  payrollMonthTiles,
  payrollPresentation,
  payrollWholeMoney,
} from "./payroll-presentation";
import {
  payrollEmployer,
  payrollFixture,
  syntheticPayslipPdf,
} from "../../tests/fixtures/payroll-state";
import { parsePayslipPdf } from "@/lib/import/payslip";
import { payslipSchema, type Payslip } from "@/lib/payslip-schema";
import { salaryForecast } from "@/lib/salary-forecast";
import { payslipFingerprint } from "@/lib/payslip-validation";
import {
  analyzePayrollAutomatically,
  estimatePayrollBonus,
} from "@/lib/payroll-analysis";

const fixturePayslips = () => (payrollFixture().payslips ?? []).filter((entry) => entry.year === 2026);
function tilesFor(payslips: Payslip[], asOf = payrollFixture().settings.asOf) {
  const state = payrollFixture();
  const view = payrollPresentation(payslips, 2026, payrollEmployer, asOf);
  const forecast = salaryForecast({ ...state, settings: { ...state.settings, asOf }, payslips });
  return { view, forecast, tiles: payrollMonthTiles({ view, payslips, employer: payrollEmployer, forecast }) };
}

it("builds twelve tiles by payout month: each payslip is paid in the following month", () => {
  const payslips = fixturePayslips();
  const { view, forecast, tiles } = tilesFor(payslips);
  expect(tiles.map((tile) => tile.status)).toEqual(["open", ...Array(9).fill("actual"), "forecast", "forecast"]);
  expect(tiles[1]).toMatchObject({
    month: 2,
    label: "Februar 2026",
    payroll: { year: 2026, month: 1, label: "Jänner 2026" },
    reference: false,
    headline: { metric: "net", value: 2780 },
    details: { kind: "actual", net: 2780, regularGross: 4000, specialGross: 0, tax: 500, sv: 720, sixth: undefined },
  });
  // Grundgehalt 3.000 € of 4.000 € gross: the rest are extra hours, in net terms.
  expect(tiles[1].details?.parts).toEqual([{ key: "salary", amount: 2085 }, { key: "overtime", amount: 695 }]);
  // June has a special payment without its tax: no exact net, so its July tile shows gross.
  expect(tiles[6]).toMatchObject({ month: 7, special: true, headline: { metric: "gross", value: 7000 }, details: { net: undefined, parts: [] } });
  expect(tiles[9].details).toMatchObject({ kind: "actual", sixth: view.actual?.sixth });
  const december = forecast.months.find((month) => month.month === "2026-12")!;
  const november = view.analysis.forecast.months.find((month) => month.month === 11)!;
  expect(tiles[11]).toMatchObject({
    month: 12,
    status: "forecast",
    special: true,
    payroll: { year: 2026, month: 11 },
    headline: { metric: "net", value: december.total },
    details: {
      kind: "forecast",
      net: december.total,
      regularGross: november.regularGross,
      specialGross: november.specialGross,
      sixth: view.analysis.sixthEstimates.find((month) => month.month === 11),
    },
  });
  expect(tiles[11].details?.parts.at(-1)).toEqual({ key: "special", amount: december.special.amount, reason: december.special.reason });
  expect(tiles[10]).toMatchObject({ special: false, details: { specialGross: 0 } });
});

it("pays December in January, keeps 2025 payslips as reference and marks gaps", () => {
  const [january] = fixturePayslips();
  const payslips: Payslip[] = [{ ...january, year: 2025, month: 12, netPay: 2650 }, { ...january, netPay: 2700 }, { ...january, month: 3, baseSalary: undefined }];
  const { view, tiles } = tilesFor(payslips, "2026-04-08");
  expect(tiles[0]).toMatchObject({ month: 1, status: "actual", reference: true, payroll: { year: 2025, month: 12 }, headline: { metric: "net", value: 2650 } });
  expect(tiles[1]).toMatchObject({ status: "actual", reference: false, headline: { metric: "net", value: 2700 } });
  expect(tiles[2]).toEqual(expect.objectContaining({ month: 3, status: "missing", special: false }));
  expect(tiles[2].details).toBeUndefined();
  expect(view.analysis.hasSpecialPaymentModel).toBe(false);
  expect(tiles[4]).toMatchObject({ status: "forecast", details: { kind: "forecast", specialGross: undefined } });
  const empty = payrollMonthTiles({ view: payrollPresentation([], 2026, payrollEmployer, "2026-04-08"), payslips: [], employer: payrollEmployer });
  expect(empty.map((tile) => tile.status)).toEqual(Array(12).fill("open"));
});

it("marks a payslip with contradicting numbers for review until exactly its values are confirmed", () => {
  const [january] = fixturePayslips();
  const broken = { ...january, netPay: 3500 };
  const { view } = tilesFor([broken], "2026-02-10");
  const tiles = payrollMonthTiles({ view, payslips: [broken], employer: payrollEmployer });
  expect(tiles[1]).toMatchObject({ status: "review", review: [{ id: "net-balance", level: "error" }] });
  const confirmed = payrollMonthTiles({ view, payslips: [broken], employer: payrollEmployer, confirmed: [payslipFingerprint(broken)] });
  expect(confirmed[1]).toMatchObject({ status: "actual" });
  expect(confirmed[1].review).toBeUndefined();
});

it("rounds compact tile amounts to whole euros", () => {
  expect(payrollWholeMoney(10039.5).replace(/\s/g, " ")).toBe("10.040 €");
  expect(payrollWholeMoney(1_000_000_000).replace(/\s/g, " ")).toBe("1.000.000.000 €");
});

it("preserves the existing automatic model and selects the next payment from the as-of month", () => {
  const state = payrollFixture();
  const entries = state.payslips ?? [];
  const model = analyzePayrollAutomatically(entries, 2026, payrollEmployer);
  const view = payrollPresentation(
    entries,
    2026,
    payrollEmployer,
    state.settings.asOf,
  );
  expect(view.analysis).toEqual(model);
  expect(view.estimateMonth).toBe(10);
  expect(view.nextPayment?.month).toBe(11);
  expect(view.next).toEqual(
    model.projections.find((projection) => projection.month === 11),
  );
  expect(view.bonus).toEqual(estimatePayrollBonus(entries, model, 11));
  expect(entries).toEqual(state.payslips);
});

it("does not offer an already elapsed special payment for a historical year", () => {
  const state = payrollFixture();
  const view = payrollPresentation(
    state.payslips ?? [],
    2026,
    payrollEmployer,
    "2027-01-08",
  );
  expect(view.nextPayment).toBeUndefined();
  expect(view.next).toBeUndefined();
});

it("builds a genuinely parseable synthetic PDF for browser import acceptance", async () => {
  const bytes = syntheticPayslipPdf();
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  const parsed = await parsePayslipPdf(buffer);
  expect(parsed.issues).toEqual([]);
  expect(payslipSchema.parse(parsed.drafts[0])).toMatchObject({
    year: 2026,
    month: 10,
    employer: payrollEmployer,
    regularGross: 4000,
    specialGross: 0,
    baseSalary: 4000,
    regularSv: 720,
    regularTax: 500,
    monthlyTaxableBase: 3280,
    monthlyPayroll: true,
  });
});
