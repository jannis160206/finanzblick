import type { Transaction } from "@/lib/types";

type PayrollSource = Pick<Transaction, "description" | "amount"> &
  Partial<Pick<Transaction, "date" | "rawDescription" | "rawDetails" | "sourceCategory">>;

const employer = /team\s*talent\s*solutions|\btts\b/i;
const specialPayment = /(?:1[34]\.?\s*(?:monats)?(?:gehalt|lohn)|bonus|sonderzahlung|weihnachtsgeld|urlaubsgeld|holiday)/i;
export const payrollText = (row: PayrollSource) =>
  [row.description, row.rawDescription, ...(row.rawDetails ?? []), row.sourceCategory].filter(Boolean).join(" ");

export const isTTSPayroll = (row: PayrollSource) => employer.test(payrollText(row));

// Original workbook rows use shortened descriptions without account/reference.
// Replace only matching legacy representations, one for one, in derived views.
// Separate bank references/installments and all stored bank facts remain intact.
export function reconcilePayrollSources<T extends Transaction>(rows: T[]): T[] {
  const legacy = (row: T) => /^xlsx-\d+$/.test(row.id) && !row.pocket && !row.bankReference;
  const identity = (row: T) => {
    const period = payrollPeriod(row);
    const category = payrollCategory(row);
    return isTTSPayroll(row) && period && category
      ? JSON.stringify([row.date, row.bank.trim().toLowerCase(), row.amount.toFixed(2), period, category])
      : undefined;
  };
  const represented = new Map<string, number>();
  for (const row of rows) {
    const key = identity(row);
    if (key && !legacy(row) && (row.bankReference || row.pocket))
      represented.set(key, (represented.get(key) ?? 0) + 1);
  }
  return rows.filter((row) => {
    const key = legacy(row) ? identity(row) : undefined;
    const count = key ? represented.get(key) ?? 0 : 0;
    if (!key || !count) return true;
    represented.set(key, count - 1);
    return false;
  });
}

export function payrollPeriod(row: PayrollSource): string | undefined {
  const match = /(?:gehalt|lohn|abrechnung)\s*(?:f[uü]r\s*)?(0?[1-9]|1[0-2])[./](20\d{2})\b/i.exec(payrollText(row));
  return match ? `${match[2]}-${match[1].padStart(2, "0")}` : undefined;
}

export function payrollCategory(row: PayrollSource): "Gehalt" | "Rufbereitschaft" | "Einkommen" | undefined {
  if (row.amount <= 0) return;
  const text = payrollText(row);
  if (/rufbereitschaft|bereitschafts(?:dienst|zulage|entgelt)/i.test(text)) return "Rufbereitschaft";
  if (specialPayment.test(text)) return "Einkommen";
  if (!/gehalt|lohn/i.test(text) && !employer.test(text)) return;
  const period = payrollPeriod(row);
  // Confirmed June special payroll (5506.xx), not a general salary ceiling.
  // Require this employer and June period; other large salaries stay unchanged.
  if (employer.test(text) && period?.endsWith("-06") && row.date?.slice(0, 7) === period &&
    row.amount >= 5506 && row.amount < 5507) return "Einkommen";
  // This employer pays the previous period's on-call allowance separately in
  // the first half of the month. It can exceed the old 500-euro cutoff.
  if (employer.test(text) && row.date && period && period < row.date.slice(0, 7) && Number(row.date.slice(8, 10)) <= 20)
    return "Rufbereitschaft";
  return row.amount < 500 ? "Rufbereitschaft" : "Gehalt";
}

export const isSpecialSalaryMonth = (month: string) => [3, 7, 12].includes(Number(month.slice(5, 7)));

export function earlySpecialSalary(row: PayrollSource, nextMonth: string): boolean {
  // The March salary in the supplied payroll arrives on February 25. Keep
  // the existing 26th–30th rule elsewhere; never shift the on-call allowance.
  return !!row.date && Number(row.date.slice(8, 10)) === 25 &&
    employer.test(payrollText(row)) && payrollPeriod(row) === row.date.slice(0, 7) &&
    isSpecialSalaryMonth(nextMonth);
}
