"use client";

import { BankLogo } from "@/components/bank-logo";
import { useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ListChecks, Pencil, Tags } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  PremiumDialog,
  PremiumDialogBody,
  PremiumDialogContent,
  PremiumDialogFooter,
  PremiumDialogForm,
  PremiumDialogHeader,
  PremiumDialogItem,
} from "@/components/ui/premium-dialog";
import { MerchantMark } from "@/components/merchant-mark";
import { CategorySelect } from "@/components/category-select";
import { FixedCostChoice } from "@/components/fixed-cost-choice";
import { useFinance } from "@/components/finance-provider";
import { accountLabel } from "@/lib/accounts";
import { actualBookings, classify } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { FixedPlanCapacityError } from "@/lib/fixed-plan";
import { currency, dateLabel } from "@/lib/format";
import { queueLedgerReview } from "@/lib/import/review";
import { bookingDescription } from "@/lib/import/merchant-description";
import { synchronizePlan } from "@/lib/planning";
import { assignTransactions } from "@/lib/transaction-tools";
import {
  appStateSchema,
  transactionSchema,
  type AppState,
  type Category,
  type Transaction,
} from "@/lib/types";

/** Sets or removes the user's note on one booking. */
export function setBookingNote(state: AppState, id: string, note: string): AppState {
  const text = note.trim().slice(0, 300);
  return {
    ...state,
    transactions: state.transactions.map((row) => {
      if (row.id !== id || (row.note ?? "") === text) return row;
      const next = { ...row };
      if (text) next.note = text;
      else delete next.note;
      return next;
    }),
  };
}
import type { AccountedTransaction } from "@/lib/shared-holiday";

