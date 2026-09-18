"use client";

import { useEffect, useRef, useState } from "react";
import { FileUp, LoaderCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { SectionHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parsePayslipPdf, PayslipPasswordError } from "@/lib/import/payslip";
import { payslipKey, payslipSchema, payrollEmployerKey, type Payslip, type PayslipDraft, type PayslipImport } from "@/lib/payslip-schema";
import { preparePayslipMerge } from "@/lib/payslip-storage";
import { currency, monthLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const moneyFields = [
  ["regularGross", "Sechstelrelevantes laufendes Brutto"],
  ["specialGross", "Sonderzahlungen brutto im Monat"],
  ["unresolvedSixthBonus", "Tarifbesteuerte Prämie · Sechstelzuordnung offen"],
  ["baseSalary", "Grundgehalt ohne variable Zulagen"],
  ["regularSv", "SV laufend"],
  ["regularTax", "Lohnsteuer laufend"],
  ["monthlyTaxableBase", "LSt-Bemessungsgrundlage laufend"],
  ["specialSv", "SV Sonderzahlungen im Monat"],
  ["reportedSixth", "Jahressechstel laut Abrechnung"],
] as const;

function draftLabel(draft: PayslipDraft, index: number) {
  return draft.year && draft.month
    ? monthLabel(`${draft.year}-${String(draft.month).padStart(2, "0")}`) : `Abrechnung ${index + 1}`;
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
  const [replacement, setReplacement] = useState<Payslip[] | null>(null);
  const [deleting, setDeleting] = useState<Payslip | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const request = useRef(0);
  const live = useRef({ state, update, storageError, onImported });
  useEffect(() => { live.current = { state, update, storageError, onImported }; }, [state, update, storageError, onImported]);
  useEffect(() => () => { request.current++; }, []);

  function storeEntries(entries: Payslip[], allowReplace: boolean) {
    const currentFinance = live.current;
    if (currentFinance.storageError) throw new Error(currentFinance.storageError);
    const merged = preparePayslipMerge(currentFinance.state.payslips ?? [], entries);
    if (merged.conflicts.length && !allowReplace) throw new Error("Eine abweichende gespeicherte Abrechnung benötigt eine Bestätigung zum Ersetzen.");
    currentFinance.update((current) => {
      const next = preparePayslipMerge(current.payslips ?? [], entries);
      if (next.conflicts.length && !allowReplace) throw new Error("Die gespeicherten Abrechnungen wurden inzwischen geändert. Bitte die PDFs erneut hochladen.");
      return { ...current, payslips: next.entries,
        payrollForecasts: current.payrollForecasts?.map((forecast) => next.changed.some((entry) =>
          entry.year === forecast.year && payrollEmployerKey(entry.employer) === payrollEmployerKey(forecast.employer))
          ? { ...forecast, standardPayrollConfirmed: false } : forecast),
      };
    });
    currentFinance.onImported(entries.slice().sort((a, b) => b.year - a.year || b.month - a.month)[0]);
    const message = merged.changed.length
      ? `${merged.changed.length} Abrechnung(en) automatisch übernommen. Jahressechstel und Prognose wurden aktualisiert.`
      : "Abrechnungen bereits vorhanden – nicht doppelt übernommen.";
    setNotice(message);
    toast.success(message);
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
    try {
      const combined: PayslipImport = { drafts: [], issues: [] };
      for (const [fileIndex, file] of files.entries()) {
        if (file.size > 20 * 1024 * 1024) throw new Error("Eine Lohnabrechnung darf höchstens 20 MB groß sein.");
        const parsed = await parsePayslipPdf(await file.arrayBuffer(), password || undefined);
        if (current !== request.current) return;
        combined.drafts.push(...parsed.drafts);
        combined.issues.push(...[...new Set(parsed.issues)].map((issue) => `Datei ${fileIndex + 1}: ${issue}`));
        if (combined.drafts.length > 240) throw new Error("Ein Import darf höchstens 240 Lohnabrechnungen enthalten.");
      }
      if (!combined.drafts.length) throw new Error("Keine auswertbare Lohnabrechnung erkannt. Bitte die vollständige Original-PDF mit lesbarem Text hochladen.");
      setReport(combined);
      const entries = combined.drafts.flatMap((draft) => {
        const parsed = payslipSchema.safeParse(draft);
        return parsed.success ? [parsed.data] : [];
      });
      if (!entries.length) {
        setError("Keine Abrechnung übernommen. Den Grund findest du unter Importhinweise.");
        return;
      }
      const merged = preparePayslipMerge(live.current.state.payslips ?? [], entries);
      if (merged.conflicts.length) {
        setReplacement(entries);
        setNotice("Auswertung abgeschlossen. Für abweichende gespeicherte Abrechnungen bitte das Ersetzen bestätigen.");
      } else storeEntries(entries, false);
    } catch (cause) {
      if (current !== request.current) return;
      setError(cause instanceof Error ? cause.message : "Die PDF konnte nicht gelesen werden.");
      if (cause instanceof PayslipPasswordError) setFilesToRetry(files);
    } finally {
      inFlight.current = false;
      if (current === request.current) setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const incomplete = report?.drafts.flatMap((draft, index) =>
    payslipSchema.safeParse(draft).success ? [] : [draftLabel(draft, index)]) ?? [];
  const records = (state.payslips ?? []).filter((entry) => entry.year === year &&
    (!employer || payrollEmployerKey(entry.employer) === payrollEmployerKey(employer))).sort((a, b) => b.month - a.month);
  return <>
    <section className="panel mb-6 p-5 sm:p-6" aria-label="Lohnabrechnungen importieren">
      <SectionHeading title="Lohnabrechnungen" subtitle="PDF hochladen oder hineinziehen. Neuere Abrechnungen aktualisieren die Berechnung automatisch." />
      <div className="grid gap-4 sm:grid-cols-[1fr_16rem]">
        <div role="group" aria-label="PDF-Ablage für Lohnabrechnungen" className={cn("rounded-xl border border-dashed p-5 text-center", dragging && "border-primary bg-primary/5")}
          onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void readFiles(Array.from(event.dataTransfer.files)); }}>
          <FileUp className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="mb-3 text-sm">Eine oder mehrere Lohnabrechnungen als PDF</p>
          <input ref={fileInput} type="file" accept=".pdf,application/pdf" multiple className="sr-only"
            aria-label="Lohnabrechnungen als PDF auswählen" disabled={busy || !!storageError}
            onChange={(event) => { if (event.target.files?.length) void readFiles(Array.from(event.target.files)); }} />
          <Button variant="outline" disabled={busy || !!storageError} onClick={() => fileInput.current?.click()}>
            {busy ? <><LoaderCircle className="size-4 animate-spin" />Analysiert lokal …</> : "PDF auswählen"}
          </Button>
          {busy && <p role="status" className="mt-2 text-xs text-muted-foreground">Lohnabrechnungen werden lokal gelesen.</p>}
        </div>
        <div className="space-y-3">
          <label className="block space-y-2 text-sm">PDF-Passwort
            <Input type="password" autoComplete="off" value={password} disabled={busy} maxLength={200}
              onChange={(event) => setPassword(event.target.value)} />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">Nur lokal für diesen Seitenbesuch. PDF und Passwort werden nicht gespeichert oder versendet.</p>
          {filesToRetry.length > 0 && <Button variant="outline" disabled={busy || !password || !!storageError} onClick={() => { void readFiles(filesToRetry); }}>Mit Passwort erneut lesen</Button>}
        </div>
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
            {incomplete.length > 0 && <p>Für diese Monate ist eine vollständige, unterstützte Text-PDF erforderlich. Unklare Beträge bleiben unbekannt; andere vollständig erkannte Monate werden unabhängig davon übernommen.</p>}
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
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Für den vollständigen Jahresstand die Abrechnungen seit Jänner hochladen. Kontoumsätze bleiben unverändert.</p>
      {records.length > 0 && <div className="mt-5 overflow-x-auto">
        <table className="w-full text-left text-sm" aria-label="Gespeicherte Lohnabrechnungen">
          <thead><tr className="border-b text-xs text-muted-foreground"><th className="p-2">Abrechnung</th><th className="p-2 text-right">Laufendes Brutto</th><th className="p-2 text-right">Sonderzahlung</th><th><span className="sr-only">Aktionen</span></th></tr></thead>
          <tbody>{records.map((record) => <tr key={payslipKey(record)} className="border-b last:border-0">
            <td className="p-2">{monthLabel(`${record.year}-${String(record.month).padStart(2, "0")}`)}<span className="block text-xs text-muted-foreground">{record.employer}</span>
              {!!record.unresolvedSixthBonus && <span className="block text-xs text-muted-foreground">Weitere Prämie: {currency(record.unresolvedSixthBonus)} · Sechstelzuordnung offen</span>}
            </td>
            <td className="p-2 text-right whitespace-nowrap tabular-nums">{currency(record.regularGross)}</td>
            <td className="p-2 text-right whitespace-nowrap tabular-nums">{currency(record.specialGross)}</td>
            <td className="p-2"><div className="flex justify-end">
              <Button variant="ghost" size="icon" className="size-7" aria-label={`Abrechnung entfernen: ${record.month}/${record.year}`}
                disabled={busy || !!storageError} onClick={() => setDeleting(record)}><Trash2 className="size-3.5" /></Button>
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
    <Dialog open={!!replacement} onOpenChange={(open) => {
      if (!open) { setReplacement(null); setNotice("Ersetzen abgebrochen. Dieser Upload hat keine gespeicherten Abrechnungen geändert."); setError(""); }
    }}>
      <DialogContent variant="confirmation">
        <DialogHeader>
          <DialogTitle>Gespeicherte Abrechnungen ersetzen?</DialogTitle>
          <DialogDescription>Der Upload enthält abweichende Werte für bereits gespeicherte Monate. Nur nach Bestätigung ersetzt die neue PDF diese Werte; es werden keine Beträge von Hand eingegeben.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {replacement?.map((entry) => <p key={payslipKey(entry)} className="mb-2 text-sm">
            {draftLabel(entry, 0)} · {entry.employer}: laufend {currency(entry.regularGross)}, Sonderzahlungen {currency(entry.specialGross)}
            {!!entry.unresolvedSixthBonus && <>; weitere Prämie {currency(entry.unresolvedSixthBonus)} mit offener Sechstelzuordnung</>}
          </p>)}
          {(error || storageError) && <p role="alert" className="text-sm text-destructive">{storageError || error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setReplacement(null); setNotice("Ersetzen abgebrochen. Dieser Upload hat keine gespeicherten Abrechnungen geändert."); setError(""); }}>Abbrechen</Button>
          <Button disabled={!!storageError} onClick={() => {
            if (!replacement) return;
            try {
              storeEntries(replacement, true);
              setReplacement(null);
              setError("");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Die Abrechnungen konnten nicht ersetzt werden.");
            }
          }}>Abrechnungen ersetzen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
      <DialogContent variant="confirmation">
        <DialogHeader><DialogTitle>Lohnabrechnung entfernen?</DialogTitle><DialogDescription>Nur die lokalen Rechenwerte werden entfernt. Die Original-PDF und deine Kontoumsätze bleiben unverändert.</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleting(null)}>Abbrechen</Button>
          <Button variant="destructive" disabled={!!storageError} onClick={() => {
            if (!deleting) return;
            const key = payslipKey(deleting);
            update((current) => {
              const payslips = current.payslips?.filter((entry) => payslipKey(entry) !== key);
              const matches = (entry: { year: number; employer: string }) => entry.year === deleting.year &&
                payrollEmployerKey(entry.employer) === payrollEmployerKey(deleting.employer);
              return { ...current, payslips,
                payrollForecasts: current.payrollForecasts?.filter((forecast) => !matches(forecast) || payslips?.some(matches))
                  .map((forecast) => matches(forecast) ? { ...forecast, standardPayrollConfirmed: false } : forecast),
              };
            });
            setDeleting(null);
            toast.success("Lohnabrechnung entfernt");
          }}>Entfernen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
