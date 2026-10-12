"use client";

import { merchantAliasAssignment } from "@/lib/merchant-identity";

import { memo, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { FileUp, LoaderCircle, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFinance } from "@/components/finance-provider";
import { classify } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import {
  categories,
  transactionSchema,
  type Transaction,
} from "@/lib/types";
import {
  parseStatementFile,
  parseStatementAmount,
  type StatementDraft,
  type StatementResult,
} from "@/lib/import/statements";
import {
  prepareStatementImport,
  type FixedDecision,
  type ImportMetadata,
  type ReviewItem,
} from "@/lib/import/review";
import { cn } from "@/lib/utils";
import { CategorySelect } from "@/components/category-select";
import { FixedCostChoice } from "@/components/fixed-cost-choice";
import { isIncomeCategory } from "@/lib/fixed";
import { accountLabel } from "@/lib/accounts";
import { isAmexScreenshot } from "@/lib/import/identity";
import { merchantAliasSourceKey } from "@/lib/import/merchant-rules";
import { screenshotReviewMessage } from "@/lib/import/amex-screenshot";
import { bookingDescription } from "@/lib/import/merchant-description";
import { useAccountWorkspace } from "@/components/account-context";
import { useAutomation } from "@/components/automation-context";
import { useUploadActivity, type UploadActivity } from "@/components/upload-activity";
import { UploadStatus } from "@/components/upload-status";
import { MAX_UPLOAD_BYTES, statementUploadResponseSchema } from "@/lib/automation/schema";

type Pending = {
  requestId: string;
  removeId?: string;
  rows: Transaction[];
  decisions: FixedDecision[];
  uploadIds?: string[];
};
type ImportUI = {
  review: ReviewItem[];
  open: boolean;
  busy: boolean;
  dragging: boolean;
  pending: Pending | null;
  ledgerOnly: boolean;
  drafts: Record<string, StatementDraft>;
};

const BookingReview = memo(function BookingReview({
  item,
  draft,
  changeDraft,
  disabled,
  save,
  skip,
}: {
  item: Extract<ReviewItem, { kind: "booking" }>;
  draft: StatementDraft;
  changeDraft: (id: string, draft: StatementDraft) => void;
  disabled: boolean;
  save: (row: Transaction, id: string) => void;
  skip: () => void;
}) {
  const repairOcr = isAmexScreenshot(item.draft) && item.message.startsWith("Amex-Screenshot:");
  const feedbackId = useId();
  const [editingName, setEditingName] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameMissing = editingName && draft.merchantAlias !== undefined && !draft.merchantAlias.trim();
  const fixedCost = draft.fixedCost === true;
  const choices = categories.filter((category) => category !== "Prüfen");
  const classification = classify({
    ...draft, amount: draft.amount ?? 0, categoryOverride: true, manualCategory: true, includeInPlan: true, fixedCost: false,
  });
  const canRememberName = merchantAliasSourceKey(item.draft) !== undefined;
  const canMarkFixed = draft.amount !== null && draft.amount < 0 &&
    !classification.isTransfer && !isIncomeCategory(classification.category);
  const candidate = {
    ...draft,
    categoryOverride: true,
    manualCategory: true,
    reviewed: draft.category !== "Prüfen",
    includeInPlan: true,
    fixedCost: canMarkFixed && fixedCost,
  };
  const parsed = transactionSchema.safeParse(candidate);
  return (
    <section
      className="panel space-y-3 p-4"
      aria-label={`Buchung prüfen: ${bookingDescription(item.draft)}`}
    >
      <p id={feedbackId} className="text-xs text-muted-foreground break-words">
        {repairOcr ? screenshotReviewMessage(draft) : item.message}
        {repairOcr && item.draft.amount === null && " Ausgaben −, Gutschriften +."}
      </p>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_8rem]">
        <label className="space-y-1 text-xs">
          Datum
          <Input aria-label="Datum" type="date" value={draft.date} readOnly={!repairOcr}
            aria-invalid={repairOcr && !transactionSchema.shape.date.safeParse(draft.date).success}
            aria-describedby={repairOcr ? feedbackId : undefined}
            onChange={repairOcr ? (event) => changeDraft(item.id, { ...draft, date: event.target.value }) : undefined} />
        </label>
        <div className="space-y-1 text-xs">
          <p>Text</p>
          <div className="relative">
            <Input
              ref={nameInput}
              aria-label="Text"
              maxLength={repairOcr ? 1000 : 200}
              value={repairOcr ? draft.description : editingName ? draft.merchantAlias ?? bookingDescription(draft) : bookingDescription(draft)}
              readOnly={!repairOcr && !editingName}
              disabled={disabled}
              className={!repairOcr ? "pr-10" : undefined}
              aria-invalid={nameMissing}
              onChange={(event) => changeDraft(item.id, { ...draft,
                ...(repairOcr ? { description: event.target.value } : merchantAliasAssignment(draft, event.target.value)) })}
            />
            {!repairOcr && (
              <Button type="button" variant="ghost" size="icon-xs" className="absolute right-2 top-2"
                aria-label="Händlername bearbeiten" title="Händlername bearbeiten" disabled={disabled}
                onClick={() => {
                  setEditingName(true);
                  nameInput.current?.focus();
                  nameInput.current?.select();
                }}>
                <Pencil className="size-3" aria-hidden="true" />
              </Button>
            )}
          </div>
          {editingName && <p className="text-muted-foreground">
            {nameMissing ? "Bitte einen Händlernamen eingeben." : canRememberName
              ? "Ändert den Namen aller passenden bisherigen und künftigen Buchungen."
              : "Unklarer Händlertext: Name gilt nur für diese Buchung."}
          </p>}
        </div>
        <label className="space-y-1 text-xs">
          Betrag (€)
          <Input
            aria-label="Betrag"
            {...(repairOcr ? {
              defaultValue: draft.amount === null ? "" : String(draft.amount).replace(".", ","),
              inputMode: "decimal" as const,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => changeDraft(item.id, { ...draft, amount: parseStatementAmount(event.target.value) }),
            } : { value: draft.amount === null ? "" : currency(draft.amount), readOnly: true })}
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          Konto/Pocket
          <Input
            aria-label="Konto/Pocket"
            value={accountLabel(draft)}
            readOnly
          />
        </label>
      </div>
      <div className="space-y-2">
          <p className="text-sm font-medium">Kategorie</p>
          <CategorySelect
            label="Kategorie"
            value={draft.category}
            disabled={disabled}
            onValueChange={(category) =>
              changeDraft(item.id, { ...draft, category })
            }
            excludeReview
          />
      </div>
      <FixedCostChoice
        checked={fixedCost}
        onChange={(fixedCost) => changeDraft(item.id, { ...draft, fixedCost })}
        disabled={disabled}
        eligible={canMarkFixed}
      />
      <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={skip}>
          Später prüfen
        </Button>
        <Button
          size="sm"
          disabled={
            disabled ||
            !parsed.success ||
            !choices.some((category) => category === draft.category)
          }
          onClick={() => {
            if (parsed.success)
              save({
                ...parsed.data,
                includeInPlan: classify(parsed.data).includeInPlan,
              }, item.id);
          }}
        >
          Zuordnung übernehmen
        </Button>
      </div>
    </section>
  );
});