function bookingSnapshot(booking: Transaction | undefined) {
  return JSON.stringify(
    booking &&
      Object.fromEntries(
        Object.entries(booking).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
  );
}

export function TransactionForm({
  transaction,
  onClose,
  returnFocus,
}: {
  transaction: Transaction;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const { state, update, storageError } = useFinance();
  const currentBooking = useMemo(
    () => actualBookings(state).find((row) => row.id === transaction.id),
    [state, transaction.id],
  );
  const stale =
    !currentBooking ||
    bookingSnapshot(currentBooking) !== bookingSnapshot(transaction);
  const [editingName, setEditingName] = useState(false);
  const [note, setNote] = useState(transaction.note ?? "");
  const form = useForm<Transaction>({
    resolver: zodResolver(transactionSchema),
    defaultValues: transaction,
  });
  const values = useWatch({ control: form.control });
  const merchantName = editingName
    ? values.merchantAlias ?? bookingDescription(transaction)
    : bookingDescription({ ...transaction, merchantAlias: values.merchantAlias });
  const nameMissing = editingName && !merchantName.trim();
  const preview = classify({
    ...transaction,
    description: values.description ?? "",
    merchantAlias: values.merchantAlias,
    amount: values.amount ?? 0,
    category: values.category ?? "Sonstiges",
    pocket: values.pocket ?? null,
    includeInPlan: true,
    categoryOverride: values.categoryOverride,
    manualCategory: true,
    fixedCost: values.fixedCost,
    sourceCategory: values.sourceCategory,
    bank: values.bank,
  });
  const canMarkFixed =
    transaction.amount < 0 &&
    !preview.isTransfer &&
    !isIncomeCategory(preview.category);
  function save(value: Transaction) {
    if (stale) {
      toast.error(
        "Die Buchung wurde inzwischen geändert oder gelöscht. Bitte erneut öffnen.",
      );
      return;
    }
    const assignment = {
      category: value.category,
      ...(editingName && value.merchantAlias !== transaction.merchantAlias
        ? { merchantAlias: value.merchantAlias }
        : {}),
      ...(value.fixedCost !== undefined
        ? { fixedCost: canMarkFixed && value.fixedCost }
        : {}),
    };
    try {
      synchronizePlan(
        queueLedgerReview(
          assignTransactions(state, [transaction.id], assignment),
        ),
      );
    } catch (error) {
      if (!(error instanceof FixedPlanCapacityError)) throw error;
      toast.error(error.message);
      return;
    }
    update((current) =>
      setBookingNote(
        assignTransactions(current, [transaction.id], assignment),
        transaction.id,
        note,
      ),
    );
    toast.success(
      value.category !== "Prüfen"
        ? "Zuordnung gespeichert"
        : "Prüfung bleibt offen",
    );
    onClose();
  }
  const error = (name: keyof Transaction) => form.formState.errors[name]?.message;
  return (
    <PremiumDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PremiumDialogContent
        size="md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <PremiumDialogHeader
          icon={Tags}
          title="Zuordnung ändern"
          description="Name, Kategorie, Fixkosten und Notiz ändern. Namensänderungen gelten für alle passenden bisherigen und künftigen Buchungen."
        />
        <PremiumDialogForm onSubmit={form.handleSubmit(save)}>
          <PremiumDialogBody className="space-y-6">
            <PremiumDialogItem>
              <section
                aria-label="Originalbuchung"
                className="rounded-2xl bg-surface-sunken/70 p-4"
              >
                <div className="flex items-start gap-3">
                  <MerchantMark booking={transaction} classification={preview} fallbackName={merchantName} className="size-11 rounded-xl" />
                  <div className="min-w-0 flex-1">
                    <p className="text-2xs font-medium text-muted-foreground">Originalbuchung</p>
                    <div className="mt-0.5 flex items-start gap-2">
                      {editingName ? (
                        <Input
                          autoFocus
                          aria-label="Händlername"
                          maxLength={200}
                          value={merchantName}
                          aria-invalid={nameMissing || !!form.formState.errors.merchantAlias}
                          aria-describedby={nameMissing ? "tx-name-error" : undefined}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) =>
                            form.setValue("merchantAlias", event.target.value, {
                              shouldDirty: true,
                              shouldValidate: true,
                            })
                          }
                        />
                      ) : (
                        <p className="min-w-0 break-words text-base font-medium">{merchantName}</p>
                      )}
                      {!editingName && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0 text-muted-foreground"
                          aria-label="Händlername bearbeiten"
                          title="Händlername bearbeiten"
                          onClick={() => setEditingName(true)}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                    </div>
                    {nameMissing ? (
                      <p id="tx-name-error" className="mt-1 text-xs font-medium text-destructive" role="alert">
                        Bitte einen Händlernamen eingeben.
                      </p>
                    ) : (
                      error("merchantAlias") && (
                        <p className="mt-1 text-xs font-medium text-destructive" role="alert">{error("merchantAlias")}</p>
                      )
                    )}
                  </div>
                </div>
                <p className="amount mt-4 text-3xl tracking-tight">{currency(transaction.amount)}</p>
                <dl className="mt-3 space-y-1.5 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-muted-foreground">Datum</dt>
                    <dd>{dateLabel(transaction.date)}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt className="text-muted-foreground">Konto/Pocket</dt>
                    <dd className="flex min-w-0 items-center gap-1.5"><BankLogo bank={transaction.bank} size="xs" />{accountLabel(transaction)}</dd>
                  </div>
                </dl>
              </section>
            </PremiumDialogItem>
            <Field
              label="Kategorie"
              hint={<><span className="block">{preview.reason || "Im Alltagsbudget berücksichtigt"}</span><span className="block">„Prüfen“ lässt die Zuordnung offen.</span></>}
              error={error("category")}
            >
              <CategorySelect
                label="Kategorie"
                value={values.category ?? transaction.category}
                onValueChange={(category) => {
                  form.setValue("category", category, {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                  form.setValue("categoryOverride", true, {
                    shouldDirty: true,
                  });
                  form.setValue("manualCategory", true, { shouldDirty: true });
                }}
              />
            </Field>
            <PremiumDialogItem className="rounded-2xl border border-border/70 px-4 py-2">
              <FixedCostChoice
                checked={values.fixedCost ?? preview.isFixedCost}
                onChange={(checked) =>
                  form.setValue("fixedCost", checked, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
                eligible={canMarkFixed}
              />
            </PremiumDialogItem>
            <Field label="Notiz" hint="Nur für dich – erscheint in der Umsatzliste.">
              <Input
                maxLength={300}
                value={note}
                placeholder="z. B. Fernseher fürs Wohnzimmer"
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
            {stale && (
              <p role="alert" className="text-sm font-medium text-destructive">
                Die Buchung wurde inzwischen geändert oder gelöscht. Bitte
                schließen und erneut öffnen.
              </p>
            )}
            {storageError && (
              <p role="alert" className="text-sm font-medium text-destructive">
                {storageError}
              </p>
            )}
          </PremiumDialogBody>
          <PremiumDialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button
              type="submit"
              disabled={nameMissing || stale || !!storageError}
            >
              Zuordnung übernehmen
            </Button>
          </PremiumDialogFooter>
        </PremiumDialogForm>
      </PremiumDialogContent>
    </PremiumDialog>
  );
}

export function BatchAssignmentDialog({
  bookings,
  onClose,
  returnFocus,
}: {
  bookings: AccountedTransaction[];
  onClose: (saved?: boolean) => void;
  returnFocus: () => void;
}) {
  const { state, update, storageError } = useFinance();
  const [category, setCategory] = useState<Category | "">("");
  const current = useMemo(() => actualBookings(state), [state]);
  const currentById = useMemo(
    () => new Map(current.map((row) => [row.id, row])),
    [current],
  );
  const stale = bookings.some(
    (booking) =>
      bookingSnapshot(currentById.get(booking.id)) !== bookingSnapshot(booking),
  );
  const preparation = useMemo(() => {
    if (!category || stale) return { rows: [], error: null };
    try {
      const next = appStateSchema.parse(
        synchronizePlan(
          queueLedgerReview(
            assignTransactions(
              state,
              bookings.map((row) => row.id),
              { category },
            ),
          ),
        ),
      );
      return { rows: actualBookings(next), error: null };
    } catch (error) {
      if (!(error instanceof FixedPlanCapacityError)) throw error;
      return { rows: [], error: error.message };
    }
  }, [state, bookings, category, stale]);
  const preview = preparation.rows;
  const selectedIds = new Set(bookings.map((row) => row.id));
  const previewById = new Map(preview.map((row) => [row.id, row]));
  const additional = preview.filter(
    (row) =>
      !selectedIds.has(row.id) &&
      bookingSnapshot(row) !== bookingSnapshot(currentById.get(row.id)),
  );
  function save() {
    if (!category || stale || preparation.error) {
      toast.error(
        preparation.error ??
          (stale
            ? "Die Auswahl wurde inzwischen geändert. Bitte erneut auswählen."
            : "Bitte eine Kategorie auswählen."),
      );
      return;
    }
    update((latest) =>
      assignTransactions(
        latest,
        bookings.map((row) => row.id),
        { category },
      ),
    );
    toast.success(`${bookings.length} Zuordnungen übernommen`);
    onClose(true);
  }
  return (
    <PremiumDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PremiumDialogContent
        size="xl"
        variant="work"
        snapPoints={[0.92]}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <PremiumDialogHeader
          icon={ListChecks}
          title="Auswahl zuordnen"
          description={`${bookings.length} Buchungen · Vorschau vor dem Übernehmen`}
        />
        <PremiumDialogBody className="space-y-5">
          <Field
            label="Kategorie"
            hint="Bankdaten, Teilungen und Fixkostenmarkierungen bleiben erhalten. Die Zuordnung wird wie bei einer Einzelbuchung für diesen Händler gemerkt."
          >
            <CategorySelect
              label="Kategorie für Auswahl"
              allowAll
              allLabel="Kategorie wählen"
              excludeReview
              value={category}
              onValueChange={setCategory}
              disabled={!!storageError || stale}
            />
          </Field>
          {additional.length > 0 && (
            <PremiumDialogItem className="space-y-2 rounded-2xl bg-accent-muted/60 p-4 text-sm">
              <p role="status">
                Die Händlerregel ordnet außerdem {additional.length} offene
                Buchungen ein – einschließlich passender Importzeilen.
              </p>
              <details>
                <summary className="cursor-pointer text-xs font-medium text-primary">
                  Zusätzlich betroffene Buchungen
                </summary>
                <ul className="mt-2 space-y-2 text-xs">
                  {additional.map((row) => (
                    <li key={row.id} className="break-words">
                      {bookingDescription(row)} ·{" "}
                      {dateLabel(row.date)} · {currency(row.amount)} →{" "}
                      {classify(row).category}
                      {!currentById.has(row.id) && (
                        <span className="ml-1 text-muted-foreground">
                          (Importzeile)
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            </PremiumDialogItem>
          )}
          <PremiumDialogItem>
            <ul
              aria-label="Zuordnungsvorschau"
              className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70"
            >
              {bookings.map((booking) => {
                const result = previewById.get(booking.id);
                const before = classify(booking);
                return (
                  <li key={booking.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-sm">
                    <MerchantMark booking={booking} classification={before} fallbackName={bookingDescription(booking)} className="size-9 rounded-xl" />
                    <span className="min-w-0">
                      <span className="block break-words font-medium">{bookingDescription(booking)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {dateLabel(booking.date)} · {accountLabel(booking)}
                      </span>
                      <span className="mt-0.5 block text-xs">
                        <span className="text-muted-foreground">{before.category}</span> →{" "}
                        <span className={result ? "font-medium text-primary" : "text-muted-foreground"}>
                          {result ? classify(result).category : "Kategorie wählen"}
                        </span>
                      </span>
                    </span>
                    <span className="amount shrink-0 text-sm">{currency(booking.amount)}</span>
                  </li>
                );
              })}
            </ul>
          </PremiumDialogItem>
          {stale && (
            <p role="alert" className="text-sm font-medium text-destructive">
              Die Auswahl wurde inzwischen geändert. Bitte schließen und erneut
              auswählen.
            </p>
          )}
          {preparation.error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {preparation.error}
            </p>
          )}
          {storageError && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {storageError}
            </p>
          )}
        </PremiumDialogBody>
        <PremiumDialogFooter>
          <Button variant="outline" onClick={() => onClose()}>
            Abbrechen
          </Button>
          <Button
            disabled={
              !category || stale || !!preparation.error || !!storageError
            }
            onClick={save}
          >
            Zuordnungen übernehmen
          </Button>
        </PremiumDialogFooter>
      </PremiumDialogContent>
    </PremiumDialog>
  );
}
