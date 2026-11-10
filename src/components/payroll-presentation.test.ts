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
import { payslipSchema } from "@/lib/payslip-schema";
import {
  analyzePayrollAutomatically,
  estimatePayrollBonus,
} from "@/lib/payroll-analysis";
import { employerPayslips } from "@/lib/payroll-overview";

it("builds twelve month tiles from documented payslips and the unchanged forecast", () => {
  const state = payrollFixture();
  const payslips = state.payslips ?? [];
  const entries = employerPayslips(payslips, 2026, payrollEmployer);
  const view = payrollPresentation(payslips, 2026, payrollEmployer, state.settings.asOf);
  const tiles = payrollMonthTiles(view, entries);
  expect(tiles.map((tile) => tile.status)).toEqual([
    ...Array(9).fill("actual"),
    "forecast",
    "forecast",
    "forecast",
  ]);
  expect(tiles.map((tile) => tile.label).slice(0, 2)).toEqual(["Jänner 2026", "Februar 2026"]);
  // The fixture prints no net amount, so documented months fall back to gross.
  expect(tiles[5]).toEqual({
    month: 6,
    label: "Juni 2026",
    status: "actual",
    special: true,
    headline: { metric: "gross", value: 7000 },
    details: {
      kind: "actual",
      net: undefined,
      regularGross: 4000,
      specialGross: 3000,
      tax: 500,
      sv: 1232.1,
      sixth: undefined,
    },
  });
  expect(tiles[8].details).toMatchObject({ kind: "actual", sixth: view.actual?.sixth });
  const november = view.analysis.forecast.months.find((month) => month.month === 11)!;
  expect(tiles[10]).toEqual({
    month: 11,
    label: "November 2026",
    status: "forecast",
    special: true,
    headline: { metric: "gross", value: november.regularGross + november.specialGross },
    details: {
      kind: "forecast",
      regularGross: november.regularGross,
      specialGross: november.specialGross,
      sixth: view.analysis.sixthEstimates.find((month) => month.month === 11),
    },
  });
  expect(tiles[9]).toMatchObject({ special: false, details: { specialGross: 0 } });
});

it("prefers printed net, keeps gaps unopenable and the special-payment model unknown without a base salary", () => {
  const base = payrollFixture().payslips![0];
  const entries = [{ ...base, netPay: 2700 }, { ...base, month: 3, baseSalary: undefined }];
  const view = payrollPresentation(entries, 2026, payrollEmployer, "2026-04-08");
  const tiles = payrollMonthTiles(view, entries);
  expect(tiles[0].headline).toEqual({ metric: "net", value: 2700 });
  expect(tiles[1]).toEqual({ month: 2, label: "Februar 2026", status: "missing", special: false });
  expect(view.analysis.hasSpecialPaymentModel).toBe(false);
  expect(tiles[3]).toMatchObject({ status: "forecast", details: { kind: "forecast", specialGross: undefined } });
  expect(payrollMonthTiles(view, [])).toEqual(
    Array.from({ length: 12 }, (_, index) => expect.objectContaining({ status: "open", month: index + 1 })),
  );
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
