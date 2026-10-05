"use client";

import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { currency, monthLabel } from "@/lib/format";
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

type Pending = {
  requestId: string;
  removeId?: string;
  rows: Transaction[];
  decisions: FixedDecision[];
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
  const [editingName, setEditingName] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameMissing = editingName && draft.merchantAlias !== undefined && !draft.merchantAlias.trim();
  const fixedCost = draft.fixedCost === true;
  const choices = categories.filter((category) => category !== "Prüfen");
  const classification = classify({
    ...draft, amount: draft.amount ?? 0, categoryOverride: true, manualCategory: true, includeInPlan: true, fixedCost: false,
  });
  const canRememberName = draft.amount !== null && draft.amount < 0 && !classification.isTransfer &&
    merchantAliasSourceKey(item.draft) !== undefined;
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
      aria-label={`Buchung prüfen: ${item.draft.description}`}
    >
      <p className="text-xs text-muted-foreground break-words">
        {item.message}
        {repairOcr && " Ausgaben negativ, Gutschriften positiv eingeben."}
      </p>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_8rem]">
        <label className="space-y-1 text-xs">
          Datum
          <Input aria-label="Datum" type="date" value={draft.date} readOnly={!repairOcr}
            onChange={repairOcr ? (event) => changeDraft(item.id, { ...draft, date: event.target.value }) : undefined} />
        </label>
        <div className="space-y-1 text-xs">
          <p>Text</p>
          <div className="relative">
            <Input
              ref={nameInput}
              aria-label="Text"
              maxLength={repairOcr ? 1000 : 200}
              value={repairOcr ? draft.description : draft.merchantAlias ?? draft.description}
              readOnly={!repairOcr && !editingName}
              disabled={disabled}
              className={!repairOcr ? "pr-10" : undefined}
              aria-invalid={nameMissing}
              onChange={(event) => changeDraft(item.id, { ...draft,
                ...(repairOcr ? { description: event.target.value } : { merchantAlias: event.target.value }) })}
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
              ? "Name, Kategorie und Fixkosten-Auswahl werden für künftige Ausgänge dieses Händlers gemerkt."
              : "Ohne eindeutigen Händlertext gilt der Name nur für diese Buchung."}
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

export function StatementImport({ reviewRequest = 0 }: { reviewRequest?: number }) {
  const { state, ready, storageError, appendStatements, statementImport, openReviewCount } =
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
    pendingRef.current = false;
    if (statementImport.error) {
      toast.error(statementImport.error);
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
  }, [statementImport, ui.pending, ui.review, localUI.open]);

  const commit = useCallback((
    rows: Transaction[],
    duplicates = 0,
    removeId?: string,
    decisions: FixedDecision[] = [],
  ) => {
    if (pendingRef.current || !ready || storageError) return;
    pendingRef.current = true;
    const requestId = crypto.randomUUID();
    const metadata = importMetadata.current;
    importMetadata.current = {};
    setUI({ pending: { requestId, rows, removeId, decisions } });
    // Let React display the disabled controls/progress before the synchronous
    // reducer runs. The reducer still applies to the latest state, not a copy.
    setTimeout(() => appendStatements(rows, duplicates, requestId, decisions, metadata), 0);
  }, [appendStatements, ready, storageError]);
  const saveBooking = useCallback((row: Transaction, id: string) => {
    const original = latestState.current.reviewQueue?.find((item) => item.id === id);
    if (original?.kind === "booking" && (original.draft.date !== row.date ||
      original.draft.amount !== row.amount || original.draft.description !== row.description)) {
      // Corrected bank facts need full reconciliation, not category-only approval.
      importMetadata.current = { ...importMetadata.current, reviewQueue: [{ ...original, draft: row }] };
    }
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
    setUI({ busy: true, dragging: false, ledgerOnly: false });
    const results: StatementResult[] = [];
    try {
      for (const file of files) {
        try {
          results.push(await parseStatementFile(file));
        } catch (error) {
          results.push({
            file: file.name,
            source: null,
            rows: [],
            skipped: 1,
            issues: [
              {
                file: file.name,
                message:
                  error instanceof Error
                    ? error.message
                    : "Datei konnte nicht gelesen werden.",
              },
            ],
          });
        }
      }
      const prepared = prepareStatementImport(results, latestState.current);
      importMetadata.current = prepared.metadata;
      if (prepared.issues.length) toast.error(prepared.issues.length === 1
        ? prepared.issues[0]
        : `${prepared.issues.length} Importhinweise – Details unter „Importhinweise“, unklare Buchungen im Prüfdialog.`);
      setUI({ review: prepared.review, open: prepared.review.length > 0 });
      commit(prepared.automatic, prepared.duplicates);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Import fehlgeschlagen.",
      );
    } finally {
      busyRef.current = false;
      setUI({ busy: false });
    }
  }
  return (
    <>
      <section
        aria-label="Kontoauszüge importieren"
        className={cn(
          "panel mb-4 flex flex-wrap items-center justify-between gap-3 border-dashed px-4 py-3",
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
          <FileUp className="size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Kontoauszüge hier ablegen</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Raiffeisen, Revolut oder Amex · CSV/XLSX/PDF oder Amex-Screenshot · sichere Buchungen
              automatisch · max. 20 MB je Datei
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
        <Button
          size="sm"
          variant="outline"
          className="ml-auto shrink-0"
          disabled={!ready || !!storageError || ui.busy || !!ui.pending}
          onClick={() => fileInput.current?.click()}
        >
          {ui.busy ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <FileUp className="size-4" />
          )}
          {ui.busy ? "Dateien werden geprüft …" : "Dateien auswählen"}
        </Button>
      </section>
      {state.importStatus && (
        <div
          className="mb-4 text-xs text-muted-foreground"
          aria-label="Importstatus"
        >
          Übernommen {state.importStatus.imported} · offen {openReviewCount} ·
          nicht lesbar {state.importStatus.issues.length}
          {!!state.importStatus.issues.length && (
            <details className="mt-2">
              <summary>Importhinweise</summary>
              {state.importStatus.issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </details>
          )}
        </div>
      )}
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
              Sichere Buchungen sind automatisch gespeichert. Nur diese{" "}
              {ui.review.length} Einträge brauchen eine Entscheidung.
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
                <section
                  className="panel space-y-3 p-4"
                  key={item.id}
                  aria-label={`${item.change.category} prüfen`}
                >
                  <p className="text-xs text-muted-foreground">
                    {monthLabel(item.change.month)}
                  </p>
                  <p className="text-sm">
                    {item.change.category} bisher{" "}
                    {currency(item.change.previous)}, Auszug{" "}
                    {currency(item.change.amount)} — neuen Monatsbetrag
                    übernehmen?
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Ab {monthLabel(item.change.month)}. Die Auszugsbuchung
                    bleibt erhalten.
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!ui.pending}
                      onClick={() =>
                        commit([], 0, item.id, [
                          { change: item.change, accept: false },
                        ])
                      }
                    >
                      Bisherigen Dauerbetrag behalten
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!ui.pending}
                      onClick={() =>
                        commit([], 0, item.id, [
                          { change: item.change, accept: true },
                        ])
                      }
                    >
                      Neuen Dauerbetrag übernehmen
                    </Button>
                  </div>
                </section>
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
