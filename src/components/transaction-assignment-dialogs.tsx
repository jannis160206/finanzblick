"use client";

import { useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  type Category,
  type Transaction,
} from "@/lib/types";
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
      assignTransactions(current, [transaction.id], assignment),
    );
    toast.success(
      value.category !== "Prüfen"
        ? "Zuordnung gespeichert"
        : "Prüfung bleibt offen",
    );
    onClose();
  }
  const error = (name: keyof Transaction) =>
    form.formState.errors[name]?.message && (
      <p className="mt-1 text-xs text-destructive" role="alert">
        {form.formState.errors[name]?.message}
      </p>
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Zuordnung ändern</DialogTitle>
          <DialogDescription>
            Name, Kategorie und Fixkosten ändern. Namensänderungen gelten für
            alle passenden bisherigen und künftigen Buchungen.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={form.handleSubmit(save)}>
          <DialogBody className="space-y-6">
            <section
              aria-label="Originalbuchung"
              className="rounded-xl bg-muted/50 p-4"
            >
              <p className="text-xs font-medium text-muted-foreground">
                Originalbuchung
              </p>
              <div className="mt-2 flex items-start gap-2">
                {editingName ? (
                  <Input
                    autoFocus
                    aria-label="Händlername"
                    maxLength={200}
                    value={merchantName}
                    aria-invalid={
                      nameMissing || !!form.formState.errors.merchantAlias
                    }
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
                  <p className="min-w-0 break-words text-base font-medium">
                    {merchantName}
                  </p>
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
                <p
                  id="tx-name-error"
                  className="mt-1 text-xs text-destructive"
                  role="alert"
                >
                  Bitte einen Händlernamen eingeben.
                </p>
              ) : (
                error("merchantAlias")
              )}
              <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">
                {currency(transaction.amount)}
              </p>
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Datum</dt>
                  <dd>{dateLabel(transaction.date)}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Konto/Pocket</dt>
                  <dd>{accountLabel(transaction)}</dd>
                </div>
              </dl>
            </section>
            <div className="space-y-2">
              <Label htmlFor="tx-category">Kategorie</Label>
              <CategorySelect
                id="tx-category"
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
                aria-describedby="tx-category-help"
                aria-invalid={!!form.formState.errors.category}
              />
              <p
                id="tx-category-help"
                className="text-sm leading-relaxed text-muted-foreground"
              >
                {preview.reason || "Im Alltagsbudget berücksichtigt"}
              </p>
              {error("category")}
            </div>
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
            <p className="text-xs leading-relaxed text-muted-foreground">
              „Prüfen“ lässt die Zuordnung offen.
            </p>
            {stale && (
              <p role="alert" className="text-sm text-destructive">
                Die Buchung wurde inzwischen geändert oder gelöscht. Bitte
                schließen und erneut öffnen.
              </p>
            )}
            {storageError && (
              <p role="alert" className="text-sm text-destructive">
                {storageError}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button
              type="submit"
              disabled={nameMissing || stale || !!storageError}
            >
              Zuordnung übernehmen
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        variant="work"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Auswahl zuordnen</DialogTitle>
          <DialogDescription>
            {bookings.length} Buchungen · Vorschau vor dem Übernehmen
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <CategorySelect
            label="Kategorie für Auswahl"
            allowAll
            allLabel="Kategorie wählen"
            excludeReview
            value={category}
            onValueChange={setCategory}
            disabled={!!storageError || stale}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Bankdaten, Teilungen und Fixkostenmarkierungen bleiben erhalten. Die
            Zuordnung wird wie bei einer Einzelbuchung für diesen Händler
            gemerkt.
          </p>
          {additional.length > 0 && (
            <div className="space-y-2 rounded-xl bg-muted/50 p-3 text-sm">
              <p role="status">
                Die Händlerregel ordnet außerdem {additional.length} offene
                Buchungen ein – einschließlich passender Importzeilen.
              </p>
              <details>
                <summary className="cursor-pointer text-xs font-medium">
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
            </div>
          )}
          <ul
            aria-label="Zuordnungsvorschau"
            className="divide-y rounded-xl border px-4"
          >
            {bookings.map((booking) => {
              const result = previewById.get(booking.id);
              return (
                <li key={booking.id} className="space-y-1 py-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 break-words font-medium">
                      {bookingDescription(booking)}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {currency(booking.amount)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {dateLabel(booking.date)} · {accountLabel(booking)}
                  </p>
                  <p className="text-xs">
                    {classify(booking).category} →{" "}
                    <span className="font-medium">
                      {result ? classify(result).category : "Kategorie wählen"}
                    </span>
                  </p>
                </li>
              );
            })}
          </ul>
          {stale && (
            <p role="alert" className="text-sm text-destructive">
              Die Auswahl wurde inzwischen geändert. Bitte schließen und erneut
              auswählen.
            </p>
          )}
          {preparation.error && (
            <p role="alert" className="text-sm text-destructive">
              {preparation.error}
            </p>
          )}
          {storageError && (
            <p role="alert" className="text-sm text-destructive">
              {storageError}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
