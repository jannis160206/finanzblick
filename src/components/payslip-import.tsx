"use client";

import { useEffect, useRef, useState } from "react";
import { FileUp, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { SectionHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parsePayslipPdf, PayslipPasswordError } from "@/lib/import/payslip";
import { payslipKey, payslipSchema, payrollEmployerKey, type Payslip, type PayslipDraft, type PayslipImport } from "@/lib/payslip-schema";
import { assertPayslipReview, capturePayslipReview, PayslipMutationError, preparePayslipMerge, removeReviewedPayslip, type PayslipReview } from "@/lib/payslip-storage";
import { isPayslipMutationRejection, usePayslipMutation } from "@/components/payslip-mutation";
import { FinanceStorageError } from "@/lib/finance-storage";
import { currency, monthLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PayslipRecords } from "@/components/payslip-records";
import { applyPayslipIncome } from "@/lib/payslip-income";

const moneyFields = [
  ["netPay", "Netto laut Abrechnung"],
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

function draftLabel(draft: PayslipDraft, index: number) {
  return draft.year && draft.month
    ? monthLabel(`${draft.year}-${String(draft.month).padStart(2, "0")}`) : `Abrechnung ${index + 1}`;
}

function payslipIncomeMessage(result: ReturnType<typeof applyPayslipIncome> | undefined) {
  if (!result) return "";
  const parts = result.applied.map((income) => `Abrechnung ${monthLabel(income.payrollMonth)} → ${monthLabel(income.month)}: Netto ${currency(income.net)}` +
    (income.special > 0 ? ` (davon Sonderzahlung ${currency(income.special)})` : ""));
  const done = parts.length ? `In „Monate“ eingetragen – ${parts.join(", ")}.` : "";
  const skipped = result.skipped.length
    ? `Netto nicht eindeutig für Abrechnung ${result.skipped.map((month) => monthLabel(month)).join(", ")} – im Folgemonat bitte manuell eintragen.` : "";
  return [done, skipped].filter(Boolean).join(" ");
}

export function PayslipImportPanel({ year, employer, onImported }: {
  year: Payslip["year"];
  employer: string;
  onImported: (entry: Payslip) => void;
}) {
  const { state, update, storageError } = useFinance();
  const [password, setPassword] = useState("");
  const [filesToRetry, setFilesToRetry] = useState<File[]>([]);
  const [report, setReport] = useState<PayslipImport | null>(null);
  const [replacement, setReplacement] = useState<{ entries: Payslip[]; review: PayslipReview } | null>(null);
  const [deleting, setDeleting] = useState<Payslip | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const importer = useRef<HTMLElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const request = useRef(0);
  const live = useRef({ state, update, storageError, onImported });
  const mutate = usePayslipMutation(state, update);
  useEffect(() => { live.current = { state, update, storageError, onImported }; }, [state, update, storageError, onImported]);
  useEffect(() => () => { request.current++; }, []);

  function storeEntries(entries: Payslip[], allowReplace: boolean, review?: PayslipReview) {
    const currentFinance = live.current;
    if (currentFinance.storageError)
      throw new FinanceStorageError(currentFinance.storageError);
    const merged = preparePayslipMerge(
      currentFinance.state.payslips ?? [],
      entries,
    );
    if (merged.conflicts.length && !allowReplace)
      throw new PayslipMutationError("Ersetzen abweichender Abrechnungen bestätigen.");
    const expected = review ?? capturePayslipReview(currentFinance.state.payslips ?? [], entries);
    assertPayslipReview(currentFinance.state.payslips ?? [], expected);
    let synced: ReturnType<typeof applyPayslipIncome> | undefined;
    mutate((current) => {
      assertPayslipReview(current.payslips ?? [], expected);
      const next = preparePayslipMerge(current.payslips ?? [], entries);
      if (next.conflicts.length && !allowReplace)
        throw new PayslipMutationError(
          "Abrechnungen inzwischen geändert. PDFs erneut hochladen.",
        );
      const income = applyPayslipIncome(current, entries);
      synced = income;
      if (!next.changed.length) return income.state;
      return {
        ...income.state,
        payslips: next.entries,
        payrollForecasts: current.payrollForecasts?.map((forecast) =>
          next.changed.some(
            (entry) =>
              entry.year === forecast.year &&
              payrollEmployerKey(entry.employer) ===
                payrollEmployerKey(forecast.employer),
          )
            ? { ...forecast, standardPayrollConfirmed: false }
            : forecast,
        ),
      };
    }, () => {
      currentFinance.onImported(
        entries.slice().sort((a, b) => b.year - a.year || b.month - a.month)[0],
      );
      const stored = merged.changed.length
        ? `${merged.changed.length} Abrechnung(en) automatisch übernommen.`
        : "Abrechnungen bereits vorhanden – nicht doppelt übernommen.";
      const message = [stored, payslipIncomeMessage(synced)].filter(Boolean).join(" ");
      setNotice(message);
      toast.success(message);
      setReplacement(null);
      setError("");
    }, (cause) => setError(cause.message));
  }

  async function readFiles(files: File[]) {
    if (inFlight.current) return;
    if (storageError) { setError(storageError); return; }
    if (!files.length || files.length > 24 || files.some((file) => !/\.pdf$/i.test(file.name))) {
      setError("Bitte 1 bis 24 PDF-Lohnabrechnungen auswählen.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setReport(null);
    setReplacement(null);
    setFilesToRetry([]);
    const current = ++request.current;
    let entries: Payslip[];
    try {
      const combined: PayslipImport = { drafts: [], issues: [] };
      for (const [fileIndex, file] of files.entries()) {
        if (file.size > 20 * 1024 * 1024) throw new Error("Max. 20 MB je PDF.");
        const parsed = await parsePayslipPdf(await file.arrayBuffer(), password || undefined);
        if (current !== request.current) return;
        combined.drafts.push(...parsed.drafts);
        combined.issues.push(...[...new Set(parsed.issues)].map((issue) => `Datei ${fileIndex + 1}: ${issue}`));
        if (combined.drafts.length > 240) throw new Error("Max. 240 Lohnabrechnungen je Import.");
      }
      if (!combined.drafts.length) throw new Error("Keine Lohnabrechnung erkannt. Vollständige Original-PDF mit lesbarem Text nötig.");
      setReport(combined);
      entries = combined.drafts.flatMap((draft) => {
        const parsed = payslipSchema.safeParse(draft);
        return parsed.success ? [parsed.data] : [];
      });
      if (!entries.length) {
        setError("Keine Abrechnung übernommen; siehe Importhinweise.");
        return;
      }
    } catch (cause) {
      if (current !== request.current) return;
      setError(cause instanceof Error ? cause.message : "Die PDF konnte nicht gelesen werden.");
      if (cause instanceof PayslipPasswordError) setFilesToRetry(files);
      return;
    } finally {
      inFlight.current = false;
      if (current === request.current) setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
    try {
      const merged = preparePayslipMerge(live.current.state.payslips ?? [], entries);
      if (merged.conflicts.length) {
        setReplacement({ entries, review: capturePayslipReview(live.current.state.payslips ?? [], entries) });
        setNotice("Abweichende Abrechnungen: Ersetzen bestätigen.");
      } else storeEntries(entries, false);
    } catch (cause) {
      if (!isPayslipMutationRejection(cause)) throw cause;
      setError(cause.message);
    }
  }

  const incomplete = report?.drafts.flatMap((draft, index) =>
    payslipSchema.safeParse(draft).success ? [] : [draftLabel(draft, index)]) ?? [];
  const records = (state.payslips ?? []).filter((entry) => entry.year === year &&
    (!employer || payrollEmployerKey(entry.employer) === payrollEmployerKey(employer))).sort((a, b) => b.month - a.month);
  return <>
    <section ref={importer} id="payroll-import" tabIndex={-1} className="panel min-w-0 rounded-2xl p-5 shadow-sm focus-visible:outline-2 focus-visible:outline-ring" aria-label="Lohnabrechnungen importieren">
      <SectionHeading title="Lohnabrechnungen" subtitle="PDF · max. 24 Dateien · 20 MB je Datei" />
      <div className="space-y-4">
        <div role="group" aria-label="PDF-Ablage für Lohnabrechnungen" className={cn("rounded-xl border border-dashed p-5 text-center", dragging && "border-primary bg-primary/5")}
          onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void readFiles(Array.from(event.dataTransfer.files)); }}>
          <FileUp className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="mb-3 text-sm">PDFs hier ablegen oder auswählen</p>
          <input ref={fileInput} type="file" accept=".pdf,application/pdf" multiple className="sr-only"
            aria-label="Lohnabrechnungen als PDF auswählen" disabled={busy || !!storageError}
            onChange={(event) => { if (event.target.files?.length) void readFiles(Array.from(event.target.files)); }} />
          <Button variant="outline" disabled={busy || !!storageError} onClick={() => fileInput.current?.click()}>
            {busy ? <><LoaderCircle className="size-4 animate-spin" />Analysiert lokal …</> : "PDF auswählen"}
          </Button>
          {busy && <p role="status" className="mt-2 text-xs text-muted-foreground">PDFs werden lokal gelesen.</p>}
        </div>
        <details open={filesToRetry.length > 0 || undefined} className="text-sm">
          <summary className="min-h-10 cursor-pointer rounded-md py-2 font-medium focus-visible:outline-2 focus-visible:outline-ring">Passwortgeschützte PDF</summary>
          <div className="space-y-3 pt-2">
          <label className="block space-y-2 text-sm">PDF-Passwort
            <Input type="password" autoComplete="off" value={password} disabled={busy} maxLength={200}
              onChange={(event) => setPassword(event.target.value)} />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">PDF und Passwort: nur lokal für diesen Seitenbesuch, nicht gespeichert oder versendet.</p>
          {filesToRetry.length > 0 && <Button variant="outline" disabled={busy || !password || !!storageError} onClick={() => { void readFiles(filesToRetry); }}>Mit Passwort erneut lesen</Button>}
          </div>
        </details>
      </div>
      {(error || storageError) && <p role="alert" className="mt-3 text-sm text-destructive">{storageError || error}</p>}
      {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
      {report && <div className="mt-4 space-y-3" aria-label="Upload-Auswertung">
        {incomplete.length > 0 && <div role="alert" className="rounded-lg border border-amber-500/30 p-3 text-sm">
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
              <h3 className="font-medium">{draftLabel(draft, index)} · {draft.employer ?? "Arbeitgeber nicht erkannt"}</h3>
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
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Vollständiger Jahresstand: Abrechnungen seit Jänner nötig. Das Netto wird im Folgemonat der Abrechnung unter „Monate“ eingetragen (Oktober-Abrechnung → November) (Gehalt, Rufbereitschaft, Sonderzahlungen); Kontoumsätze bleiben unverändert.</p>
      <PayslipRecords records={records} disabled={busy || !!storageError} onDelete={(record, trigger) => { deleteTrigger.current = trigger; setError(""); setDeleting(payslipSchema.parse(record)); }} />
    </section>
    <Dialog open={!!replacement} onOpenChange={(open) => {
      if (!open) { setReplacement(null); setNotice("Ersetzen abgebrochen. Gespeicherte Abrechnungen unverändert."); setError(""); }
    }}>
      <DialogContent variant="confirmation">
        <DialogHeader>
          <DialogTitle>Gespeicherte Abrechnungen ersetzen?</DialogTitle>
          <DialogDescription>Abweichende Werte für gespeicherte Monate. Überschreiben nur nach Bestätigung.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {replacement?.entries.map((entry) => <p key={payslipKey(entry)} className="mb-2 text-sm">
            {draftLabel(entry, 0)} · {entry.employer}: laufend {currency(entry.regularGross)}, Sonderzahlungen {currency(entry.specialGross)}
            {!!entry.unresolvedSixthBonus && <>; weitere Prämie {currency(entry.unresolvedSixthBonus)} mit offener Sechstelzuordnung</>}
          </p>)}
          {(error || storageError) && <p role="alert" className="text-sm text-destructive">{storageError || error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setReplacement(null); setNotice("Ersetzen abgebrochen. Gespeicherte Abrechnungen unverändert."); setError(""); }}>Abbrechen</Button>
          <Button disabled={!!storageError} onClick={() => {
            if (!replacement) return;
            try {
              storeEntries(replacement.entries, true, replacement.review);
            } catch (cause) {
              if (!isPayslipMutationRejection(cause)) throw cause;
              setError(cause.message);
            }
          }}>Abrechnungen ersetzen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
      <DialogContent variant="confirmation" onCloseAutoFocus={(event) => {
        event.preventDefault();
        const trigger = deleteTrigger.current;
        if (trigger?.isConnected && !trigger.disabled) trigger.focus();
        else importer.current?.focus();
      }}>
        <DialogHeader><DialogTitle>Lohnabrechnung entfernen?</DialogTitle><DialogDescription>Nur gespeicherte Rechenwerte entfernen; Original-PDF und Kontoumsätze bleiben unverändert.</DialogDescription></DialogHeader>
        <DialogBody>
          {deleting && <p className="mb-2 text-sm">{draftLabel(deleting, 0)} · {deleting.employer}</p>}
          {(error || storageError) && <p role="alert" className="text-sm text-destructive">{storageError || error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleting(null)}>Abbrechen</Button>
          <Button variant="destructive" disabled={!!storageError} onClick={() => {
            if (!deleting) return;
            if (live.current.storageError) { setError(live.current.storageError); return; }
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
              setError("");
              toast.success("Lohnabrechnung entfernt");
            }, (cause) => setError(cause.message));
          }}>Entfernen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
