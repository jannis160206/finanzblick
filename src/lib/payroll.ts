import type { Transaction } from "@/lib/types";
import { isRaiffeisenBank, isRaiffeisenMainAccount, normalizeAccount } from "@/lib/accounts";
import { retainManualCategory } from "@/lib/manual-category";

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
  const legacy = (row: T) => /^xlsx-\d+$/.test(row.id) &&
    (!row.pocket || isRaiffeisenMainAccount(row)) && !row.bankReference;
  const identity = (row: T) => {
    const period = payrollPeriod(row);
    const category = payrollCategory(row);
    const account = normalizeAccount(row);
    return isTTSPayroll(row) && period && category
      ? JSON.stringify([row.date, account.bank.trim().toLowerCase(), row.amount.toFixed(2), period, category,
        isRaiffeisenBank(account.bank) ? account.pocket : null])
      : undefined;
  };
  const represented = new Map<string, { indices: number[]; next: number }>();
  rows.forEach((row, index) => {
    const key = identity(row);
    if (key && !legacy(row) && (row.bankReference || row.pocket)) {
      const group = represented.get(key) ?? { indices: [], next: 0 };
      group.indices.push(index);
      represented.set(key, group);
    }
  });
  const reconciled = [...rows];
  const replaced = new Set<number>();
  rows.forEach((row, index) => {
    const key = legacy(row) ? identity(row) : undefined;
    const group = key ? represented.get(key) : undefined;
    if (!group || group.next >= group.indices.length) return;
    const target = group.indices[group.next++];
    reconciled[target] = retainManualCategory(reconciled[target], row);
    replaced.add(index);
  });
  return reconciled.filter((_, index) => !replaced.has(index));
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

// Payout months with special payments: January (Successbonus with December's pay), March, July and December.
export const isSpecialSalaryMonth = (month: string) => [1, 3, 7, 12].includes(Number(month.slice(5, 7)));

export function earlySpecialSalary(row: PayrollSource, nextMonth: string): boolean {
  // The March salary in the supplied payroll arrives on February 25; December's
  // salary may come before Christmas, from the 20th, and still funds January.
  // Keep the existing 26th–30th rule elsewhere; never shift the on-call allowance.
  const day = Number(row.date?.slice(8, 10));
  const early = day === 25 || (nextMonth.endsWith("-01") && day >= 20 && day < 25);
  return !!row.date && early &&
    employer.test(payrollText(row)) && payrollPeriod(row) === row.date.slice(0, 7) &&
    isSpecialSalaryMonth(nextMonth);
}
