"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { FileLock2, FileUp, LoaderCircle, LockKeyhole } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Field, PremiumDialog, PremiumDialogBody, PremiumDialogClose, PremiumDialogContent, PremiumDialogFooter, PremiumDialogHeader,
  PremiumDialogItem, ToggleRow,
} from "@/components/ui/premium-dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { isPayslipMutationRejection, usePayslipMutation } from "@/components/payslip-mutation";
import { useImportInbox } from "@/components/use-import-inbox";
import { usePayslipPasswordStore, type PayslipPasswordStore } from "@/components/payslip-password";
import { usePayslipLogStore } from "@/components/payslip-log";
import { payslipLogEntry, type PayslipLogSource } from "@/lib/payslip-log";
import { parsePayslipPdf, PayslipPasswordError } from "@/lib/import/payslip";
import { payslipKey, payslipSchema, payrollEmployerKey, type Payslip, type PayslipDraft, type PayslipImport } from "@/lib/payslip-schema";
import { assertPayslipReview, capturePayslipReview, PayslipMutationError, preparePayslipMerge, type PayslipReview } from "@/lib/payslip-storage";
import { applyPayslipIncome } from "@/lib/payslip-income";
import { FinanceStorageError } from "@/lib/finance-storage";
import { currency, monthLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const MAX_FILES = 24;
const MAX_BYTES = 20 * 1024 * 1024;

export function payslipDraftLabel(draft: PayslipDraft, index: number) {
  return draft.year && draft.month
    ? monthLabel(`${draft.year}-${String(draft.month).padStart(2, "0")}`) : `Abrechnung ${index + 1}`;
}

export function payslipIncomeMessage(result: ReturnType<typeof applyPayslipIncome> | undefined) {
  if (!result) return "";
  const parts = result.applied.map((income) => `Abrechnung ${monthLabel(income.payrollMonth)} → ${monthLabel(income.month)}: Netto ${currency(income.net)}` +
    (income.special > 0 ? ` (davon Sonderzahlung ${currency(income.special)})` : ""));
  const done = parts.length ? `Ins Budget eingetragen – ${parts.join(", ")}.` : "";
  const skipped = result.skipped.length
    ? `Netto nicht eindeutig für Abrechnung ${result.skipped.map((month) => monthLabel(month)).join(", ")} – im Folgemonat bitte manuell eintragen.` : "";
  const reference = result.reference.length
    ? `${result.reference.length === 1 ? "1 Abrechnung" : `${result.reference.length} Abrechnungen`} aus 2025 als Referenz gespeichert – nicht im Budget.` : "";
  return [done, skipped, reference].filter(Boolean).join(" ");
}

type LockedFile = { file: File; index: number; wrong: boolean };
type PasswordPrompt = { files: File[]; results: (PayslipImport | null)[]; locked: LockedFile[]; storedFailed: boolean; source?: string };

export type PayslipFileOutcome = { outcome: "imported" | "skipped" | "failed"; note?: string };
/** One entry per file of a read; `busy` means nothing was read because another import is still open. */
export type PayslipBatchResult = { files: PayslipFileOutcome[]; busy?: boolean; message: string };
export type PayslipReadOptions = {
  onSettled?: (result: PayslipBatchResult) => void;
  /** Shown in the password dialog and the result message, e.g. "Google Drive". */
  source?: string;
  /** Automatic reads wait instead of replacing an open password or replacement dialog. */
  background?: boolean;
  /** Origin in the import log; Drive reads default to "drive", everything else to "upload". */
  log?: PayslipLogSource;
};
type Batch = {
  size: number; names: string[]; skipped: Set<number>; unrecognized: Set<number>; source?: string; log: PayslipLogSource;
  report?: PayslipImport; stored?: number; onSettled?: (result: PayslipBatchResult) => void;
};

type PayslipUploadValue = {
  busy: boolean;
  disabled: boolean;
  error: string;
  notice: string;
  report: PayslipImport | null;
  openPicker: () => void;
  readFiles: (files: File[], options?: PayslipReadOptions) => void;
  setMessage: (message: { error?: string; notice?: string }) => void;
  subscribe: (listener: (entry: Payslip) => void) => () => void;
};

const PayslipUploadContext = createContext<PayslipUploadValue | null>(null);

export function usePayslipUpload(): PayslipUploadValue {
  const value = useContext(PayslipUploadContext);
  if (!value) throw new Error("usePayslipUpload braucht einen PayslipUploadProvider.");
  return value;
}

/** Calls the listener with the newest imported payslip, e.g. to show its month. */
export function usePayslipImported(listener: (entry: Payslip) => void) {
  const { subscribe } = usePayslipUpload();
  const latest = useRef(listener);
  useEffect(() => { latest.current = listener; });
  useEffect(() => subscribe((entry) => latest.current(entry)), [subscribe]);
}

/** Uses the app-wide upload provider and creates a local one where none exists (isolated rendering, tests). */
export function EnsurePayslipUpload({ children }: { children: ReactNode }) {
  return useContext(PayslipUploadContext) ? <>{children}</> : <PayslipUploadProvider>{children}</PayslipUploadProvider>;
}

/** Reads payslip PDFs from the upload button, the central import and Google Drive; asks for passwords only when a file needs one. */
export function PayslipUploadProvider({ onImported, children }: { onImported?: (entry: Payslip) => void; children: ReactNode }) {
  const { state, update, storageError, ready } = useFinance();
  const passwordStore = usePayslipPasswordStore();
  const logStore = usePayslipLogStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [report, setReport] = useState<PayslipImport | null>(null);
  const [prompt, setPrompt] = useState<PasswordPrompt | null>(null);
  const [replacement, setReplacement] = useState<{ entries: Payslip[]; review: PayslipReview } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const request = useRef(0);
  const live = useRef({ state, update, storageError, onImported, logStore });
  const batch = useRef<Batch | null>(null);
  const [listeners] = useState(() => new Set<(entry: Payslip) => void>());
  const subscribe = useCallback((listener: (entry: Payslip) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [listeners]);
  const mutate = usePayslipMutation(state, update);
  useEffect(() => { live.current = { state, update, storageError, onImported, logStore }; }, [state, update, storageError, onImported, logStore]);
  useEffect(() => () => { request.current++; }, []);
  useImportInbox("payslip", ready !== false && !storageError, (files) => { void readFiles(files, { log: "import" }); });

  function settle(outcome: "imported" | "skipped" | "failed", message: string) {
    const current = batch.current;
    batch.current = null;
    if (!current) return;
    const files = Array.from({ length: current.size }, (_, index): PayslipFileOutcome =>
      current.skipped.has(index) ? { outcome: "skipped", note: "Passwort fehlt." }
        : current.unrecognized.has(index) && outcome !== "failed" ? { outcome: "skipped", note: "Keine Lohnabrechnung erkannt." }
          : outcome === "imported" ? { outcome } : { outcome, note: message });
    const entry = payslipLogEntry({
      source: current.log, message, report: current.report, stored: current.stored,
      files: files.map((file, index) => ({ name: current.names[index] ?? `Datei ${index + 1}`, ...file })),
    });
    live.current.logStore.append(entry).catch(() => undefined);
    current.onSettled?.({ message, files });
  }

  function storeEntries(entries: Payslip[], allowReplace: boolean, review?: PayslipReview, extra = "") {
    const currentFinance = live.current;
    if (currentFinance.storageError)
      throw new FinanceStorageError(currentFinance.storageError);
    const merged = preparePayslipMerge(currentFinance.state.payslips ?? [], entries);
    if (merged.conflicts.length && !allowReplace)
      throw new PayslipMutationError("Ersetzen abweichender Abrechnungen bestätigen.");
    const expected = review ?? capturePayslipReview(currentFinance.state.payslips ?? [], entries);
    assertPayslipReview(currentFinance.state.payslips ?? [], expected);
    let synced: ReturnType<typeof applyPayslipIncome> | undefined;
    mutate((current) => {
      assertPayslipReview(current.payslips ?? [], expected);
      const next = preparePayslipMerge(current.payslips ?? [], entries);
      if (next.conflicts.length && !allowReplace)
        throw new PayslipMutationError("Abrechnungen inzwischen geändert. PDFs erneut hochladen.");
      const income = applyPayslipIncome(current, entries);
      synced = income;
      if (!next.changed.length) return income.state;
      return {
        ...income.state,
        payslips: next.entries,
        payrollForecasts: current.payrollForecasts?.map((forecast) =>
          next.changed.some((entry) => entry.year === forecast.year &&
            payrollEmployerKey(entry.employer) === payrollEmployerKey(forecast.employer))
            ? { ...forecast, standardPayrollConfirmed: false }
            : forecast),
      };
    }, () => {
      if (batch.current) batch.current.stored = merged.changed.length;
      const newest = entries.slice().sort((a, b) => b.year - a.year || b.month - a.month)[0];
      currentFinance.onImported?.(newest);
      for (const listener of listeners) listener(newest);
      const stored = merged.changed.length
        ? `${merged.changed.length} Abrechnung(en) automatisch übernommen.`
        : "Abrechnungen bereits vorhanden – nicht doppelt übernommen.";
      const source = batch.current?.source;
      const message = [source ? `${source}:` : "", stored, payslipIncomeMessage(synced), extra].filter(Boolean).join(" ");
      setNotice(message);
      toast.success(message);
      setReplacement(null);
      setError("");
      settle("imported", message);
    }, (cause) => { setError(cause.message); settle("failed", cause.message); });
  }

  function finish(files: File[], results: (PayslipImport | null)[], skipped = 0) {
    const combined: PayslipImport = { drafts: [], issues: [] };
    results.forEach((parsed, fileIndex) => {
      if (!parsed) return;
      if (!parsed.drafts.length) batch.current?.unrecognized.add(fileIndex);
      combined.drafts.push(...parsed.drafts);
      combined.issues.push(...[...new Set(parsed.issues)].map((issue) => `Datei ${fileIndex + 1}: ${issue}`));
    });
    if (combined.drafts.length > 240) throw new Error("Max. 240 Lohnabrechnungen je Import.");
    const skippedNote = skipped ? `${skipped} von ${files.length} Datei(en) ohne Passwort übersprungen.` : "";
    if (!combined.drafts.length) {
      if (skipped === files.length) { setNotice("Import abgebrochen – keine Datei geöffnet."); settle("skipped", "Passwort fehlt."); return; }
      throw new Error("Keine Lohnabrechnung erkannt. Vollständige Original-PDF mit lesbarem Text nötig.");
    }
    setReport(combined);
    if (batch.current) batch.current.report = combined;
    const entries = combined.drafts.flatMap((draft) => {
      const parsed = payslipSchema.safeParse(draft);
      return parsed.success ? [parsed.data] : [];
    });
    if (!entries.length) {
      setError(["Keine Abrechnung übernommen; siehe Importhinweise.", skippedNote].filter(Boolean).join(" "));
      settle("failed", "Nicht vollständig erkannt.");
      return;
    }
    try {
      const merged = preparePayslipMerge(live.current.state.payslips ?? [], entries);
      if (merged.conflicts.length) {
        setReplacement({ entries, review: capturePayslipReview(live.current.state.payslips ?? [], entries) });
        setNotice("Abweichende Abrechnungen: Ersetzen bestätigen.");
      } else storeEntries(entries, false, undefined, skippedNote);
    } catch (cause) {
      if (!isPayslipMutationRejection(cause)) throw cause;
      setError(cause.message);
      settle("failed", cause.message);
    }
  }

  async function run(task: (current: number) => Promise<void>) {
    if (inFlight.current) return;
    if (live.current.storageError) { setError(live.current.storageError); settle("failed", live.current.storageError); return; }
    inFlight.current = true;
    setBusy(true);
    const current = ++request.current;
    try {
      await task(current);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Die PDF konnte nicht gelesen werden.";
      if (current === request.current) setError(message);
      settle("failed", message);
    } finally {
      inFlight.current = false;
      if (current === request.current) setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function readFiles(files: File[], options: PayslipReadOptions = {}) {
    if (inFlight.current || (options.background && batch.current)) {
      options.onSettled?.({ files: [], busy: true, message: "Ein Import läuft bereits." });
      return;
    }
    const replaced = batch.current;
    batch.current = {
      size: files.length, names: files.map((file) => file.name), skipped: new Set(), unrecognized: new Set(), source: options.source,
      log: options.log ?? (options.source ? "drive" : "upload"), onSettled: options.onSettled,
    };
    replaced?.onSettled?.({ files: [], busy: true, message: "Durch einen neuen Import ersetzt." });
    if (!files.length || files.length > MAX_FILES || files.some((file) => !/\.pdf$/i.test(file.name))) {
      const message = `Bitte 1 bis ${MAX_FILES} PDF-Lohnabrechnungen auswählen.`;
      setError(message);
      settle("failed", message);
      return;
    }
    setError("");
    setNotice("");
    setReport(null);
    setReplacement(null);
    setPrompt(null);
    await run(async (current) => {
      if (files.some((file) => file.size > MAX_BYTES)) throw new Error("Max. 20 MB je PDF.");
      const results: (PayslipImport | null)[] = files.map(() => null);
      const locked: LockedFile[] = [];
      for (const [index, file] of files.entries()) {
        try {
          results[index] = await parsePayslipPdf(await file.arrayBuffer());
        } catch (cause) {
          if (!(cause instanceof PayslipPasswordError)) throw cause;
          locked.push({ file, index, wrong: false });
        }
        if (current !== request.current) return;
      }
      let storedFailed = false;
      if (locked.length) {
        const stored = passwordStore.available ? await passwordStore.reveal().catch(() => null) : null;
        if (current !== request.current) return;
        if (stored) {
          for (const entry of [...locked]) {
            try {
              results[entry.index] = await parsePayslipPdf(await entry.file.arrayBuffer(), stored);
              locked.splice(locked.indexOf(entry), 1);
            } catch (cause) {
              if (!(cause instanceof PayslipPasswordError)) throw cause;
              storedFailed = true;
            }
            if (current !== request.current) return;
          }
        }
      }
      if (locked.length) setPrompt({ files, results, locked, storedFailed, ...(options.source ? { source: options.source } : {}) });
      else finish(files, results);
    });
  }

  async function unlock(passwords: Map<number, string>, remember?: string) {
    const pending = prompt;
    if (!pending) return;
    await run(async (current) => {
      const results = [...pending.results];
      const stillLocked: LockedFile[] = [];
      for (const entry of pending.locked) {
        try {
          results[entry.index] = await parsePayslipPdf(await entry.file.arrayBuffer(), passwords.get(entry.index));
        } catch (cause) {
          if (!(cause instanceof PayslipPasswordError)) throw cause;
          stillLocked.push({ ...entry, wrong: true });
        }
        if (current !== request.current) return;
      }
      if (stillLocked.length) { setPrompt({ ...pending, results, locked: stillLocked }); return; }
      setPrompt(null);
      if (remember) {
        await passwordStore.save(remember).then(
          () => toast.success("PDF-Passwort gespeichert – künftig wird es automatisch verwendet."),
          (cause: unknown) => setError(cause instanceof Error ? cause.message : "Passwort konnte nicht gespeichert werden."),
        );
      }
      finish(pending.files, results);
    });
  }

  function skipLocked() {
    const pending = prompt;
    setPrompt(null);
    if (!pending) return;
    for (const entry of pending.locked) batch.current?.skipped.add(entry.index);
    try {
      finish(pending.files, pending.results, pending.locked.length);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Die PDF konnte nicht gelesen werden.";
      setError(message);
      settle("failed", message);
    }
  }

  function cancelReplacement() {
    setReplacement(null);
    setNotice("Ersetzen abgebrochen. Gespeicherte Abrechnungen unverändert.");
    setError("");
    settle("skipped", "Ersetzen abgebrochen.");
  }

  const value: PayslipUploadValue = {
    busy,
    disabled: busy || !!storageError,
    error,
    notice,
    report,
    openPicker: () => fileInput.current?.click(),
    readFiles: (files, options) => { void readFiles(files, options); },
    setMessage: (message) => {
      if (message.error !== undefined) setError(message.error);
      if (message.notice !== undefined) setNotice(message.notice);
    },
    subscribe,
  };

  return (
    <PayslipUploadContext value={value}>
      {children}
      <input ref={fileInput} type="file" accept=".pdf,application/pdf" multiple className="sr-only" tabIndex={-1}
        aria-label="Lohnabrechnungen als PDF auswählen" disabled={busy || !!storageError}
        onChange={(event) => { if (event.target.files?.length) void readFiles(Array.from(event.target.files)); }} />
      <PayslipPasswordDialog prompt={prompt} busy={busy} store={passwordStore}
        onUnlock={(passwords, remember) => { void unlock(passwords, remember); }} onSkip={skipLocked} />
      <Dialog open={!!replacement} onOpenChange={(open) => { if (!open) cancelReplacement(); }}>
        <DialogContent variant="confirmation">
          <DialogHeader>
            <DialogTitle>Gespeicherte Abrechnungen ersetzen?</DialogTitle>
            <DialogDescription>Abweichende Werte für gespeicherte Monate. Überschreiben nur nach Bestätigung.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {replacement?.entries.map((entry) => <p key={payslipKey(entry)} className="mb-2 text-sm">
              {payslipDraftLabel(entry, 0)} · {entry.employer}: laufend {currency(entry.regularGross)}, Sonderzahlungen {currency(entry.specialGross)}
              {!!entry.unresolvedSixthBonus && <>; weitere Prämie {currency(entry.unresolvedSixthBonus)} mit offener Sechstelzuordnung</>}
            </p>)}
            {(error || storageError) && <p role="alert" className="text-sm text-destructive">{storageError || error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={cancelReplacement}>Abbrechen</Button>
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
    </PayslipUploadContext>
  );
}

/** The page's primary action: opens the file picker; everything else happens automatically. */
export function PayslipUploadButton({ className }: { className?: string }) {
  const { openPicker, busy, disabled } = usePayslipUpload();
  return (
    <Button className={cn("min-h-10", className)} disabled={disabled} aria-busy={busy || undefined} onClick={openPicker}>
      {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <FileUp aria-hidden="true" className="size-4" />}
      Abrechnungen hochladen
    </Button>
  );
}

type UnlockHandler = (passwords: Map<number, string>, remember?: string) => void;

function PayslipPasswordDialog({ prompt, busy, store, onUnlock, onSkip }: {
  prompt: PasswordPrompt | null;
  busy: boolean;
  store: PayslipPasswordStore;
  onUnlock: UnlockHandler;
  onSkip: () => void;
}) {
  return (
    <PremiumDialog open={!!prompt} onOpenChange={(open) => { if (!open && !busy) onSkip(); }}>
      {prompt && <PasswordForm key={prompt.files.length} prompt={prompt} busy={busy} store={store} onUnlock={onUnlock} />}
    </PremiumDialog>
  );
}

function PasswordForm({ prompt, busy, store, onUnlock }: { prompt: PasswordPrompt; busy: boolean; store: PayslipPasswordStore; onUnlock: UnlockHandler }) {
  const [shared, setShared] = useState("");
  const [remember, setRemember] = useState(false);
  const [together, setTogether] = useState(true);
  const [single, setSingle] = useState<Record<number, string>>({});
  const [checked, setChecked] = useState(true);
  const many = prompt.locked.length > 1;
  const sharing = !many || together;
  const anyWrong = checked && prompt.locked.some((entry) => entry.wrong);
  const ready = sharing ? shared.length > 0 : prompt.locked.every((entry) => (single[entry.index] ?? "").length > 0);
  const title = many ? `${prompt.locked.length} geschützte Abrechnungen` : "Geschützte Abrechnung";
  return (
    <PremiumDialogContent size="sm" financial={false}>
      <PremiumDialogHeader icon={LockKeyhole} title={title}
        description={[prompt.source ? `Neu aus ${prompt.source}.` : "",
          prompt.storedFailed ? `Das gespeicherte PDF-Passwort passt nicht zu ${many ? "diesen Dateien" : "dieser Datei"}.` : `Gib das PDF-Passwort ein, um ${many ? "die Dateien" : "die Datei"} zu öffnen.`].filter(Boolean).join(" ")} />
      <form className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        setChecked(true);
        onUnlock(new Map(prompt.locked.map((entry) => [entry.index, sharing ? shared : single[entry.index] ?? ""])),
          sharing && remember && store.available ? shared : undefined);
      }}>
        <PremiumDialogBody className="space-y-5">
          <PremiumDialogItem>
            <ul aria-label="Geschützte Dateien" className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70">
              {prompt.locked.map((entry) => (
                <li key={entry.index} className="flex min-h-12 items-center gap-3 px-4 py-2.5">
                  <FileLock2 aria-hidden="true" className={cn("size-4 shrink-0", entry.wrong ? "text-destructive" : "text-muted-foreground")} />
                  <span className="min-w-0 flex-1 truncate text-sm" title={entry.file.name}>{entry.file.name}</span>
                  <Badge variant={entry.wrong ? "destructive" : "secondary"}>{entry.wrong ? "Passwort falsch" : "geschützt"}</Badge>
                </li>
              ))}
            </ul>
          </PremiumDialogItem>
          {many && (
            <PremiumDialogItem>
              <ToggleRow checked={together} onCheckedChange={(next) => { setTogether(next); setChecked(false); }} disabled={busy}
                label="Passwort für alle Dateien verwenden?" description={together ? `Ein Passwort für alle ${prompt.locked.length} Dateien.` : "Jede Datei bekommt ihr eigenes Passwort."} />
            </PremiumDialogItem>
          )}
          {sharing ? (
            <>
              <Field label="PDF-Passwort" error={anyWrong ? "Passwort falsch – bitte erneut eingeben." : null}>
                <PasswordInput autoFocus value={shared} maxLength={200} disabled={busy} onChange={(event) => setShared(event.target.value)} />
              </Field>
              {store.available && (
                <PremiumDialogItem>
                  <ToggleRow checked={remember} onCheckedChange={setRemember} disabled={busy} label="Passwort sicher speichern"
                    description={store.scope === "account" ? "Verschlüsselt auf deinem Server, künftig automatisch verwendet." : "Verschlüsselt in diesem Browser, künftig automatisch verwendet."} />
                </PremiumDialogItem>
              )}
            </>
          ) : (
            prompt.locked.map((entry, position) => (
              <Field key={entry.index} label={<span className="min-w-0 truncate">Passwort für {entry.file.name}</span>}
                error={checked && entry.wrong ? "Passwort falsch." : null}>
                <PasswordInput autoFocus={position === 0} value={single[entry.index] ?? ""} maxLength={200} disabled={busy}
                  onChange={(event) => setSingle((current) => ({ ...current, [entry.index]: event.target.value }))} />
              </Field>
            ))
          )}
        </PremiumDialogBody>
        <PremiumDialogFooter>
          <PremiumDialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>Überspringen</Button>
          </PremiumDialogClose>
          <Button type="submit" disabled={!ready || busy}>
            {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <LockKeyhole aria-hidden="true" className="size-4" />}
            Öffnen
          </Button>
        </PremiumDialogFooter>
      </form>
    </PremiumDialogContent>
  );
}
