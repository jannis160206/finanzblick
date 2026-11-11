"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { usePayslipLogStore } from "@/components/payslip-log";
import { monthLabel } from "@/lib/format";
import { planPayrollBudget, syncPayrollBudget } from "@/lib/payroll-budget";
import { payslipLogEntry } from "@/lib/payslip-log";

// Waits until the data stops changing (an import writes in several steps), then updates the budget once.
const SETTLE_MS = 1500;

/**
 * Keeps the income rows in line with the payslips and the salary forecast without a confirmation: values the user
 * changed by hand and possible duplicates are left for review. A short toast and the import log tell what happened.
 */
export function PayrollBudgetSync() {
  const { state, update, ready, storageError } = useFinance();
  const logStore = usePayslipLogStore();
  useEffect(() => {
    if (ready === false || storageError) return;
    const timer = window.setTimeout(() => {
      const { apply, record } = planPayrollBudget(state);
      if (!apply.length && !record) return;
      const now = Date.now();
      update((current) => syncPayrollBudget(current, now).state);
      // First run or new months: only the targets are remembered, nothing in the budget changes.
      if (!apply.length) return;
      const months = [...new Set(apply.map((item) => item.month))].sort();
      const range = months.length === 1 ? monthLabel(months[0]) : `${monthLabel(months[0], true)} – ${monthLabel(months.at(-1)!, true)}`;
      const values = apply.length === 1 ? "1 Wert" : `${apply.length} Werte`;
      // The toast stays short; months, rows and amounts are in the import log.
      toast.success(`Budget aktualisiert · ${values}`);
      logStore.append(payslipLogEntry({
        source: "budget", message: `Budget aus Abrechnungen aktualisiert · ${values} (${range}).`, at: now,
        budget: { applied: apply.length, changes: apply.map((item) => ({ row: item.label, month: item.month, from: item.from, to: item.to, reason: item.reason })) },
      })).catch(() => undefined);
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [state, ready, storageError, update, logStore]);
  return null;
}