function FixedReview({
  item,
  disabled,
  save,
}: {
  item: Extract<ReviewItem, { kind: "fixed" }>;
  disabled: boolean;
  save: (decision: FixedDecision) => void;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const bookings = item.change.bookings.map((booking) => {
    const name = names[booking.id];
    return name === undefined || name === (booking.merchantAlias ?? booking.description)
      ? transactionSchema.safeParse(booking)
      : transactionSchema.safeParse({ ...booking, ...merchantAliasAssignment(booking, name), categoryOverride: true, reviewed: true });
  });
  const invalid = bookings.some((booking) => !booking.success);
  const confirm = (accept: boolean) => {
    if (invalid) return;
    save({ accept, change: { ...item.change, bookings: bookings.flatMap((booking) => booking.success ? [booking.data] : []) } });
  };
  return (
    <section className="panel space-y-3 p-4" aria-label={`${item.change.category} prüfen`}>
      <p className="text-xs text-muted-foreground">{monthLabel(item.change.month)}</p>
      {item.change.bookings.map((booking, index) => (
        <div key={booking.id} className="rounded-lg border p-3 text-sm" aria-label={`Erkannte Buchung: ${bookingDescription(booking)}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-1">
              {names[booking.id] !== undefined ? (
                <Input
                  autoFocus
                  aria-label="Händlername"
                  maxLength={200}
                  value={names[booking.id]}
                  disabled={disabled}
                  aria-invalid={!bookings[index].success}
                  onChange={(event) => setNames((previous) => ({ ...previous, [booking.id]: event.target.value }))}
                />
              ) : (
                <>
                  <p className="min-w-0 break-words font-medium">{bookingDescription(booking)}</p>
                  <Button type="button" variant="ghost" size="icon-xs" className="shrink-0"
                    aria-label="Händlername bearbeiten" title="Händlername bearbeiten" disabled={disabled}
                    onClick={() => setNames((previous) => ({ ...previous, [booking.id]: bookingDescription(booking) }))}>
                    <Pencil className="size-3" aria-hidden="true" />
                  </Button>
                </>
              )}
            </div>
            <span className="shrink-0 font-mono">{currency(booking.amount)}</span>
          </div>
          {!bookings[index].success && <p className="mt-1 text-xs text-destructive">Bitte einen Händlernamen mit 1–200 Zeichen eingeben.</p>}
          <p className="mt-1 text-xs text-muted-foreground">{dateLabel(booking.date)} · {accountLabel(booking)}</p>
        </div>
      ))}
      <p className="text-sm">
        {item.change.category} bisher {currency(item.change.previous)}, Auszug {currency(item.change.amount)} — neuen Monatsbetrag übernehmen?
      </p>
      <p className="text-xs text-muted-foreground">Gilt ab {monthLabel(item.change.month)}.</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={disabled || invalid} onClick={() => confirm(false)}>
          Bisherigen Dauerbetrag behalten
        </Button>
        <Button variant="outline" size="sm" disabled={disabled || invalid} onClick={() => confirm(true)}>
          Neuen Dauerbetrag übernehmen
        </Button>
      </div>
    </section>
  );
}

export function StatementImport({ reviewRequest = 0 }: {
  reviewRequest?: number;
}) {
  const workspace = useAccountWorkspace();
  return <StatementImportWorkspace key={workspace?.user.id ?? "local"} reviewRequest={reviewRequest} />;
}

function StatementImportWorkspace({ reviewRequest }: { reviewRequest: number }) {
  const workspace = useAccountWorkspace();
  const automation = useAutomation();
  const { activities, add: addActivities, change: changeActivities } = useUploadActivity(automation.jobs);
  const importController = useRef<AbortController | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    importController.current?.abort();
    if (commitTimer.current !== null) clearTimeout(commitTimer.current);
  }, []);
  const { state, ready, saved, storageError, appendStatements, statementImport, openReviewCount } =
    useFinance();
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
  const importMetadata = useRef<ImportMetadata>({});
  const [localUI, setUI] = useReducer(
    (previous: ImportUI, patch: Partial<ImportUI> | ((state: ImportUI) => Partial<ImportUI>)) => ({
      ...previous,
      ...(typeof patch === "function" ? patch(previous) : patch),
    }),
    {
      review: [],
      open: false,
      busy: false,
      dragging: false,
      pending: null,
      ledgerOnly: false,
      drafts: {},
    },
  );
  const changeDraft = useCallback((id: string, draft: StatementDraft) => {
    setUI((previous) => ({ drafts: { ...previous.drafts, [id]: draft } }));
  }, []);
  const review = useMemo(() => {
    if (!localUI.ledgerOnly) return state.reviewQueue ?? [];
    const ledgerIds = new Set(state.transactions.map((row) => row.id));
    return (state.reviewQueue ?? []).filter((item) => item.kind === "booking" && ledgerIds.has(item.draft.id));
  }, [state.reviewQueue, state.transactions, localUI.ledgerOnly]);
  const ui = { ...localUI, review };
  const latestState = useRef(state);
  const lastReviewRequest = useRef(reviewRequest);
  useEffect(() => {
    if (lastReviewRequest.current === reviewRequest) return;
    lastReviewRequest.current = reviewRequest;
    if (openReviewCount) setUI({ open: true, ledgerOnly: false });
    else toast.success("Alle Umsätze sind zugeordnet");
  }, [reviewRequest, openReviewCount]);
  useEffect(() => {
    latestState.current = state;
  }, [state]);

  useEffect(() => {
    if (!ui.pending || statementImport?.requestId !== ui.pending.requestId)
      return;
    if (ui.pending.uploadIds && !statementImport.error && !saved && !storageError) return;
    pendingRef.current = false;
    const importError = statementImport.error ?? (ui.pending.uploadIds ? storageError : null);
    if (importError) {
      if (ui.pending.uploadIds) changeActivities(ui.pending.uploadIds, "failed", importError);
      toast.error(importError);
      const retry: ReviewItem[] = ui.pending.removeId
        ? []
        : ui.pending.rows.map((draft) => ({
            kind: "booking",
            id: draft.id,
            draft,
            message:
              "Automatisches Speichern fehlgeschlagen – bitte erneut speichern.",
          }));
      setUI({ pending: null, review: [...ui.review, ...retry], open: true });
    } else {
      if (ui.pending.uploadIds) changeActivities(ui.pending.uploadIds, "completed");
      const remaining = new Set(ui.review.map((item) => item.id));
      const removeId = ui.pending.removeId;
      toast.success(
        ui.pending.decisions.length
          ? "Monatsbetrag geprüft – keine doppelte Buchung"
          : `${statementImport.added} neu, ${statementImport.duplicates} Duplikate ignoriert`,
      );
      setUI((previous) => ({
        drafts: Object.fromEntries(Object.entries(previous.drafts).filter(([id]) =>
          id !== removeId && remaining.has(id),
        )),
        open: removeId
          ? ui.review.length > 0
          : localUI.open || !!statementImport.changes?.length,
        pending: null,
      }));
    }
  }, [statementImport, ui.pending, ui.review, localUI.open, saved, storageError, changeActivities]);

  const commit = useCallback((
    rows: Transaction[],
    duplicates = 0,
    removeId?: string,
    decisions: FixedDecision[] = [],
    uploadIds?: string[],
  ) => {
    if (pendingRef.current || !ready || storageError) return;
    pendingRef.current = true;
    const requestId = crypto.randomUUID();
    const metadata = importMetadata.current;
    importMetadata.current = {};
    setUI({ pending: { requestId, rows, removeId, decisions, uploadIds } });
    // Let React display the disabled controls/progress before the synchronous
    // reducer runs. The reducer still applies to the latest state, not a copy.
    commitTimer.current = setTimeout(() => appendStatements(rows, duplicates, requestId, decisions, metadata), 0);
  }, [appendStatements, ready, storageError]);
  const saveBooking = useCallback((row: Transaction, id: string) => {
    const original = latestState.current.reviewQueue?.find((item) => item.id === id);
    if (original?.kind === "booking" && (original.draft.date !== row.date ||
      original.draft.amount !== row.amount || original.draft.description !== row.description)) {
      // Corrected bank facts need full reconciliation, not category-only approval.
      importMetadata.current = { ...importMetadata.current, reviewQueue: [{ ...original, draft: row }] };
    }
    if (row.amexSource || isAmexScreenshot(row))
      importMetadata.current = { ...importMetadata.current, amexReconciliation: { rows: [row] } };
    commit([row], 0, id);
  }, [commit]);
  const skip = useCallback(() => {
    setUI({ open: false, drafts: {} });
  }, []);

  async function selectFiles(files: File[]) {
    if (
      !files.length ||
      busyRef.current ||
      pendingRef.current ||
      ui.pending ||
      !ready ||
      storageError
    )
      return;
    busyRef.current = true;
    const controller = new AbortController();
    importController.current = controller;
    setUI({ busy: true, dragging: false, ledgerOnly: false });
    const results: StatementResult[] = [];
    const uploads: UploadActivity[] = files.map((file) => ({
      id: crypto.randomUUID(), name: file.name, phase: "waiting", error: null, updatedAt: Date.now(),
    }));
    if (workspace && files.length > 5) {
      const message = "Bitte höchstens fünf Auszüge gleichzeitig auswählen.";
      addActivities([{ id: crypto.randomUUID(), name: "Dateiauswahl", phase: "failed", error: message, updatedAt: Date.now() }]);
      toast.error(message);
      busyRef.current = false;
      setUI({ busy: false });
      return;
    }
    addActivities(uploads);
    const parsedIds: string[] = [];
    try {
      if (workspace) {
        if (!saved) throw new Error("Bitte zuerst die laufende Synchronisierung abwarten.");
        for (const [index, file] of files.entries()) {
          const id = uploads[index].id;
          changeActivities([id], "uploading");
          try {
            if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new Error("Ein Kontoauszug muss Daten enthalten und darf höchstens 20 MiB groß sein.");
            const response = await fetch(`/api/statements?name=${encodeURIComponent(file.name)}`, {
              method: "POST", credentials: "same-origin", body: file,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
              headers: { "Content-Type": "application/octet-stream", "X-Upload-Size": String(file.size),
                "X-Upload-Id": id, "X-Finanzblick-Account": workspace.user.id },
            });
            let body: unknown;
            try {
              body = await response.json();
            } catch {
              throw new Error("Der Server hat eine ungültige Uploadantwort gesendet. Bitte den Hintergrundstatus prüfen.");
            }
            if (!response.ok) {
              throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
                ? body.error : "Der Auszug konnte nicht hochgeladen werden.");
            }
            const accepted = statementUploadResponseSchema.safeParse(body);
            if (!accepted.success || accepted.data.id !== id)
              throw new Error("Die Uploadbestätigung ist ungültig. Bitte den Hintergrundstatus prüfen.");
            if (controller.signal.aborted) return;
            changeActivities([id], "accepted");
            toast.success(`${file.name}: zur Hintergrundverarbeitung angenommen.`);
          } catch (error) {
            if (controller.signal.aborted) return;
            const message = error instanceof Error ? error.message : "Der Auszug konnte nicht hochgeladen werden.";
            changeActivities([id], "failed", message);
            toast.error(`${file.name}: ${message}`);
          }
        }
        return;
      }
      for (const [index, file] of files.entries()) {
        const id = uploads[index].id;
        changeActivities([id], "reading");
        try {
          const result = await parseStatementFile(file);
          if (controller.signal.aborted) return;
          results.push(result);
          if (!result.rows.length && result.issues.length)
            changeActivities([id], "failed", result.issues.map((issue) => issue.message).join(" "));
          else {
            parsedIds.push(id);
            changeActivities([id], "saving");
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : "Datei konnte nicht gelesen werden.";
          changeActivities([id], "failed", message);
          results.push({
            file: file.name,
            source: null,
            rows: [],
            skipped: 1,
            issues: [
              {
                file: file.name,
                message,
              },
            ],
          });
        }
      }
      const prepared = prepareStatementImport(results, latestState.current);
      importMetadata.current = prepared.metadata;
      if (prepared.issues.length) toast.error(prepared.issues.length === 1
        ? prepared.issues[0]
        : `${prepared.issues.length} Importhinweise – Details im Uploadstatus.`);
      setUI({ review: prepared.review, open: prepared.review.length > 0 });
      commit(prepared.automatic, prepared.duplicates, undefined, [], parsedIds);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Import fehlgeschlagen.";
      changeActivities(uploads.map((item) => item.id), "failed", message);
      toast.error(message);
    } finally {
      if (!controller.signal.aborted) {
        busyRef.current = false;
        setUI({ busy: false });
      }
    }
  }
  const fileButton = <Button
    size="sm"
    variant="outline"
    className="h-11 min-w-0 flex-1 sm:flex-none"
    aria-label="Dateien auswählen"
    disabled={!ready || !!storageError || ui.busy || !!ui.pending}
    onClick={() => fileInput.current?.click()}
  >
    {ui.busy ? <LoaderCircle className="size-4 animate-spin" /> : <FileUp className="size-4" />}
    {ui.busy ? "Dateien werden geprüft …" : "Dateien auswählen"}
  </Button>;
  return (
    <>
      <section
        aria-label="Kontoauszüge importieren"
        className={cn(
          "mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-border/70 bg-card px-4 py-4 shadow-sm transition-colors motion-reduce:transition-none sm:px-5",
          ui.dragging && "border-primary bg-primary/5",
        )}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current++;
          setUI({ dragging: true });
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current--;
          if (dragDepth.current <= 0) setUI({ dragging: false });
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          void selectFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/5"><FileUp className="size-5 text-muted-foreground" /></span>
          <div className="min-w-0">
            <p className="text-sm font-medium">Kontoauszüge hier ablegen</p>
            <p className="mt-1 text-xs text-muted-foreground">
              CSV, Excel, PDF oder Amex-Screenshot · max. 20 MB
            </p>
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".csv,.xlsx,.pdf,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label="Kontoauszüge auswählen"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void selectFiles(files);
          }}
        />
        <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
          <UploadStatus activities={activities} jobs={workspace ? automation.jobs : []}
            error={workspace ? automation.error : null} summary={state.importStatus}
            reviewCount={openReviewCount} />
          {fileButton}
        </div>
      </section>
      <Dialog
        open={ui.open && ui.review.length > 0}
        onOpenChange={(open) => {
          if (!ui.pending) {
            setUI({ open, ...(!open ? { drafts: {} } : {}) });
          }
        }}
      >
        <DialogContent
          variant="work"
          className="max-h-[min(80dvh,720px)] max-w-[720px]"
          showCloseButton={!ui.pending}
        >
          <DialogHeader>
            <DialogTitle>Kontoauszüge prüfen</DialogTitle>
            <DialogDescription>
              {ui.review.length} offene Zuordnungen
            </DialogDescription>
          {ui.pending && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />Zuordnung wird übernommen …
          </p>}
          </DialogHeader>
          <DialogBody>
          <fieldset disabled={!!ui.pending} className="min-w-0 space-y-4">
            {ui.review.slice(0, 20).map((item) =>
              item.kind === "booking" ? (
                <BookingReview
                  key={item.id}
                  item={item}
                  draft={ui.drafts[item.id] ?? item.draft}
                  changeDraft={changeDraft}
                  disabled={ui.pending?.removeId === item.id}
                  save={saveBooking}
                  skip={skip}
                />
              ) : (
                <FixedReview
                  key={item.id}
                  item={item}
                  disabled={!!ui.pending}
                  save={(decision) => commit([], 0, item.id, [decision])}
                />
              ),
            )}
            {ui.review.length > 20 && (
              <p className="text-xs text-muted-foreground">
                Weitere Einträge folgen nach der Prüfung.
              </p>
            )}
          </fieldset>
          </DialogBody>
          <DialogFooter>
            <p className="mr-auto text-xs text-muted-foreground">Offene Buchungen bleiben in der Prüfliste.</p>
            <Button variant="outline" disabled={!!ui.pending} onClick={skip}>Prüfung schließen</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
