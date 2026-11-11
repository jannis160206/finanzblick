import { applyBudgetCorrections, budgetCorrections, type BudgetCorrection } from "@/lib/budget-corrections";
import { applyPayslipIncome } from "@/lib/payslip-income";
import { payslipKey, type Payslip } from "@/lib/payslip-schema";
import { payslipFingerprint, payslipHold, type PayslipValidation } from "@/lib/payslip-validation";
import { salaryForecast, type SalaryForecast } from "@/lib/salary-forecast";
import type { AppState, PayrollBudgetState } from "@/lib/types";

/** Budget values from payslips and the salary forecast: written automatically, or offered for review. */
export type AutoBudget = { apply: BudgetCorrection[]; review: BudgetCorrection[] };

const cents = (value: number) => Math.round(value * 100);

/**
 * Splits the budget corrections: a value goes in automatically unless the user changed it by hand since Finanzblick
 * last set it, or it would remove a possibly double special payment from "Sonstiges". Those are offered for review;
 * corrections the user chose to keep are left alone.
 */
export function autoBudgetCorrections(state: AppState, forecast: SalaryForecast = salaryForecast(state)): AutoBudget {
  const targets = state.payrollBudget?.targets ?? {};
  const kept = new Set(state.payrollBudget?.kept ?? []);
  const result: AutoBudget = { apply: [], review: [] };
  for (const item of budgetCorrections(state, forecast)) {
    if (kept.has(item.id)) continue;
    if (item.kind === "duplicate") { result.review.push(item); continue; }
    const target = targets[item.rowId]?.[item.month];
    if (target !== undefined && cents(target) !== cents(item.from)) result.review.push({ ...item, reason: `von Hand geändert · ${item.reason}` });
    else result.apply.push(item);
  }
  return result;
}

/**
 * Remembers what Finanzblick considers the right value of every forecast row and month (also those that already
 * matched), so a later hand-made change is recognised. Past months are forgotten.
 */
function remember(state: AppState, forecast: SalaryForecast, now: number | undefined, keep: readonly BudgetCorrection[] = []): AppState {
  const current = state.settings.asOf.slice(0, 7);
  const previous = state.payrollBudget ?? {};
  const targets: NonNullable<PayrollBudgetState["targets"]> = {};
  for (const [row, months] of Object.entries(previous.targets ?? {})) {
    const recent = Object.fromEntries(Object.entries(months).filter(([month]) => month >= current));
    if (Object.keys(recent).length) targets[row] = recent;
  }
  const review = new Set(autoBudgetCorrections(state, forecast).review.map((item) => item.id));
  for (const item of budgetCorrections(state, forecast, { all: true })) {
    if (item.kind === "duplicate" || review.has(item.id)) continue;
    targets[item.rowId] = { ...targets[item.rowId], [item.month]: item.to };
  }
  const kept = [...new Set([...(previous.kept ?? []), ...keep.map((item) => item.id)])].filter((id) => id.slice(-7) >= current).slice(-500);
  const next: PayrollBudgetState = { ...previous, ...(now !== undefined ? { at: now } : {}), targets };
  if (kept.length) next.kept = kept;
  else delete next.kept;
  return { ...state, payrollBudget: next };
}

/** Forecast targets not remembered yet (first run, new months): recorded without changing any value. */
function unrecorded(state: AppState, forecast: SalaryForecast, review: readonly BudgetCorrection[]) {
  const targets = state.payrollBudget?.targets ?? {};
  const skip = new Set(review.map((item) => item.id));
  return budgetCorrections(state, forecast, { all: true })
    .some((item) => item.kind !== "duplicate" && !skip.has(item.id) && targets[item.rowId]?.[item.month] === undefined);
}

/** What the automatic budget would do now: values to write, values to review, targets still to remember. */
export function planPayrollBudget(state: AppState, forecast: SalaryForecast = salaryForecast(state)) {
  const { apply, review } = autoBudgetCorrections(state, forecast);
  return { apply, review, record: !apply.length && unrecorded(state, forecast, review) };
}

/** Writes every budget value that may go in automatically. Unchanged state when there is nothing to do. */
export function syncPayrollBudget(state: AppState, now = Date.now()): { state: AppState; applied: BudgetCorrection[]; review: BudgetCorrection[] } {
  const forecast = salaryForecast(state);
  const { apply, review, record } = planPayrollBudget(state, forecast);
  if (record) return { state: remember(state, forecast, undefined), applied: [], review };
  if (!apply.length) return { state, applied: [], review };
  const written = applyBudgetCorrections(state, apply).state;
  return { state: remember(written, salaryForecast(written), now), applied: apply, review };
}

/** The user's decision on reviewed values: `chosen` are written, `keep` stay as they are and are not offered again. */
export function reviewPayrollBudget(state: AppState, chosen: readonly BudgetCorrection[], keep: readonly BudgetCorrection[], now = Date.now()): AppState {
  const written = applyBudgetCorrections(state, chosen).state;
  return remember(written, salaryForecast(written), now, keep);
}

/**
 * Takes a payslip into the budget although its numbers contradict each other: the user confirmed exactly these values.
 * Confirmations of payslips that are no longer stored are dropped.
 */
export function confirmPayslip(state: AppState, entry: Payslip) {
  const stored = new Set((state.payslips ?? []).map(payslipKey));
  const fingerprint = payslipFingerprint(entry);
  const confirmed = [...new Set([...(state.payrollBudget?.confirmed ?? []), fingerprint])]
    .filter((item) => stored.has(item.split("#")[0])).slice(-240);
  const income = applyPayslipIncome({ ...state, payrollBudget: { ...state.payrollBudget, confirmed } }, [entry]);
  return { state: income.state, income };
}

/** Stored payslips kept out of the budget because their numbers contradict each other, oldest first. */
export function heldPayslips(state: AppState): { entry: Payslip; validation: PayslipValidation }[] {
  const payslips = state.payslips ?? [];
  return payslips.flatMap((entry) => {
    const validation = payslipHold(entry, payslips, state.payrollBudget?.confirmed);
    return validation ? [{ entry, validation }] : [];
  }).sort((a, b) => a.entry.year - b.entry.year || a.entry.month - b.entry.month);
}
