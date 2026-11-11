import { isReferencePayslip, payrollEmployerKey, payslipSchema, type Payslip, type PayslipDraft } from "@/lib/payslip-schema";

const money = (value: number) => Math.round(value * 100) / 100;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const period = (draft: PayslipDraft) => `${String(draft.month).padStart(2, "0")}/${draft.year}`;

/**
 * Completes reference payslips (2025) the parser could read only in part, from the pattern of the own payslips:
 * regular gross from the SV contribution (or the net) and the usual share, the special payment from the learned
 * special months, the Grundgehalt and the payroll type of the nearest month. The result is marked as estimated.
 * Payslips of budget years are never estimated.
 */
export function completeReferenceDrafts(drafts: readonly PayslipDraft[], stored: readonly Payslip[]): { drafts: PayslipDraft[]; notes: string[] } {
  const parsed = drafts.flatMap((draft) => {
    const entry = payslipSchema.safeParse(draft);
    return entry.success ? [entry.data] : [];
  });
  const known = [...stored, ...parsed].filter((entry) => !entry.estimated);
  const notes: string[] = [];
  const result = drafts.map((draft) => {
    if (payslipSchema.safeParse(draft).success || draft.year === undefined || !isReferencePayslip({ year: draft.year }) ||
      !draft.month || !draft.employer) return draft;
    const key = payrollEmployerKey(draft.employer);
    const own = known.filter((entry) => payrollEmployerKey(entry.employer) === key);
    if (!own.length) return draft;
    const at = draft.year * 12 + draft.month;
    const nearest = [...own].sort((a, b) => Math.abs(a.year * 12 + a.month - at) - Math.abs(b.year * 12 + b.month - at));
    const next: PayslipDraft = { ...draft, estimated: true };
    next.monthlyPayroll ??= own.every((entry) => entry.monthlyPayroll) ? true : undefined;
    next.baseSalary ??= nearest.find((entry) => entry.baseSalary)?.baseSalary;
    if (next.regularGross === undefined) {
      const svShares = own.filter((entry) => entry.regularSv && entry.regularGross > 0).map((entry) => entry.regularSv! / entry.regularGross);
      const plain = own.filter((entry) => entry.netPay && entry.regularGross > 0 && !entry.specialGross && !entry.backPayGross && !entry.unresolvedSixthBonus);
      if (next.regularSv && svShares.length) next.regularGross = money(next.regularSv / median(svShares));
      else if (next.netPay && plain.length && !next.specialSv) next.regularGross = money(next.netPay / median(plain.map((entry) => entry.netPay! / entry.regularGross)));
    }
    if (next.specialGross === undefined) {
      const specials = own.filter((entry) => entry.specialGross > 0);
      const svShares = specials.filter((entry) => entry.specialSv).map((entry) => entry.specialSv! / entry.specialGross);
      const ratios = specials.filter((entry) => entry.baseSalary).map((entry) => entry.specialGross / entry.baseSalary!);
      if (next.specialSv && svShares.length) next.specialGross = money(next.specialSv / median(svShares));
      else if (specials.some((entry) => entry.month === draft.month) && next.baseSalary && ratios.length)
        next.specialGross = money(next.baseSalary * median(ratios));
      else if (!next.specialSv && !next.specialTax) next.specialGross = 0;
    }
    if (next.baseSalary !== undefined && next.regularGross !== undefined && next.baseSalary > next.regularGross) delete next.baseSalary;
    if (!payslipSchema.safeParse(next).success) return draft;
    notes.push(`Abrechnung ${period(draft)}: als Referenz mit geschätzten Werten aus den eigenen Abrechnungen übernommen.`);
    return next;
  });
  return { drafts: result, notes };
}
