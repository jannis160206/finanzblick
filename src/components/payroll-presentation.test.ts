import { expect, it } from "vitest";
import { payrollPresentation, payrollWholeMoney } from "./payroll-presentation";
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

it("rounds compact amounts to whole euros", () => {
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
