"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { FileUp, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFinance } from "@/components/finance-provider";
import { classify } from "@/lib/calc";
import { currency, monthLabel } from "@/lib/format";
import {
  categories,
  transactionSchema,
  type Category,
  type Transaction,
} from "@/lib/types";
import {
  parseStatementFile,
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
import { CategoryOptions } from "@/components/category-options";

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
};

function BookingReview({
  item,
  disabled,
  save,
  skip,
}: {
  item: Extract<ReviewItem, { kind: "booking" }>;
  disabled: boolean;
  save: (row: Transaction) => void;
  skip: () => void;
}) {
  const [draft, setDraft] = useState<StatementDraft>(item.draft);
  const choices = categories.filter((category) => category !== "Prüfen");
  const candidate = {
    ...draft,
    categoryOverride: true,
    includeInPlan: true,
  };
  const parsed = transactionSchema.safeParse(candidate);
  return (
    <section
      className="panel space-y-3 p-4"
      aria-label={`Buchung prüfen: ${item.draft.description}`}
    >
      <p className="text-xs text-muted-foreground break-words">
        {item.message}
      </p>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_8rem]">
        <label className="space-y-1 text-xs">
          Datum
          <Input aria-label="Datum" type="date" value={draft.date} readOnly />
        </label>
        <label className="space-y-1 text-xs">
          Text
          <Input
            aria-label="Text"
            maxLength={1000}
            value={draft.description}
            readOnly
          />
        </label>
        <label className="space-y-1 text-xs">
          Betrag (€)
          <Input
            aria-label="Betrag"
            value={draft.amount === null ? "" : currency(draft.amount)}
            readOnly
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          Konto/Pocket
          <Input
            aria-label="Konto/Pocket"
            value={`${draft.bank} · ${draft.pocket ?? "Hauptkonto"}`}
            readOnly
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          Kategorie
          <select
            aria-label="Kategorie"
            className="select-input editable w-full"
            value={draft.category}
            disabled={disabled}
            onChange={(e) =>
              setDraft({ ...draft, category: e.target.value as Category })
            }
          >
            <option value="Prüfen" disabled>
              Kategorie wählen
            </option>
            <CategoryOptions excludeReview />
          </select>
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={skip}>
          Später prüfen
        </Button>
        <Button
          variant="outline"
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
              });
          }}
        >
          Zuordnung übernehmen
        </Button>
      </div>
    </section>
  );
}

export function StatementImport({ reviewRequest = 0 }: { reviewRequest?: number }) {
  const { state, ready, storageError, appendStatements, statementImport, openReviewCount } =
    useFinance();
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
  const importMetadata = useRef<ImportMetadata>({});
  const [localUI, setUI] = useReducer(
    (previous: ImportUI, patch: Partial<ImportUI>) => ({
      ...previous,
      ...patch,
    }),
    {
      review: [],
      open: false,
      busy: false,
      dragging: false,
      pending: null,
      ledgerOnly: false,
    },
  );
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
      toast.success(
        ui.pending.decisions.length
          ? "Monatsbetrag geprüft – keine doppelte Buchung"
          : `${statementImport.added} neu, ${statementImport.duplicates} Duplikate ignoriert`,
      );
      setUI({
        open: ui.pending.removeId
          ? ui.review.length > 0
          : localUI.open || !!statementImport.changes?.length,
        pending: null,
      });
    }
  }, [statementImport, ui.pending, ui.review, localUI.open]);

  function commit(
    rows: Transaction[],
    duplicates = 0,
    removeId?: string,
    decisions: FixedDecision[] = [],
  ) {
    if (pendingRef.current || !ready || storageError) return;
    pendingRef.current = true;
    const requestId = crypto.randomUUID();
    const metadata = importMetadata.current;
    importMetadata.current = {};
    setUI({ pending: { requestId, rows, removeId, decisions } });
    // Let React display the disabled controls/progress before the synchronous
    // reducer runs. The reducer still applies to the latest state, not a copy.
    setTimeout(() => appendStatements(rows, duplicates, requestId, decisions, metadata), 0);
  }
  function skip() {
    setUI({ open: false });
  }

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
      if (prepared.issues.length) toast.error(prepared.issues.join("\n"));
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
              Raiffeisen, Revolut oder Amex · CSV/XLSX/PDF · sichere Buchungen
              automatisch · max. 20 MB je Datei
            </p>
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".csv,.xlsx,.pdf"
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
          if (!ui.pending) setUI({ open });
        }}
      >
        <DialogContent
          className="bg-card sm:max-w-3xl"
          showCloseButton={!ui.pending}
        >
          <DialogHeader>
            <DialogTitle>Kontoauszüge prüfen</DialogTitle>
            <DialogDescription>
              Sichere Buchungen sind automatisch gespeichert. Nur diese{" "}
              {ui.review.length} Einträge brauchen eine Entscheidung.
            </DialogDescription>
          </DialogHeader>
          {ui.pending && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />Zuordnung wird übernommen …
          </p>}
          <div className="max-h-[65vh] space-y-3 overflow-auto pr-1">
            {ui.review.slice(0, 20).map((item) =>
              item.kind === "booking" ? (
                <BookingReview
                  key={item.id}
                  item={item}
                  disabled={!!ui.pending}
                  save={(row) => commit([row], 0, item.id)}
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
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
