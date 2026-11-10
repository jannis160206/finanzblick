"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { SectionHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { payslipSchema, payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";
import { removeReviewedPayslip } from "@/lib/payslip-storage";
import { usePayslipMutation } from "@/components/payslip-mutation";
import { currency } from "@/lib/format";
import { PayslipRecords } from "@/components/payslip-records";
import { applyPayslipIncome } from "@/lib/payslip-income";
import { payslipDraftLabel, payslipIncomeMessage, usePayslipUpload } from "@/components/payslip-upload";

const moneyFields = [
  ["netPay", "Netto laut Abrechnung"],
  ["advancePay", "Bereits überwiesen (Gehalt)"],
  ["payout", "Auszahlung (Rufbereitschaft)"],
  ["regularGross", "Sechstelrelevantes laufendes Brutto"],
  ["specialGross", "Sonderzahlungen brutto im Monat"],
  ["unresolvedSixthBonus", "Tarifbesteuerte Prämie · Sechstelzuordnung offen"],
  ["baseSalary", "Grundgehalt ohne variable Zulagen"],
  ["regularSv", "SV laufend"],
  ["regularTax", "Lohnsteuer laufend"],
  ["monthlyTaxableBase", "LSt-Bemessungsgrundlage laufend"],
  ["specialSv", "SV Sonderzahlungen im Monat"],
  ["specialTax", "Lohnsteuer Sonderzahlungen im Monat"],
  ["onCallGross", "Rufbereitschaft brutto"],
  ["reportedSixth", "Jahressechstel laut Abrechnung"],
] as const;

/** Saved payslips and the result of the last upload; uploading itself starts from the page's "Abrechnungen hochladen". */
export function PayslipImportPanel({ year, employer }: { year: Payslip["year"]; employer: string }) {
  const { state, update, storageError } = useFinance();
  const { busy, error, notice, report, setMessage } = usePayslipUpload();
  const [deleting, setDeleting] = useState<Payslip | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const importer = useRef<HTMLElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const mutate = usePayslipMutation(state, update);

  function syncStoredPayslips() {
    if (storageError) { setMessage({ error: storageError }); return; }
    let synced: ReturnType<typeof applyPayslipIncome> | undefined;
    mutate((current) => {
      synced = applyPayslipIncome(current, current.payslips ?? []);
      return synced.state;
    }, () => {
      const message = payslipIncomeMessage(synced) || "Keine Abrechnung übertragbar.";
      setMessage({ notice: message, error: "" });
      toast.success(message);
    }, (cause) => setMessage({ error: cause.message }));
  }

  const incomplete = report?.drafts.flatMap((draft, index) =>
    payslipSchema.safeParse(draft).success ? [] : [payslipDraftLabel(draft, index)]) ?? [];
  const records = (state.payslips ?? []).filter((entry) => entry.year === year &&
    (!employer || payrollEmployerKey(entry.employer) === payrollEmployerKey(employer))).sort((a, b) => b.month - a.month);
  const visible = records.length > 0 || !!report || !!notice || !!error || !!storageError || busy;
  return <>
    {visible && <section ref={importer} id="payroll-import" tabIndex={-1} aria-label="Abrechnungen"
      className="panel min-w-0 scroll-mt-24 space-y-4 p-5 focus-visible:outline-2 focus-visible:outline-ring sm:p-6">
      <SectionHeading title="Abrechnungen" subtitle="Das Netto landet im Folgemonat automatisch im Budget." />
      {busy && <p role="status" className="text-sm text-muted-foreground">PDFs werden lokal gelesen …</p>}
      {(error || storageError) && <p role="alert" className="text-sm text-destructive">{storageError || error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {report && <div className="space-y-3" aria-label="Upload-Auswertung">
        {incomplete.length > 0 && <div role="alert" className="rounded-lg bg-warning-soft p-3 text-sm">
          <p>Nicht vollständig erkannt: {incomplete.join(", ")}. Diese Monate wurden nicht übernommen.</p>
        </div>}
        {(report.issues.length > 0 || incomplete.length > 0) && <details className="text-sm">
          <summary className="cursor-pointer">Importhinweise</summary>
          <div className="mt-2 space-y-2 text-xs text-muted-foreground">
            {report.issues.map((issue, index) => <p key={index}>{issue}</p>)}
            {incomplete.length > 0 && <p>Vollständige, unterstützte Text-PDF nötig. Unklare Beträge bleiben unbekannt; vollständig erkannte Monate werden separat übernommen.</p>}
          </div>
        </details>}
        <details className="text-sm">
          <summary className="cursor-pointer">Automatisch gelesene Werte</summary>
          <div className="mt-3 space-y-3">
            {report.drafts.map((draft, index) => <section key={index} className="rounded-lg border p-3" aria-label={`Auswertung ${index + 1}`}>
              <h3 className="font-medium">{payslipDraftLabel(draft, index)} · {draft.employer ?? "Arbeitgeber nicht erkannt"}</h3>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                {moneyFields.map(([key, label]) => <div key={key}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 tabular-nums">{draft[key] === undefined ? "Nicht belegt" : currency(draft[key])}</dd>
                </div>)}
              </dl>
            </section>)}
          </div>
        </details>
      </div>}
      {(state.payslips?.length ?? 0) > 0 && <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={busy || !!storageError} onClick={syncStoredPayslips}>Gespeicherte ins Budget übertragen</Button>
      </div>}
      <PayslipRecords records={records} disabled={busy || !!storageError} onDelete={(record, trigger) => { deleteTrigger.current = trigger; setDeleteError(""); setDeleting(payslipSchema.parse(record)); }} />
    </section>}
    <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
      <DialogContent variant="confirmation" onCloseAutoFocus={(event) => {
        event.preventDefault();
        const trigger = deleteTrigger.current;
        if (trigger?.isConnected && !trigger.disabled) trigger.focus();
        else importer.current?.focus();
      }}>
        <DialogHeader><DialogTitle>Lohnabrechnung entfernen?</DialogTitle><DialogDescription>Nur gespeicherte Rechenwerte entfernen; Original-PDF und Kontoumsätze bleiben unverändert.</DialogDescription></DialogHeader>
        <DialogBody>
          {deleting && <p className="mb-2 text-sm">{payslipDraftLabel(deleting, 0)} · {deleting.employer}</p>}
          {(deleteError || storageError) && <p role="alert" className="text-sm text-destructive">{storageError || deleteError}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleting(null)}>Abbrechen</Button>
          <Button variant="destructive" disabled={!!storageError} onClick={() => {
            if (!deleting) return;
            if (storageError) { setDeleteError(storageError); return; }
            mutate((current) => {
              const payslips = removeReviewedPayslip(current.payslips ?? [], deleting);
              const matches = (entry: { year: number; employer: string }) => entry.year === deleting.year &&
                payrollEmployerKey(entry.employer) === payrollEmployerKey(deleting.employer);
              return { ...current, payslips,
                payrollForecasts: current.payrollForecasts?.filter((forecast) => !matches(forecast) || payslips?.some(matches))
                  .map((forecast) => matches(forecast) ? { ...forecast, standardPayrollConfirmed: false } : forecast),
              };
            }, () => {
              setDeleting(null);
              setDeleteError("");
              toast.success("Lohnabrechnung entfernt");
            }, (cause) => setDeleteError(cause.message));
          }}>Entfernen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
