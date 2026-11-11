"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useAccountWorkspace } from "@/components/account-context";
import { BudgetUpdate } from "@/components/budget-update-dialog";
import { requestDriveInbox } from "@/components/drive-inbox";
import { useFinance } from "@/components/finance-provider";
import { usePayslipLogStore } from "@/components/payslip-log";
import { usePayslipMutation } from "@/components/payslip-mutation";
import { payslipDraftLabel, usePayslipUpload } from "@/components/payslip-upload";
import { Button } from "@/components/ui/button";
import { accountRequest, AccountRequestError } from "@/lib/account-request";
import type { DriveStatus } from "@/lib/drive/store";
import { monthLabel } from "@/lib/format";
import { applyPayslipIncome } from "@/lib/payslip-income";
import { payslipLogEntry } from "@/lib/payslip-log";
import { isReferencePayslip, payslipSchema } from "@/lib/payslip-schema";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const period = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/** Asks Drive to fetch every payslip again; quietly does nothing without an account or a Drive connection. */
async function recheckDrive(account: string | null): Promise<string> {
  if (!account) return "";
  try {
    const { status } = await accountRequest<{ status: DriveStatus }>("/api/drive", account, { method: "POST", json: { action: "recheck" } },
      "Google Drive konnte nicht geprüft werden.");
    if (status.inbox) requestDriveInbox();
    return status.inbox ? `${plural(status.inbox, "Datei", "Dateien")} aus Google Drive in Prüfung.` : "Google Drive geprüft.";
  } catch (cause) {
    if (cause instanceof AccountRequestError && [404, 409, 503].includes(cause.status)) return "";
    return cause instanceof Error ? cause.message : "Google Drive konnte nicht geprüft werden.";
  }
}

/** Short state of the stored payslips; details of every import go to the import log in the settings. */
export function PayslipSummary() {
  const { state, update, storageError } = useFinance();
  const { busy, error, notice, report, setMessage } = usePayslipUpload();
  const account = useAccountWorkspace()?.user.id ?? null;
  const logStore = usePayslipLogStore();
  const mutate = usePayslipMutation(state, update);
  const [checking, setChecking] = useState(false);
  const payslips = state.payslips ?? [];
  const current = payslips.filter((entry) => !isReferencePayslip(entry));
  const reference = payslips.length - current.length;
  const latest = current.reduce<(typeof current)[number] | undefined>((last, entry) =>
    !last || entry.year * 12 + entry.month > last.year * 12 + last.month ? entry : last, undefined);
  const notTaken = report?.drafts.flatMap((draft, index) => payslipSchema.safeParse(draft).success ? [] : [payslipDraftLabel(draft, index)]) ?? [];
  const working = busy || checking;

  function recheck() {
    if (storageError) { setMessage({ error: storageError }); return; }
    setChecking(true);
    let synced: ReturnType<typeof applyPayslipIncome> | undefined;
    mutate((current) => {
      synced = applyPayslipIncome(current, current.payslips ?? []);
      return synced.state;
    }, () => {
      void (async () => {
        const budget = synced?.applied.length
          ? `${plural(synced.applied.length, "Abrechnung", "Abrechnungen")} im Budget abgeglichen.`
          : "Keine Abrechnung fürs Budget.";
        const message = [budget, await recheckDrive(account)].filter(Boolean).join(" ");
        setMessage({ notice: message, error: "" });
        toast.success(message);
        logStore.append(payslipLogEntry({ source: "recheck", message, stored: 0 })).catch(() => undefined);
        setChecking(false);
      })();
    }, (cause) => {
      setMessage({ error: cause.message });
      setChecking(false);
    });
  }

  if (!payslips.length && !notice && !error && !storageError && !working) return null;
  return (
    <section id="payroll-import" tabIndex={-1} aria-label="Abrechnungen"
      className="panel min-w-0 scroll-mt-24 p-4 focus-visible:outline-2 focus-visible:outline-ring sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-primary">
            {working ? <LoaderCircle className="size-5 animate-spin" /> : <CheckCircle2 className="size-5" />}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">
              {current.length ? `${plural(current.length, "Abrechnung", "Abrechnungen")} übernommen` : "Noch keine Abrechnung übernommen"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {[latest ? `zuletzt ${monthLabel(period(latest.year, latest.month))}` : null,
                reference ? `${reference} aus 2025 als Referenz` : null].filter(Boolean).join(" · ") || "Netto landet im Folgemonat im Budget."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BudgetUpdate />
          <Button variant="outline" size="sm" className="min-h-11" disabled={working || !!storageError} onClick={recheck}>
            <RefreshCw aria-hidden="true" className={checking ? "motion-safe:animate-spin" : undefined} />Erneut prüfen
          </Button>
        </div>
      </div>
      {busy && <p role="status" className="mt-3 text-sm text-muted-foreground">PDFs werden lokal gelesen …</p>}
      {(error || storageError) && <p role="alert" className="mt-3 text-sm text-destructive">{storageError || error}</p>}
      {notice && <p role="status" title={notice} className="mt-3 line-clamp-2 text-sm text-muted-foreground">{notice}</p>}
      {notTaken.length > 0 && (
        <p role="alert" className="mt-2 text-xs text-muted-foreground">
          {notTaken.join(", ")} nicht übernommen ·{" "}
          <Link href="/einstellungen#import-protokoll" className="font-medium text-foreground underline-offset-4 hover:underline">Import-Protokoll</Link>
        </p>
      )}
    </section>
  );
}
