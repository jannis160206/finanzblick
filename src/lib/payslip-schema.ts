import { z } from "zod";

const amount = z.number().min(0).max(1_000_000_000).multipleOf(0.01);
export const payrollYearSchema = z.union([z.literal(2026), z.literal(2027)]);
export const payrollContextIssueSchema = z.enum([
  "buag", "apprentice", "employment-ended", "context-unknown",
]);
export type PayrollContextIssue = z.infer<typeof payrollContextIssueSchema>;

const payrollContextLabels: Record<PayrollContextIssue, string> = {
  buag: "BUAG/BUAK erkannt – dafür ist keine Standardprognose verfügbar.",
  apprentice: "Lehrverhältnis erkannt – dafür ist keine Standardprognose verfügbar.",
  "employment-ended": "Austritt angegeben – weitere Beschäftigung ist nicht belegt.",
  "context-unknown": "Beschäftigungskontext unklar – vor einer Prognose einen eindeutigen Beleg ergänzen.",
};

export function payrollContextMessages(entries: readonly { payrollContextIssues?: PayrollContextIssue[] }[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.payrollContextIssues ?? []))]
    .map((reason) => payrollContextLabels[reason]);
}

export const payslipSchema = z.object({
  year: payrollYearSchema,
  month: z.number().int().min(1).max(12),
  employer: z.string().trim().min(1).max(120),
  regularGross: amount,
  specialGross: amount,
  // Reconciled tariff-taxed SV-special bonus, excluded from both gross classes until its sixth treatment is documented.
  unresolvedSixthBonus: amount.optional(),
  regularSv: amount.optional(),
  regularTax: amount.optional(),
  specialSv: amount.optional(),
  monthlyTaxableBase: amount.optional(),
  reportedSixth: amount.optional(),
  regularGrossYtd: amount.optional(),
  specialGrossYtd: amount.optional(),
  specialTaxableYtd: amount.optional(),
  usedSixth: amount.optional(),
  baseSalary: amount.optional(),
  // Net pay as printed on the payslip ("Netto"); special-payment tax and on-call gross split it for the month plan.
  netPay: amount.optional(),
  specialTax: amount.optional(),
  onCallGross: amount.optional(),
  holidayWorkGross: amount.optional(),
  // "Bereits überwiesen" is the salary already paid; the remaining "Auszahlung" is the on-call pay.
  advancePay: amount.optional(),
  payout: amount.optional(),
  monthlyPayroll: z.boolean(),
  payrollContextIssues: z.array(payrollContextIssueSchema).max(4)
    .refine((reasons) => new Set(reasons).size === reasons.length, "Kontextgründe dürfen nicht doppelt vorkommen.")
    .optional(),
});

export type Payslip = z.infer<typeof payslipSchema>;
export type PayslipDraft = Partial<Payslip>;
export type PayslipImport = { drafts: PayslipDraft[]; issues: string[] };

export const payrollForecastMonthSchema = z.object({
  month: z.number().int().min(1).max(12),
  regularGross: amount,
  specialGross: amount,
  monthlyTaxableBase: amount.optional(),
  specialSv: amount.optional(),
});
export const payrollForecastSchema = z.object({
  year: payrollYearSchema,
  employer: z.string().trim().min(1).max(120),
  months: z.array(payrollForecastMonthSchema).max(12).refine(
    (months) => new Set(months.map((month) => month.month)).size === months.length,
    "Jeder Prognosemonat darf nur einmal vorkommen.",
  ),
  standardPayrollConfirmed: z.boolean(),
});
export type PayrollForecast = z.infer<typeof payrollForecastSchema>;
export type PayrollForecastMonth = z.infer<typeof payrollForecastMonthSchema>;

export function payrollEmployerKey(employer: string): string {
  return employer.normalize("NFKC").toLocaleLowerCase("de-AT").replace(/\s+/g, " ").trim();
}

export function payslipKey(value: Pick<Payslip, "year" | "month" | "employer">): string {
  return `${value.year}-${String(value.month).padStart(2, "0")}|${payrollEmployerKey(value.employer)}`;
}
