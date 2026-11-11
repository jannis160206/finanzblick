import { ZodError } from "zod";
import { createEmptyAccountState } from "@/lib/account-state";
import { queueLedgerReview } from "@/lib/import/review";
import { applyPayslipIncome } from "@/lib/payslip-income";
import { payslipLogEntry, type PayslipLogFile } from "@/lib/payslip-log";
import { validatePayslips, type PayslipValidation } from "@/lib/payslip-validation";
import { isReferencePayslip, payrollEmployerKey, payslipSchema, type Payslip, type PayslipImport } from "@/lib/payslip-schema";
import { preparePayslipMerge } from "@/lib/payslip-storage";
import { synchronizePlan } from "@/lib/planning";
import type { AccountDatabase } from "@/lib/server/database";
import { isAccountError } from "@/lib/server/errors";
import { appendPayslipLogFile } from "@/lib/server/payslip-log-store";
import { readUserSecret, userSecretInfo } from "@/lib/server/user-secrets";
import { appStateSchema, type AppState } from "@/lib/types";
import { inboxFilePath, listInbox, markInboxItem, removeInboxItem } from "./inbox";
import { readPayslipInChild, type PayslipReader } from "./payslip-runtime";
import { recordInboxOutcome } from "./store";

const MAX_PER_RUN = 48;

export type DriveInboxRun = { imported: number; waiting: number; skipped: number; failed: number };
type Merge = { state: AppState; changed: number } | { conflict: true } | { unchanged: true };

/**
 * The same merge as an upload in the browser: new or enriched payslips are stored, their net pay goes into the next
 * month's income rows, standard payroll forecasts of that employer and year need a fresh confirmation. A payslip
 * that would overwrite different stored values is left for the browser, where the user confirms the replacement.
 */
export function mergeServerPayslips(state: AppState, entries: Payslip[]): Merge {
  const merged = preparePayslipMerge(state.payslips ?? [], entries);
  if (merged.conflicts.length) return { conflict: true };
  const income = applyPayslipIncome(state, entries);
  if (!merged.changed.length && JSON.stringify(income.state.financeRows) === JSON.stringify(state.financeRows)) return { unchanged: true };
  const next: AppState = merged.changed.length ? {
    ...income.state,
    payslips: merged.entries,
    payrollForecasts: state.payrollForecasts?.map((forecast) =>
      merged.changed.some((entry) => entry.year === forecast.year && payrollEmployerKey(entry.employer) === payrollEmployerKey(forecast.employer))
        ? { ...forecast, standardPayrollConfirmed: false }
        : forecast),
  } : income.state;
  return { state: appStateSchema.parse(synchronizePlan(queueLedgerReview(next))), changed: merged.changed.length };
}

class Stop {
  constructor(readonly result: "conflict" | "unchanged") {}
}

function commit(database: AccountDatabase, userId: string, entries: Payslip[]): "imported" | "unchanged" | "conflict" {
  for (let attempt = 0; ; attempt++) {
    try {
      database.transformFinance(userId, (stored) => {
        const merged = mergeServerPayslips(stored ?? createEmptyAccountState(), entries);
        if ("conflict" in merged) throw new Stop("conflict");
        if ("unchanged" in merged) throw new Stop("unchanged");
        return merged.state;
      }, () => undefined);
      return "imported";
    } catch (error) {
      if (error instanceof Stop) return error.result;
      // Saved in the browser meanwhile: merge again on the newer state.
      if (isAccountError(error) && error.status === 409 && attempt < 2) continue;
      throw error;
    }
  }
}

const failureText = (error: unknown) =>
  error instanceof ZodError ? "Die Abrechnung konnte nicht übernommen werden."
    : error instanceof Error && error.message ? error.message.slice(0, 300) : "Die Abrechnung konnte nicht übernommen werden.";

/**
 * Imports payslips from the Drive inbox without an open browser (statement worker). Files that need a password
 * nobody stored, or a confirmation to replace stored values, stay in the inbox for the app to ask the user.
 */
export async function processDriveInbox(
  database: AccountDatabase,
  userId: string,
  options: { read?: PayslipReader; signal?: AbortSignal } = {},
): Promise<DriveInboxRun> {
  const { read = readPayslipInChild, signal } = options;
  const run: DriveInboxRun = { imported: 0, waiting: 0, skipped: 0, failed: 0 };
  const items = await listInbox(database, userId);
  if (!items.length) return run;
  const stored = await userSecretInfo(database, userId, "payslip-password").catch(() => null);
  const passwordAt = stored?.updatedAt ?? 0;
  let password: string | null | undefined;
  let handled = 0;
  let saved = 0;
  const files: PayslipLogFile[] = [];
  const validation: PayslipValidation[] = [];
  const report: PayslipImport = { drafts: [], issues: [] };
  for (const item of items) {
    if (signal?.aborted || handled >= MAX_PER_RUN) break;
    if (item.waiting === "conflict" || (item.waiting === "password" && (item.passwordAt ?? 0) === passwordAt)) {
      run.waiting++;
      continue;
    }
    handled++;
    const finish = async (outcome: "imported" | "skipped" | "failed", note: string) => {
      await recordInboxOutcome(database, userId, item.id, outcome, note);
      await removeInboxItem(database, userId, item.id);
      run[outcome]++;
      files.push({ name: item.name, outcome, note });
    };
    try {
      if (password === undefined) password = stored ? await readUserSecret(database, userId, "payslip-password").catch(() => null) : null;
      const parsed = await read(inboxFilePath(database, userId, item.id), item.size, password ? [password] : [], { signal });
      if (parsed.status === "locked") {
        await markInboxItem(database, userId, item.id, { waiting: "password", passwordAt });
        run.waiting++;
        files.push({ name: item.name, outcome: "waiting", note: password ? "Gespeichertes Passwort passt nicht." : "Passwort fehlt." });
        continue;
      }
      report.drafts.push(...parsed.result.drafts);
      report.issues.push(...parsed.result.issues.map((issue) => `${item.name}: ${issue}`));
      if (!parsed.result.drafts.length) { await finish("skipped", "Keine Lohnabrechnung erkannt."); continue; }
      const entries = parsed.result.drafts.flatMap((draft) => {
        const entry = payslipSchema.safeParse(draft);
        return entry.success ? [entry.data] : [];
      });
      if (!entries.length) { await finish("failed", "Nicht vollständig erkannt."); continue; }
      validation.push(...validatePayslips(entries, database.getFinance(userId).state?.payslips ?? []));
      const result = commit(database, userId, entries);
      if (result === "conflict") {
        await markInboxItem(database, userId, item.id, { waiting: "conflict" });
        run.waiting++;
        files.push({ name: item.name, outcome: "waiting", note: "Abweichende Werte – Ersetzen in der App bestätigen." });
        continue;
      }
      if (result === "imported") saved += entries.length;
      const reference = entries.every(isReferencePayslip);
      await finish("imported", result !== "imported" ? "Bereits vorhanden."
        : reference ? "Als Referenz übernommen – nicht im Budget." : "Im Hintergrund übernommen.");
    } catch (error) {
      if (signal?.aborted) break;
      await finish("failed", failureText(error));
    }
  }
  if (files.length) {
    const message = `Google Drive im Hintergrund: ${run.imported} übernommen, ${run.waiting} warten, ${run.skipped} übersprungen, ${run.failed} fehlgeschlagen.`;
    await appendPayslipLogFile(database, userId, payslipLogEntry({ source: "drive-background", message, files, report, stored: saved, validation })).catch(() => undefined);
  }
  return run;
}
