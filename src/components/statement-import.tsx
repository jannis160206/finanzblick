"use client";

import { merchantAliasAssignment } from "@/lib/merchant-identity";

import { memo, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { ArrowRight, ChevronRight, CircleHelp, ClipboardCheck, FilePlus2, FileUp, Layers, LoaderCircle, Pencil, Repeat, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PremiumDialog,
  PremiumDialogBody,
  PremiumDialogContent,
  PremiumDialogFooter,
  PremiumDialogHeader,
  PremiumDialogItem,
  usePremiumDialog,
} from "@/components/ui/premium-dialog";
import { MotionBox } from "@/components/ui/premium-dialog/motion";
import { MerchantMark } from "@/components/merchant-mark";
import { BookingContractDialogs, type BookingContractMode } from "@/components/booking-contract-dialogs";
import { canHoldContract } from "@/lib/contract-booking";
import { useFinance } from "@/components/finance-provider";
import { classify } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import {
  categories,
  transactionSchema,
  type Category,
  type Transaction,
} from "@/lib/types";
import { groupReviews, reviewSuggestions, suggestedDraft, type ReviewGroup } from "@/lib/ai/review-groups";
import type { AiSuggestion } from "@/lib/ai/suggestions";
import {
  parseStatementFile,
  parseStatementAmount,
  type StatementDraft,
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
import { PaypalActivityImport, usePaypalActivityImport } from "@/components/paypal-activity-import";
import { isPaypalActivityExport } from "@/lib/import/paypal-activity";
import { useImportInbox } from "@/components/use-import-inbox";
import { MAX_UPLOAD_BYTES, statementUploadResponseSchema } from "@/lib/automation/schema";
import { type UploadedStatementResult } from "@/lib/import/results";
import { automationFailure, classifyParserError } from "@/lib/automation/errors";

type Pending = {
  requestId: string;
  removeId?: string;
  rows: Transaction[];
  decisions: FixedDecision[];
  uploadIds?: string[];
  resultIds?: string[];
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

const ghostField = "h-auto w-auto min-w-0 border-transparent bg-transparent px-0 py-0 shadow-none read-only:cursor-default [field-sizing:content] focus-visible:ring-[3px]";

const BookingReview = memo(function BookingReview({
  item,
  draft,
  changeDraft,
  disabled,
  reuploadOnly,
  save,
  skip,
  suggestion,
  onContract,
}: {
  item: Extract<ReviewItem, { kind: "booking" }>;
  draft: StatementDraft;
  changeDraft: (id: string, draft: StatementDraft) => void;
  disabled: boolean;
  reuploadOnly: boolean;
  save: (row: Transaction, id: string) => void;
  skip: () => void;
  suggestion?: AiSuggestion;
  /** Offered for bookings already in the ledger: opens the contract assistant for this booking. */
  onContract?: (id: string) => void;
}) {
  const repairOcr = isAmexScreenshot(item.draft) && item.message.startsWith("Amex-Screenshot:");
  const repairSource = item.sourceRepair === true;
  const repairFacts = repairOcr || repairSource;
  const [sourceConfirmed, setSourceConfirmed] = useState(false);
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
  const name = repairFacts ? draft.description : editingName ? draft.merchantAlias ?? bookingDescription(draft) : bookingDescription(draft);
  const nameField = (
    <Input
      ref={nameInput}
      aria-label="Text"
      maxLength={repairFacts ? 1000 : 200}
      value={name}
      readOnly={reuploadOnly || (!repairFacts && !editingName)}
      disabled={disabled}
      className={repairFacts || editingName ? undefined : cn(ghostField, "w-full truncate text-base font-medium")}
      aria-invalid={nameMissing}
      onChange={(event) => { setSourceConfirmed(false); changeDraft(item.id, { ...draft,
        ...(repairFacts ? { description: event.target.value,
          ...(repairSource && item.draft.description ? { rawDescription: draft.rawDescription ?? item.draft.description } : {}) }
          : merchantAliasAssignment(draft, event.target.value)) }); }}
    />
  );
  const dateText = draft.date ? dateLabel(draft.date) : "ohne Datum";
  const amountText = draft.amount === null ? "" : currency(draft.amount);
  const account = accountLabel(draft);
  return (
    <section
      className="@container space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-xs"
      aria-label={`Buchung prüfen: ${bookingDescription(item.draft)}`}
    >
      {repairFacts ? (
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr_8rem]">
          <label className="space-y-1.5 text-xs font-medium">
            Datum
            <Input aria-label="Datum" type="date" value={draft.date} readOnly={reuploadOnly}
              aria-invalid={!transactionSchema.shape.date.safeParse(draft.date).success}
              aria-describedby={feedbackId}
              onChange={!reuploadOnly ? (event) => { setSourceConfirmed(false); changeDraft(item.id, { ...draft, date: event.target.value }); } : undefined} />
          </label>
          <label className="space-y-1.5 text-xs font-medium">Text{nameField}</label>
          <label className="space-y-1.5 text-xs font-medium">
            Betrag (€)
            <Input
              aria-label="Betrag"
              {...(!reuploadOnly ? {
                defaultValue: draft.amount === null ? "" : String(draft.amount).replace(".", ","),
                inputMode: "decimal" as const,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setSourceConfirmed(false); changeDraft(item.id, { ...draft, amount: parseStatementAmount(event.target.value) }); },
              } : { value: amountText, readOnly: true })}
            />
          </label>
          <label className="space-y-1.5 text-xs font-medium sm:col-span-3">
            Konto/Pocket
            <Input aria-label="Konto/Pocket" value={account} readOnly />
          </label>
        </div>
      ) : (
        <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5">
          <MerchantMark booking={{ ...draft, amount: draft.amount ?? 0 }} classification={classification} fallbackName={bookingDescription(draft)}
            className="col-start-1 row-span-2 row-start-1 size-10 self-start rounded-xl" />
            <div className="col-span-2 col-start-2 row-start-1 flex min-w-0 items-center gap-1 @md:col-span-1">
              {nameField}
              {!editingName && (
                <Button type="button" variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground"
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
            <div className="col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <Input aria-label="Datum" value={dateText} readOnly size={dateText.length} className={cn(ghostField, "text-xs text-muted-foreground")} />
              <span aria-hidden="true">·</span>
              <Input aria-label="Konto/Pocket" value={account} readOnly size={account.length} className={cn(ghostField, "text-xs text-muted-foreground")} />
            </div>
          <Input aria-label="Betrag" value={amountText} readOnly size={Math.max(amountText.length, 4)}
            className={cn(ghostField, "col-start-3 row-start-2 justify-self-end text-right text-base font-semibold tracking-tight tabular-nums @md:row-start-1 @md:text-lg",
              (draft.amount ?? 0) > 0 && "text-money-in")} />
        </div>
      )}
      <p id={feedbackId} className="flex gap-2 rounded-xl bg-surface-sunken/70 px-3 py-2 text-xs leading-relaxed text-muted-foreground break-words">
        <CircleHelp aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0">
          {repairOcr ? screenshotReviewMessage(draft) : item.message}
          {repairFacts && item.draft.amount === null && " Ausgaben −, Gutschriften +."}
          {repairSource && " Quellwerte bleiben bis zur ausdrücklichen Bestätigung unverbucht."}
        </span>
      </p>
      {suggestion && item.draft.category === "Prüfen" && draft.category === suggestion.category && (
        <p className="flex gap-2 rounded-xl bg-accent-muted px-3 py-2 text-xs leading-relaxed text-primary break-words">
          <Sparkles aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">{suggestionLabel(suggestion)} – bitte prüfen ({suggestion.reason}).</span>
        </p>
      )}
      {editingName && <p className={cn("text-xs", nameMissing ? "font-medium text-destructive" : "text-muted-foreground")}>
        {nameMissing ? "Bitte einen Händlernamen eingeben." : canRememberName
          ? "Ändert den Namen aller passenden bisherigen und künftigen Buchungen."
          : "Unklarer Händlertext: Name gilt nur für diese Buchung."}
      </p>}
      <div className="grid items-center gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
        <CategorySelect
          label="Kategorie"
          value={draft.category}
          disabled={disabled}
          onValueChange={(category) =>
            changeDraft(item.id, { ...draft, category })
          }
          excludeReview
        />
        <FixedCostChoice
          checked={fixedCost}
          onChange={(fixedCost) => changeDraft(item.id, { ...draft, fixedCost })}
          disabled={disabled}
          eligible={canMarkFixed}
        />
      </div>
      {repairSource && (reuploadOnly ? <p className="text-xs text-muted-foreground">
        Bitte einen belegten EUR-Kontoauszug erneut auswählen. Diese Quellwerte können nicht als EUR-Buchung bestätigt werden.
      </p> : <label className="flex items-start gap-2 rounded-xl border border-border/70 px-3 py-2.5 text-xs">
        <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={sourceConfirmed} disabled={disabled}
          onChange={(event) => setSourceConfirmed(event.target.checked)} />
        Datum, Text und EUR-Betrag anhand des Originalbelegs geprüft
      </label>)}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        {onContract && (
          <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" disabled={disabled}
            onClick={() => onContract(item.draft.id)}>
            <FilePlus2 aria-hidden="true" />Als Vertrag anlegen
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" disabled={disabled} onClick={skip}>
          Später prüfen
        </Button>
        <Button
          size="sm"
          disabled={
            disabled ||
            reuploadOnly ||
            (repairSource && !sourceConfirmed) ||
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

function suggestionLabel(suggestion: AiSuggestion) {
  return suggestion.source === "Historie" ? "Vorschlag aus deiner Historie"
    : suggestion.source === "Regel" ? "Vorschlag laut Händlerregel"
    : suggestion.source === "Branche" ? "Vorschlag laut Branche des Händlers"
    : suggestion.source === "Abo" ? "Gleicher PayPal-Betrag in mehreren Monaten – wohl ein Abo" : "KI-Vorschlag";
}

const MerchantGroupReview = memo(function MerchantGroupReview({
  group,
  children,
  disabled,
  save,
}: {
  group: ReviewGroup;
  children: React.ReactNode;
  disabled: boolean;
  save: (group: ReviewGroup, category: Category) => void;
}) {
  const [category, setCategory] = useState<Category>(group.suggestion?.category ?? "Prüfen");
  const [expanded, setExpanded] = useState(false);
  const { mode } = usePremiumDialog();
  const listId = useId();
  const income = group.total > 0;
  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-xs" aria-label={`Händlergruppe prüfen: ${group.name}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-primary"><Layers className="size-4.5" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-medium break-words">{group.name}</p>
          <p className="text-xs text-muted-foreground">Gleicher Händler · gemeinsam zuordnen</p>
        </div>
        <p className="shrink-0 text-right">
          <span className={cn("block text-lg font-semibold tracking-tight tabular-nums", income && "text-money-in")}>{currency(group.total)}</span>
          <span className="block text-xs text-muted-foreground">{group.items.length} {income ? "Gutschriften" : "Buchungen"}</span>
        </p>
      </div>
      {group.suggestion && category === group.suggestion.category && (
        <p className="flex gap-2 rounded-xl bg-accent-muted px-3 py-2 text-xs text-primary">
          <Sparkles aria-hidden="true" className="mt-px size-3.5 shrink-0" />{suggestionLabel(group.suggestion)} – bitte prüfen.
        </p>
      )}
      <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <CategorySelect label={`Kategorie für ${group.name}`} value={category} disabled={disabled}
          onValueChange={setCategory} excludeReview />
        <Button size="sm" className="min-h-10" disabled={disabled || category === "Prüfen"} onClick={() => save(group, category)}>
          Alle {group.items.length} übernehmen
        </Button>
      </div>
      <div className="border-t border-border/60 pt-2">
        <button type="button" disabled={disabled} aria-expanded={expanded} aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
          className="-mx-2 flex min-h-10 items-center gap-2 rounded-xl px-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 motion-reduce:transition-none">
          <ChevronRight aria-hidden="true" className={cn("size-4 transition-transform duration-200 ease-soft motion-reduce:transition-none", expanded && "rotate-90")} />
          {expanded ? "Einzelbuchungen ausblenden" : "Einzeln prüfen"}
        </button>
      </div>
      {expanded && (
        <MotionBox mode={mode} id={listId} className="space-y-3"
          initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0, transition: { type: "spring", stiffness: 380, damping: 32 } }}>
          {children}
        </MotionBox>
      )}
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
  const delta = Math.round((Math.abs(item.change.amount) - Math.abs(item.change.previous)) * 100) / 100;
  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-xs" aria-label={`${item.change.category} prüfen`}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-primary"><Repeat className="size-4.5" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{item.change.category}</p>
          <p className="text-xs text-muted-foreground">Fixkosten · {monthLabel(item.change.month)}</p>
        </div>
        {delta !== 0 && (
          <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-medium tabular-nums",
            delta > 0 ? "bg-warning-soft text-warning" : "bg-success-soft text-success")}>
            {delta > 0 ? "+" : "−"}{currency(Math.abs(delta)).replace("-", "")}
          </span>
        )}
      </div>
      <div aria-hidden="true" className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-center">
        <div className="rounded-xl bg-surface-sunken/70 px-3 py-2">
          <p className="text-2xs text-muted-foreground">Bisher</p>
          <p className="text-sm font-semibold tabular-nums text-muted-foreground line-through decoration-muted-foreground/50">{currency(item.change.previous)}</p>
        </div>
        <ArrowRight className="size-4 text-muted-foreground" />
        <div className="rounded-xl bg-accent-muted px-3 py-2">
          <p className="text-2xs text-primary">Laut Auszug</p>
          <p className="text-sm font-semibold tabular-nums">{currency(item.change.amount)}</p>
        </div>
      </div>
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
        {item.change.bookings.map((booking, index) => (
          <div key={booking.id} className="px-3 py-2.5 text-sm" aria-label={`Erkannte Buchung: ${bookingDescription(booking)}`}>
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
                    <Button type="button" variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground"
                      aria-label="Händlername bearbeiten" title="Händlername bearbeiten" disabled={disabled}
                      onClick={() => setNames((previous) => ({ ...previous, [booking.id]: bookingDescription(booking) }))}>
                      <Pencil className="size-3" aria-hidden="true" />
                    </Button>
                  </>
                )}
              </div>
              <span className="shrink-0 font-medium tabular-nums">{currency(booking.amount)}</span>
            </div>
            {!bookings[index].success && <p className="mt-1 text-xs font-medium text-destructive">Bitte einen Händlernamen mit 1–200 Zeichen eingeben.</p>}
            <p className="mt-0.5 text-xs text-muted-foreground">{dateLabel(booking.date)} · {accountLabel(booking)}</p>
          </div>
        ))}
      </div>
      <p className="text-sm">
        {item.change.category} bisher {currency(item.change.previous)}, Auszug {currency(item.change.amount)} — neuen Monatsbetrag übernehmen?
      </p>
      <p className="text-xs text-muted-foreground">Gilt ab {monthLabel(item.change.month)}.</p>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3">
        <Button variant="ghost" size="sm" disabled={disabled || invalid} onClick={() => confirm(false)}>
          Bisherigen Dauerbetrag behalten
        </Button>
        <Button size="sm" disabled={disabled || invalid} onClick={() => confirm(true)}>
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
  const { activities, add: addActivities, change: changeActivities, remove: removeActivity } = useUploadActivity(automation.jobs);
  const cancelledUploads = useRef(new Set<string>());
  const uploadControllers = useRef(new Map<string, AbortController>());
  const importController = useRef<AbortController | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    importController.current?.abort();
    if (commitTimer.current !== null) clearTimeout(commitTimer.current);
  }, []);
  const { state, ready, saved, storageError, appendStatements, statementImport, openReviewCount } =
    useFinance();
  const importPaypalActivity = usePaypalActivityImport();
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
  useImportInbox("statement", ready && !storageError, (files) => { void selectFiles(files); });

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
      const resultIds = ui.pending.resultIds ?? ui.pending.uploadIds;
      const outcomes = (state.importResults ?? []).filter((result) => resultIds?.includes(result.uploadId));
      if (outcomes.some((result) => result.status === "failed"))
        toast.error("Ein Import ist fehlgeschlagen – Details im Uploadstatus.");
      else if (outcomes.some((result) => result.status === "unsupported"))
        toast.error("Datei nicht unterstützt – vollständigen Auszug erneut auswählen. Details im Uploadstatus.");
      else if (outcomes.some((result) => result.status === "with-warnings"))
        toast.error("Import mit Hinweisen abgeschlossen – offene Buchungen prüfen. Details im Uploadstatus.");
      else toast.success(
        ui.pending.decisions.length
          ? "Monatsbetrag geprüft – keine doppelte Buchung"
          : outcomes.length
            ? `${outcomes.reduce((total, result) => total + result.inserted, 0)} neu, ${outcomes.reduce((total, result) => total + result.updated, 0)} aktualisiert, ${outcomes.reduce((total, result) => total + result.duplicates, 0)} Duplikate`
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
  }, [statementImport, ui.pending, ui.review, localUI.open, saved, storageError, changeActivities, state.importResults]);

  const commit = useCallback((
    rows: Transaction[],
    duplicates = 0,
    removeId?: string,
    decisions: FixedDecision[] = [],
    uploadIds?: string[],
    resultIds?: string[],
  ) => {
    if (pendingRef.current || !ready || storageError) return;
    pendingRef.current = true;
    const requestId = crypto.randomUUID();
    const metadata = importMetadata.current;
    importMetadata.current = {};
    setUI({ pending: { requestId, rows, removeId, decisions, uploadIds, resultIds } });
    // Let React display the disabled controls/progress before the synchronous
    // reducer runs. The reducer still applies to the latest state, not a copy.
    commitTimer.current = setTimeout(() => appendStatements(rows, duplicates, requestId, decisions, metadata), 0);
  }, [appendStatements, ready, storageError]);
  const saveBooking = useCallback((row: Transaction, id: string) => {
    const original = latestState.current.reviewQueue?.find((item) => item.id === id);
    if (original?.kind === "booking" && (original.importUploadId || original.sourceRepair || original.draft.date !== row.date ||
      original.draft.amount !== row.amount || original.draft.description !== row.description)) {
      // Imported reviews also update their UUID outcome, not only the ledger.
      importMetadata.current = { ...importMetadata.current, reviewQueue: [{ ...original, draft: row }] };
    }
    if (row.amexSource || isAmexScreenshot(row))
      importMetadata.current = { ...importMetadata.current, amexReconciliation: { rows: [row] } };
    commit([row], 0, id);
  }, [commit]);
  const saveGroup = useCallback((group: ReviewGroup, category: Category) => {
    const suggestions = reviewSuggestions(group.items, latestState.current.aiSuggestions);
    const rows: Transaction[] = [];
    for (const item of group.items) {
      const draft = localUI.drafts[item.id] ?? suggestedDraft(item.draft, suggestions.find((entry) => entry.id === item.id));
      const parsed = transactionSchema.safeParse({
        ...draft, category, categoryOverride: true, manualCategory: true, reviewed: true, includeInPlan: true, fixedCost: false,
      });
      if (!parsed.success) {
        toast.error("Diese Buchung braucht eine Einzelprüfung.");
        return;
      }
      rows.push({ ...parsed.data, includeInPlan: classify(parsed.data).includeInPlan });
    }
    const imported = group.items.flatMap((item, index) => item.importUploadId ? [{ ...item, draft: rows[index] }] : []);
    if (imported.length) importMetadata.current = { ...importMetadata.current, reviewQueue: imported };
    commit(rows, 0, group.items[0].id);
  }, [commit, localUI.drafts]);
  const skip = useCallback(() => {
    setUI({ open: false, drafts: {} });
  }, []);
  const [contractFlow, setContractFlow] = useState<{
    booking: Transaction; mode: BookingContractMode; open: boolean; session: number;
  } | null>(null);
  const ledgerRows = useMemo(() => new Map(state.transactions.map((row) => [row.id, row])), [state.transactions]);
  const openContract = useCallback((id: string) => {
    const booking = latestState.current.transactions.find((row) => row.id === id);
    if (booking) setContractFlow((current) => ({ booking, mode: "create", open: true, session: (current?.session ?? 0) + 1 }));
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
    cancelledUploads.current.clear();
    uploadControllers.current.clear();
    const controller = new AbortController();
    importController.current = controller;
    setUI({ busy: true, dragging: false, ledgerOnly: false });
    const results: UploadedStatementResult[] = [];
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
    // PayPal's own export only names shops behind Amex/bank bookings; it never becomes bookings itself.
    const handledAsPaypal = async (file: File, id: string) => {
      if (!/\.csv$/i.test(file.name) || !file.size || file.size > MAX_UPLOAD_BYTES) return false;
      let head = "";
      try {
        head = await file.slice(0, 4096).text();
      } catch {
        return false;
      }
      if (!isPaypalActivityExport(head)) return false;
      await importPaypalActivity(file);
      removeActivity(id);
      return true;
    };
    try {
      if (workspace) {
        if (!saved) throw new Error("Bitte zuerst die laufende Synchronisierung abwarten.");
        for (const [index, file] of files.entries()) {
          const id = uploads[index].id;
          if (cancelledUploads.current.has(id)) continue;
          if (await handledAsPaypal(file, id)) continue;
          const uploadController = new AbortController();
          uploadControllers.current.set(id, uploadController);
          changeActivities([id], "uploading");
          try {
            if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new Error("Ein Kontoauszug muss Daten enthalten und darf höchstens 20 MiB groß sein.");
            const response = await fetch(`/api/statements?name=${encodeURIComponent(file.name)}`, {
              method: "POST", credentials: "same-origin", body: file,
              signal: AbortSignal.any([controller.signal, uploadController.signal, AbortSignal.timeout(90_000)]),
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
            if (cancelledUploads.current.has(id)) continue;
            const message = error instanceof Error ? error.message : "Der Auszug konnte nicht hochgeladen werden.";
            changeActivities([id], "failed", message);
            toast.error(`${file.name}: ${message}`);
          }
        }
        return;
      }
      for (const [index, file] of files.entries()) {
        const id = uploads[index].id;
        if (await handledAsPaypal(file, id)) continue;
        changeActivities([id], "reading");
        try {
          const result = await parseStatementFile(file);
          if (controller.signal.aborted) return;
          results.push({ ...result, uploadId: id });
          parsedIds.push(id);
          changeActivities([id], "saving");
        } catch (error) {
          if (controller.signal.aborted) return;
          const failure = automationFailure(classifyParserError(error).code);
          const message = failure.message;
          changeActivities([id], "failed", message, failure.code);
          results.push({
            uploadId: id,
            file: file.name,
            source: null,
            rows: [],
            skipped: 0,
            failureCode: failure.code,
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
      if (prepared.issues.length)
        toast.error(`${prepared.issues.length === 1 ? "1 Importhinweis" : `${prepared.issues.length} Importhinweise`} – Details im Uploadstatus.`);
      setUI({ review: prepared.review, open: prepared.review.length > 0 });
      commit(prepared.automatic, prepared.duplicates, undefined, [], parsedIds, uploads.map((item) => item.id));
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
  async function cancelUpload(id: string) {
    if (!workspace) {
      cancelledUploads.current.add(id);
      removeActivity(id);
      return;
    }
    const local = activities.some((item) => item.id === id);
    cancelledUploads.current.add(id);
    uploadControllers.current.get(id)?.abort();
    try {
      const response = await fetch(`/api/statements?id=${encodeURIComponent(id)}`, {
        method: "DELETE", credentials: "same-origin",
        headers: { "X-Finanzblick-Account": workspace.user.id },
      });
      // Not yet reserved or already finished on the server: nothing left to stop.
      if (!response.ok && response.status !== 404 && response.status !== 409) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error : "Die Verarbeitung konnte nicht abgebrochen werden.");
      }
      if (local) removeActivity(id);
      toast.success("Verarbeitung abgebrochen.");
    } catch (error) {
      cancelledUploads.current.delete(id);
      const message = error instanceof Error ? error.message : "Die Verarbeitung konnte nicht abgebrochen werden.";
      if (local) changeActivities([id], "failed", message);
      toast.error(message);
    }
  }  const fileButton = <Button
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
          "mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-dashed border-border/70 px-4 py-2 transition-colors motion-reduce:transition-none sm:px-5",
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
        <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <FileUp aria-hidden="true" className="size-4 shrink-0" />
          <span>Auszüge hierher ziehen</span>
          <span className="hidden text-2xs lg:inline">CSV, Excel, PDF oder Amex-Screenshot · max. 20 MB</span>
        </p>
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
            reviewCount={openReviewCount} results={state.importResults}
            onReview={() => { if (openReviewCount) setUI({ open: true, ledgerOnly: false }); }}
            onReupload={() => fileInput.current?.click()}
            onCancel={(id) => { void cancelUpload(id); }} />
          {fileButton}
        </div>
      </section>
      <PremiumDialog
        open={ui.open && ui.review.length > 0}
        onOpenChange={(open) => {
          if (!ui.pending) {
            setUI({ open, ...(!open ? { drafts: {} } : {}) });
          }
        }}
      >
        <PremiumDialogContent
          size="lg"
          variant="work"
          snapPoints={[0.92]}
          className="max-h-[min(80dvh,720px)]"
          sheetClassName=""
          showCloseButton={!ui.pending}
        >
          <PremiumDialogHeader icon={ClipboardCheck} title="Kontoauszüge prüfen" description={`${ui.review.length} offene Zuordnungen`}>
          {ui.pending && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />Zuordnung wird übernommen …
          </p>}
          <PaypalActivityImport review={ui.review} disabled={!!ui.pending} />
          </PremiumDialogHeader>
          <PremiumDialogBody>
          <fieldset disabled={!!ui.pending} className="min-w-0 space-y-3">
            {(() => {
              const reuploadOnly = (item: ReviewItem) => (state.importResults ?? []).some((result) =>
                result.issues.some((issue) => issue.reviewId === item.id && issue.action === "reupload"));
              const suggestions = reviewSuggestions(ui.review, state.aiSuggestions);
              const suggestionOf = (id: string) => suggestions.find((entry) => entry.id === id);
              const { groups, singles } = groupReviews(ui.review, suggestions, reuploadOnly);
              const renderItem = (item: ReviewItem) => item.kind === "booking" ? (
                <BookingReview
                  key={item.id}
                  item={item}
                  draft={ui.drafts[item.id] ?? suggestedDraft(item.draft, suggestionOf(item.id))}
                  changeDraft={changeDraft}
                  disabled={ui.pending?.removeId === item.id}
                  reuploadOnly={reuploadOnly(item)}
                  save={saveBooking}
                  skip={skip}
                  suggestion={suggestionOf(item.id)}
                  onContract={ledgerRows.has(item.draft.id) && canHoldContract(ledgerRows.get(item.draft.id)!) ? openContract : undefined}
                />
              ) : (
                <FixedReview
                  key={item.id}
                  item={item}
                  disabled={!!ui.pending}
                  save={(decision) => commit([], 0, item.id, [decision])}
                />
              );
              const units = [
                ...groups.map((group) => (
                  <MerchantGroupReview key={group.key} group={group} disabled={!!ui.pending} save={saveGroup}>
                    {group.items.map(renderItem)}
                  </MerchantGroupReview>
                )),
                ...singles.map(renderItem),
              ];
              return <>
                {units.slice(0, 20).map((unit) => <PremiumDialogItem key={unit.key}>{unit}</PremiumDialogItem>)}
                {units.length > 20 && (
                  <p className="text-xs text-muted-foreground">
                    Weitere Einträge folgen nach der Prüfung.
                  </p>
                )}
              </>;
            })()}
          </fieldset>
          </PremiumDialogBody>
          <PremiumDialogFooter>
            <p className="text-xs text-muted-foreground sm:mr-auto">Offene Buchungen bleiben in der Prüfliste.</p>
            <Button variant="outline" disabled={!!ui.pending} onClick={skip}>Prüfung schließen</Button>
          </PremiumDialogFooter>
        </PremiumDialogContent>
      </PremiumDialog>
      {contractFlow && (
        <BookingContractDialogs
          key={contractFlow.session}
          booking={contractFlow.booking}
          mode={contractFlow.mode}
          open={contractFlow.open}
          onModeChange={(mode) => setContractFlow((current) => current && { ...current, mode })}
          onClose={() => setContractFlow((current) => current && { ...current, open: false })}
        />
      )}
    </>
  );
}
