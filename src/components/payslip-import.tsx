"use client";

import { useEffect, useRef, useState } from "react";
import { FileUp, LoaderCircle, Pencil, Trash2 } from "lucide-react";
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
  ["baseSalary", "Grundgehalt ohne variable Zulagen"],
  ["regularSv", "SV laufend"],
  ["regularTax", "Lohnsteuer laufend"],
  ["monthlyTaxableBase", "LSt-Bemessungsgrundlage laufend"],
  ["specialSv", "SV Sonderzahlungen im Monat"],
  ["reportedSixth", "Jahressechstel laut Abrechnung"],
] as const;
const cumulativeFields = [
  ["regularGrossYtd", "Laufendes sechstelrelevantes Brutto seit Jänner"],
  ["specialGrossYtd", "Sonderzahlungen brutto seit Jänner"],
  ["specialTaxableYtd", "Begünstigte SZ-Steuerbasis seit Jänner, vor 620 Euro"],
  ["usedSixth", "Verbrauchtes Brutto-Sechstel laut Lohnverrechnung"],
] as const;

type PendingImport = PayslipImport & { editing?: boolean };

function PayslipReview({ pending, onClose, onSaved }: {
  pending: PendingImport;
  onClose: () => void;
  onSaved: (entry: Payslip) => void;
}) {
  const { state, update, storageError } = useFinance();
  const [drafts, setDrafts] = useState(() => pending.drafts.map((draft) => ({ ...draft, monthlyPayroll: draft.monthlyPayroll ?? false })));
  const [checked, setChecked] = useState(false);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState("");
  const parsed = drafts.map((draft) => payslipSchema.safeParse(draft));
  const valid = drafts.length > 0 && parsed.every((entry) => entry.success);
  const hasExisting = drafts.some(({ year, month, employer }) => year && month && employer &&
    state.payslips?.some((saved) => payslipKey(saved) === payslipKey({
      year, month, employer,
    })));
  function change(index: number, value: PayslipDraft) {
    setDrafts((current) => current.map((draft, item) => item === index ? { ...value, monthlyPayroll: value.monthlyPayroll ?? false } : draft));
    setChecked(false);
    setError("");
  }
  function save() {
    if (storageError) { setError(storageError); return; }
    if (!valid || !checked) { setError("Bitte die erkannten Werte vollständig prüfen und bestätigen."); return; }
    const entries = drafts.map((draft) => payslipSchema.parse(draft));
    try {
      const merged = preparePayslipMerge(state.payslips ?? [], entries);
      if (merged.conflicts.length && !replace) {
        setError("Für diesen Monat ist bereits eine abweichende Abrechnung gespeichert. Ersetzen bitte ausdrücklich bestätigen.");
        return;
      }
      update((current) => {
        const next = preparePayslipMerge(current.payslips ?? [], entries);
        if (next.conflicts.length && !replace) throw new Error("Die gespeicherte Abrechnung wurde inzwischen geändert.");
        return { ...current, payslips: next.entries,
          payrollForecasts: current.payrollForecasts?.map((forecast) => next.changed.some((entry) =>
            entry.year === forecast.year && payrollEmployerKey(entry.employer) === payrollEmployerKey(forecast.employer))
            ? { ...forecast, standardPayrollConfirmed: false } : forecast),
        };
      });
      onSaved(entries.slice().sort((a, b) => b.year - a.year || b.month - a.month)[0]);
      onClose();
      toast.success(merged.duplicates === entries.length ? "Abrechnung bereits vorhanden – nicht doppelt übernommen." : "Lohnabrechnung lokal übernommen.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Die Abrechnung konnte nicht übernommen werden.");
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Lohnabrechnung prüfen</DialogTitle>
        <DialogDescription>Die Beträge wurden lokal gelesen. Nur diese bestätigten Rechenwerte werden gespeichert, nicht PDF, Passwort, Adresse, Personalnummer oder Bankverbindung.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-5">
        {pending.issues.length > 0 && <div role="alert" className="space-y-2 rounded-lg border border-amber-500/30 p-3 text-sm">
          {pending.issues.map((issue, index) => <p key={index}>{issue}</p>)}
        </div>}
        {drafts.map((draft, index) => <section key={index} className="space-y-4 rounded-lg border p-4" aria-label={`Abrechnung ${index + 1}`}>
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">Abrechnung {index + 1}</h3>
            <Button variant="ghost" size="sm" onClick={() => { setDrafts(drafts.filter((_, item) => item !== index)); setChecked(false); }}>Weglassen</Button>
          </div>
          <label className="block space-y-1 text-xs">Arbeitgeber
            <Input maxLength={120} disabled={pending.editing} value={draft.employer ?? ""} onChange={(event) => change(index, { ...draft, employer: event.target.value })} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">Jahr
              <select className="select-input w-full" disabled={pending.editing} value={draft.year ?? ""} onChange={(event) => change(index, {
                ...draft, year: event.target.value === "2026" ? 2026 : event.target.value === "2027" ? 2027 : undefined,
              })}>
                <option value="">Jahr wählen</option><option value="2026">2026</option><option value="2027">2027</option>
              </select>
            </label>
            <label className="space-y-1 text-xs">Abrechnungsmonat
              <select className="select-input w-full" disabled={pending.editing} value={draft.month ?? ""} onChange={(event) => change(index, { ...draft, month: Number(event.target.value) || undefined })}>
                <option value="">Monat wählen</option>
                {Array.from({ length: 12 }, (_, month) => <option key={month} value={month + 1}>{monthLabel(`2026-${String(month + 1).padStart(2, "0")}`).replace(" 2026", "")}</option>)}
              </select>
            </label>
            {moneyFields.map(([key, label]) => <label key={key} className="space-y-1 text-xs">{label} (€)
              <Input type="number" min="0" max="1000000000" step="0.01" value={draft[key] ?? ""}
                onChange={(event) => change(index, { ...draft, [key]: event.target.value === "" ? undefined : Number(event.target.value) })} />
            </label>)}
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer">Kumulierte Werte / tatsächlicher Sechstelverbrauch (optional)</summary>
            <p className="my-3 text-muted-foreground">Nur ausdrücklich ausgewiesene Werte der Lohnverrechnung. Nicht aus Netto, steuerpflichtigem Brutto oder einem einzelnen Folgemonat ableiten. Leere Felder bedeuten unbekannt, nicht 0.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {cumulativeFields.map(([key, label]) => <label key={key} className="space-y-1">{label} (€)
                <Input type="number" min="0" max="1000000000" step="0.01" value={draft[key] ?? ""}
                  onChange={(event) => change(index, { ...draft, [key]: event.target.value === "" ? undefined : Number(event.target.value) })} />
              </label>)}
            </div>
          </details>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 accent-primary" checked={draft.monthlyPayroll ?? false}
              onChange={(event) => change(index, { ...draft, monthlyPayroll: event.target.checked })} />
            Reguläre volle Monatsabrechnung, keine ungeklärte Aufrollung oder Vorbezüge.
          </label>
          {!parsed[index].success && <p className="text-xs text-muted-foreground" role="status">Arbeitgeber, Monat, Jahr, laufendes Brutto, Sonderzahlungen (ggf. 0) und Abrechnungsart sind erforderlich. Geldbeträge benötigen höchstens zwei Nachkommastellen.</p>}
        </section>)}
        <p className="text-xs leading-relaxed text-muted-foreground">Zum Sechstel gehören auch laufende Zuschläge nach § 68. Steuerfreie Auslagenersätze wie die Telearbeitspauschale gehören nicht dazu. Bei Sonderzahlungen nur § 67 Abs. 1/2, nicht Abfertigungen oder andere Sonderfälle erfassen. Die LSt-Bemessungsgrundlage ist ein anderer Wert als das Brutto-Sechstel; für das Steuermodell ist sie vor dem monatlichen Werbungskostenpauschale von 11 € anzugeben.</p>
        {hasExisting && <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 accent-primary" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
          Abweichende gespeicherte Abrechnungen desselben Arbeitgebers und Monats ersetzen. Identische Importe werden nicht doppelt gezählt.
        </label>}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 accent-primary" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          Erkannte Werte und Arbeitgeberzuordnung geprüft. Fehlende Beträge habe ich ergänzt; andere Dienstverhältnisse sind nicht enthalten.
        </label>
        {(error || storageError) && <p role="alert" className="text-sm text-destructive">{error || storageError}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Abbrechen</Button>
        <Button disabled={!valid || !checked || !!storageError} onClick={save}>Abrechnung übernehmen</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function PayslipImportPanel({ year, employer, onImported }: {
  year: Payslip["year"];
  employer: string;
  onImported: (entry: Payslip) => void;
}) {
  const { state, update, storageError } = useFinance();
  const [password, setPassword] = useState("");
  const [filesToRetry, setFilesToRetry] = useState<File[]>([]);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [deleting, setDeleting] = useState<Payslip | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
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
    setFilesToRetry([]);
    const current = ++request.current;
    try {
      const combined: PayslipImport = { drafts: [], issues: [] };
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error("Eine Lohnabrechnung darf höchstens 20 MB groß sein.");
        const parsed = await parsePayslipPdf(await file.arrayBuffer(), password || undefined);
        if (current !== request.current) return;
        combined.drafts.push(...parsed.drafts);
        combined.issues.push(...parsed.issues);
        if (combined.drafts.length > 240) throw new Error("Ein Import darf höchstens 240 Lohnabrechnungen enthalten.");
      }
      if (!combined.drafts.length) throw new Error("Keine auswertbare Lohnabrechnung erkannt. Bitte eine PDF mit lesbarem Text verwenden oder die Werte manuell ergänzen.");
      setPending(combined);
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
  const records = (state.payslips ?? []).filter((entry) => entry.year === year &&
    (!employer || payrollEmployerKey(entry.employer) === payrollEmployerKey(employer))).sort((a, b) => b.month - a.month);
  return <>
    <section className="panel mb-6 p-5 sm:p-6" aria-label="Lohnabrechnungen importieren">
      <SectionHeading title="Lohnabrechnungen" subtitle="PDF hier hineinziehen – Entschlüsselung und Analyse bleiben vollständig in deinem Browser." />
      <div className="grid gap-4 sm:grid-cols-[1fr_16rem]">
        <div role="group" aria-label="PDF-Ablage für Lohnabrechnungen" className={cn("rounded-xl border border-dashed p-5 text-center", dragging && "border-primary bg-primary/5")}
          onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void readFiles(Array.from(event.dataTransfer.files)); }}>
          <FileUp className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="mb-3 text-sm">Eine oder mehrere Lohnabrechnungen als PDF</p>
          <input ref={fileInput} type="file" accept=".pdf,application/pdf" multiple className="sr-only"
            aria-label="Lohnabrechnungen als PDF auswählen" disabled={busy || !!storageError}
            onChange={(event) => { void readFiles(Array.from(event.target.files ?? [])); }} />
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
          <p className="text-xs leading-relaxed text-muted-foreground">Ein Passwort gilt für alle PDFs dieses Imports. Es bleibt nur bis zum Verlassen dieser Seite im Arbeitsspeicher und wird nie gespeichert.</p>
          {filesToRetry.length > 0 && <Button variant="outline" disabled={busy || !password || !!storageError} onClick={() => { void readFiles(filesToRetry); }}>Mit Passwort erneut lesen</Button>}
          <Button variant="ghost" size="sm" disabled={busy || !!storageError} onClick={() => setPending({
            drafts: [{ year, employer, monthlyPayroll: false }], issues: [],
          })}>Abrechnung manuell ergänzen</Button>
        </div>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Eine einzelne Abrechnung belegt nur ihren Abrechnungsmonat. Für den tatsächlichen aktuellen Stand alle Monate seit Jänner oder verlässliche kumulierte Werte importieren. Es werden keine Kontoumsätze erzeugt oder verändert.</p>
      {records.length > 0 && <div className="mt-5 overflow-x-auto">
        <table className="w-full text-left text-sm" aria-label="Gespeicherte Lohnabrechnungen">
          <thead><tr className="border-b text-xs text-muted-foreground"><th className="p-2">Abrechnung</th><th className="p-2 text-right">Laufendes Brutto</th><th className="p-2 text-right">Sonderzahlung</th><th><span className="sr-only">Aktionen</span></th></tr></thead>
          <tbody>{records.map((record) => <tr key={payslipKey(record)} className="border-b last:border-0">
            <td className="p-2">{monthLabel(`${record.year}-${String(record.month).padStart(2, "0")}`)}<span className="block text-xs text-muted-foreground">{record.employer}</span></td>
            <td className="p-2 text-right whitespace-nowrap tabular-nums">{currency(record.regularGross)}</td>
            <td className="p-2 text-right whitespace-nowrap tabular-nums">{currency(record.specialGross)}</td>
            <td className="p-2"><div className="flex justify-end">
              <Button variant="ghost" size="icon" className="size-7" aria-label={`Abrechnung bearbeiten: ${record.month}/${record.year}`}
                disabled={busy || !!storageError} onClick={() => setPending({ drafts: [{ ...record }], issues: [], editing: true })}><Pencil className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" className="size-7" aria-label={`Abrechnung entfernen: ${record.month}/${record.year}`}
                disabled={busy || !!storageError} onClick={() => setDeleting(record)}><Trash2 className="size-3.5" /></Button>
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
    {pending && <PayslipReview pending={pending} onClose={() => setPending(null)} onSaved={onImported} />}
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
