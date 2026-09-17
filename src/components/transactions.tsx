"use client";

import { memo, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
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
import { useFinance } from "@/components/finance-provider";
import { EmptyState, PageHeading } from "@/components/finance-ui";
import { actualBookings, bookingMonth, classify, monthKey, sum } from "@/lib/calc";
import { personalAmount, reconcileSharedHoliday, type AccountedTransaction } from "@/lib/shared-holiday";
import { legacyFingerprint, statementFingerprint } from "@/lib/import/identity";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { transactionSchema, type Category, type Transaction } from "@/lib/types";
import { CategorySelect } from "@/components/category-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { StatementImport } from "@/components/statement-import";
import { ReviewCount } from "@/components/review-count";
import { rememberMerchants } from "@/lib/import/merchant-rules";
import { SharedCosts, SharedRowAction } from "@/components/shared-costs";
import { HolidayRanges } from "@/components/holiday-ranges";
import { FixedCostChoice } from "@/components/fixed-cost-choice";
import { isIncomeCategory } from "@/lib/fixed";

const accountLabel = (row: Transaction) =>
  `${row.bank} · ${row.pocket ?? "Hauptkonto"}`;

function TransactionForm({
  transaction,
  onClose,
  returnFocus,
}: {
  transaction: Transaction;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const { update } = useFinance();
  const form = useForm<Transaction>({
    resolver: zodResolver(transactionSchema),
    defaultValues: transaction,
  });
  const values = useWatch({ control: form.control });
  const preview = classify({
    description: values.description ?? "",
    amount: values.amount ?? 0,
    category: values.category ?? "Sonstiges",
    pocket: values.pocket ?? null,
    includeInPlan: values.includeInPlan ?? true,
    categoryOverride: values.categoryOverride,
    fixedCost: values.fixedCost,
    sourceCategory: values.sourceCategory,
    bank: values.bank,
  });
  const canMarkFixed = transaction.amount < 0 && !preview.isTransfer && !isIncomeCategory(preview.category);
  function save(value: Transaction) {
    const assignment = {
      category: value.category,
      categoryOverride: true,
      includeInPlan: true,
      ...(value.fixedCost !== undefined ? { fixedCost: canMarkFixed && value.fixedCost } : {}),
    };
    update((current) =>
      rememberMerchants(
        {
          ...current,
          transactions: current.transactions.map((row) =>
            row.id === transaction.id
              ? {
                  ...row,
                  ...assignment,
                  includeInPlan: classify({ ...row, ...assignment }).includeInPlan,
                }
              : row,
          ),
          ...(current.fixedReceipts
            ? {
                fixedReceipts: current.fixedReceipts.map((receipt) =>
                  receipt.key === transaction.id ||
                  receipt.key === statementFingerprint(transaction)
                    ? {
                        ...receipt,
                        category: value.category,
                        booking: {
                          ...(receipt.booking ?? transaction),
                          ...assignment,
                          includeInPlan: classify({ ...(receipt.booking ?? transaction), ...assignment }).includeInPlan,
                        },
                      }
                    : receipt,
                ),
              }
            : {}),
        },
        [{ ...transaction, ...assignment }],
      ),
    );
    toast.success("Umsatz aktualisiert");
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
      <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus(); }}>
        <DialogHeader>
          <DialogTitle>Zuordnung ändern</DialogTitle>
          <DialogDescription>
            Ändere Kategorie und Fixkosten-Markierung. Die ursprüngliche Bankbuchung bleibt unverändert.
          </DialogDescription>
        </DialogHeader>
        <DialogForm onSubmit={form.handleSubmit(save)}>
          <DialogBody className="space-y-6">
          <section aria-label="Originalbuchung" className="rounded-xl bg-muted/50 p-4">
            <p className="text-xs font-medium text-muted-foreground">Originalbuchung</p>
            <p className="mt-2 break-words text-base font-medium">{transaction.description}</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{currency(transaction.amount)}</p>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Datum</dt><dd>{dateLabel(transaction.date)}</dd></div>
              <div className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">Konto/Pocket</dt><dd>{accountLabel(transaction)}</dd></div>
            </dl>
          </section>
          <div className="space-y-2">
            <Label htmlFor="tx-category">Kategorie</Label>
            <CategorySelect
              id="tx-category"
              label="Kategorie"
              value={values.category ?? transaction.category}
              onValueChange={(category) => {
                form.setValue("category", category, { shouldDirty: true, shouldValidate: true });
                form.setValue("categoryOverride", true, { shouldDirty: true });
              }}
              aria-describedby="tx-category-help"
              aria-invalid={!!form.formState.errors.category}
            />
            <p id="tx-category-help" className="text-sm leading-relaxed text-muted-foreground">{preview.reason || "Im Alltagsbudget berücksichtigt"}</p>
            {error("category")}
          </div>
          <FixedCostChoice
            checked={values.fixedCost ?? preview.isFixedCost}
            onChange={(checked) => form.setValue("fixedCost", checked, { shouldDirty: true, shouldValidate: true })}
            eligible={canMarkFixed}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">Die Zuordnung wird auch für spätere Buchungen dieses Händlers gelernt. Nicht gespeicherte Änderungen werden beim Schließen verworfen.</p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit">Zuordnung übernehmen</Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

export function Transactions() {
  const { state, update, openReviewCount, storageError } = useFinance();
  return <TransactionLedger state={state} update={update} openReviewCount={openReviewCount} storageError={storageError} />;
}

const TransactionLedger = memo(function TransactionLedger({
  state, update, openReviewCount, storageError,
}: Pick<ReturnType<typeof useFinance>, "state" | "update" | "openReviewCount" | "storageError">) {
  "use no memo";
  const [reviewRequest, setReviewRequest] = useState(0);
  const ledger = useMemo(() => actualBookings(state), [state]);
  // General updates validate/clone the ledger. Category approvals retain only
  // unchanged bank rows, so their derived classifications remain reusable.
  const classifyBooking = useMemo(() => {
    const cache = new WeakMap<AccountedTransaction, ReturnType<typeof classify>>();
    return (row: AccountedTransaction) => {
      let result = cache.get(row);
      if (!result) {
        result = classify(row);
        cache.set(row, result);
      }
      return result;
    };
  }, []);
  const classifications = useMemo(
    () => new Map(ledger.map((row) => [row, classifyBooking(row)])),
    [ledger, classifyBooking],
  );
  const holiday = useMemo(() => reconcileSharedHoliday(ledger, state.settings.asOf), [ledger, state.settings.asOf]);
  const [editor, setEditor] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState<Transaction | null>(null);
  const actionTrigger = useRef<{ id: string; action: "edit" | "menu" } | null>(null);
  function returnActionFocus() {
    // Table cells can remount while a dialog is open; resolve the current button.
    const target = [...document.querySelectorAll<HTMLButtonElement>("[data-ledger-action]")]
      .find((button) => button.dataset.bookingId === actionTrigger.current?.id &&
        button.dataset.ledgerAction === actionTrigger.current?.action);
    if (target) target.focus();
    else document.querySelector<HTMLSelectElement>('[aria-label="Kategorie filtern"]')?.focus();
  }
  const [query, setQuery] = useState("");
  const [selectedMonth, setMonth] = useState<string | null>(null);
  const currentMonth = monthKey(state.settings.asOf);
  const month = selectedMonth ?? currentMonth;
  const [showTransfers, setShowTransfers] = useState(false);
  const [category, setCategory] = useState<Category | "">("");
  const [account, setAccount] = useState("");
  const [plan, setPlan] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "date", desc: true },
  ]);
  const data = useMemo(
    () =>
      ledger.filter((row) => {
        const result = classifications.get(row)!;
        return (
          (showTransfers || !result.isTransfer || !!row.holidayReimbursementFor) &&
          (!query ||
            `${row.description} ${row.bank} ${result.merchant}`
              .toLocaleLowerCase("de")
              .includes(query.toLocaleLowerCase("de"))) &&
          (!month || bookingMonth(row) === month) &&
          (!category || result.category === category) &&
          (!account || accountLabel(row) === account) &&
          (!plan || result.includeInPlan === (plan === "yes")) &&
          (!from || row.date >= from) &&
          (!to || row.date <= to)
        );
      }),
    [ledger, classifications, query, month, category, account, plan, from, to, showTransfers],
  );
  const columns: ColumnDef<AccountedTransaction>[] = [
    {
      accessorKey: "date",
      header: "Datum",
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {dateLabel(row.original.date)}
        </span>
      ),
    },
    {
      accessorKey: "description",
      header: "Beschreibung",
      cell: ({ getValue }) => (
        <span
          className="block max-w-[300px] truncate font-medium"
          title={getValue<string>()}
        >
          {getValue<string>()}
        </span>
      ),
    },
    {
      id: "category",
      accessorFn: (row) => classifications.get(row)!.category,
      header: "Kategorie",
      cell: ({ getValue, row }) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="rounded-md border bg-muted/30 px-2 py-1 text-[10px]">{getValue<string>()}</span>
          {row.original.fixedCost && classifications.get(row.original)!.isFixedCost &&
            <span className="rounded-md bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">Fixkosten</span>}
        </span>
      ),
    },
    {
      id: "amount",
      accessorFn: (row) => row.sharedWithRaphael ? personalAmount(row) : row.amount,
      header: "Betrag",
      cell: ({ getValue, row }) => (
        <span
          className={cn(
            "block text-right font-mono font-medium whitespace-nowrap",
            getValue<number>() > 0 ? "text-primary" : "text-foreground",
          )}
        >
          {currency(getValue<number>())}
          {holiday.receivables.filter((item) => item.bookingId === row.original.id).map((item) => (
            <span key={item.bookingId} className="mt-1 block font-sans text-[10px] font-normal text-muted-foreground">
              Gesamt {currency(item.fullAmount)} · Meine Hälfte · {item.status}
            </span>
          ))}
          {row.original.holidayReimbursementFor && <span className="mt-1 block font-sans text-[10px] font-normal text-muted-foreground">Geteilt bezahlt · kein Einkommen</span>}
        </span>
      ),
    },
    {
      id: "account",
      accessorFn: accountLabel,
      header: "Konto/Pocket",
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <span className="mr-2 text-xs">{accountLabel(row.original)}</span>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`Zuordnung ändern: ${row.original.description}`}
            data-ledger-action="edit"
            data-booking-id={row.original.id}
            onClick={() => { actionTrigger.current = { id: row.original.id, action: "edit" }; setEditor(row.original); }}
          >
            <Pencil className="size-3.5" />
          </Button>
          <SharedRowAction booking={row.original} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-8"
                aria-label={`Weitere Aktionen: ${row.original.description}`}
                data-ledger-action="menu"
                data-booking-id={row.original.id}
                onFocus={() => { actionTrigger.current = { id: row.original.id, action: "menu" }; }}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent onCloseAutoFocus={(event) => {
              if (editor || deleting) event.preventDefault();
            }}>
              <DropdownMenuItem onSelect={() => {
                actionTrigger.current = { id: row.original.id, action: "menu" };
                setEditor(row.original);
              }}>
                <Pencil />Zuordnung ändern
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem aria-label={`Löschen: ${row.original.description}`}
                className="text-destructive data-[highlighted]:bg-destructive/10"
                onSelect={() => {
                  actionTrigger.current = { id: row.original.id, action: "menu" };
                  setDeleting(row.original);
                }}>
                <Trash2 />Löschen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];
  // eslint-disable-next-line react-hooks/incompatible-library -- Table state is intentionally excluded from compiler memoization.
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
    getRowId: (row) => row.id,
  });
  const filtersActive =
    query ||
    month !== currentMonth ||
    category ||
    account ||
    plan ||
    from ||
    to ||
    showTransfers;
  return (
    <>
      <PageHeading
        eyebrow="BUCHUNGEN"
        title="Umsätze"
        description={`${ledger.length.toLocaleString("de-AT")} Buchungen · Alle Konten an einem Ort`}
      />
      <StatementImport reviewRequest={reviewRequest} />
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b p-4">
          <Button
            variant="ghost"
            size="icon"
            className="relative mr-2 size-9 shrink-0"
            aria-label="Zuordnung prüfen"
            title="Zuordnung prüfen"
            disabled={!!storageError}
            onClick={() => setReviewRequest((request) => request + 1)}
          >
            <ListChecks className="size-4" />
            <ReviewCount count={openReviewCount} className="absolute -top-2 -right-2" />
          </Button>
          <SharedCosts bookings={ledger} items={holiday.receivables} />
          <HolidayRanges />
          <div className="relative min-w-52 flex-1">
            <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Input
              aria-label="Umsätze durchsuchen"
              className="pl-9"
              placeholder="Händler, Beschreibung, Bank …"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select
            aria-label="Monat filtern"
            className="select-input"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          >
            <option value="">Alle Monate</option>
            {[
              ...new Set([
                currentMonth,
                ...ledger.map(bookingMonth),
                ...ledger.map((row) => monthKey(row.date)),
              ]),
            ]
              .sort()
              .reverse()
              .map((key) => (
                <option key={key} value={key}>
                  {monthLabel(key, true)}
                </option>
              ))}
          </select>
          <CategorySelect
            label="Kategorie filtern"
            allowAll
            value={category}
            onValueChange={setCategory}
          />
          <select
            aria-label="Konto/Pocket filtern"
            className="select-input"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="">Alle Konten/Pockets</option>
            {[...new Set(ledger.map(accountLabel))].sort().map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline"><SlidersHorizontal className="size-4" />Weitere Filter{(plan || from || to || showTransfers) && <span className="size-2 rounded-full bg-primary" aria-label="Zusätzliche Filter aktiv" />}</Button>
            </PopoverTrigger>
            <PopoverContent aria-label="Weitere Filter" className="max-h-[var(--radix-popover-content-available-height)] space-y-4 overflow-y-auto">
              <p className="text-sm font-semibold">Umsätze eingrenzen</p>
              <label className="block space-y-2 text-sm">
                <span>Planrelevanz</span>
              <select
                aria-label="Planrelevanz filtern"
                className="select-input w-full"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
              >
                <option value="">Plan: alle</option>
                <option value="yes">Im Plan</option>
                <option value="no">Nicht im Plan</option>
              </select>
              </label>
              <label className="block space-y-2 text-sm">
                Von
                <Input
                  type="date"
                  aria-label="Datum von"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className="block space-y-2 text-sm">
                Bis
                <Input
                  type="date"
                  aria-label="Datum bis"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <label className="flex min-h-11 items-center gap-3 border-t pt-3 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={showTransfers}
                  onChange={(event) => setShowTransfers(event.target.checked)}
                />
                Transfers anzeigen
              </label>
            </PopoverContent>
          </Popover>
          {filtersActive && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQuery("");
                setMonth(null);
                setShowTransfers(false);
                setCategory("");
                setAccount("");
                setPlan("");
                setFrom("");
                setTo("");
              }}
            >
              <X className="size-3" />
              Zurücksetzen
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => (
                    <th
                      key={header.id}
                      aria-sort={
                        header.column.getIsSorted() === "asc"
                          ? "ascending"
                          : header.column.getIsSorted() === "desc"
                            ? "descending"
                            : undefined
                      }
                    >
                      {header.column.getCanSort() ? (
                        <button
                          className="flex items-center gap-1.5 whitespace-nowrap hover:text-foreground"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          <ArrowDownUp className="size-3 opacity-40" />
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.length && (
          <EmptyState
            title="Keine Umsätze gefunden"
            description={
              state.transactions.length
                ? "Filter ändern oder weitere Kontoauszüge importieren."
                : "Kontoauszüge oben ablegen oder Dateien auswählen."
            }
          />
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs">
          <div className="flex gap-4 text-muted-foreground">
            <span>{data.length} Treffer</span>
            <span>
              Summe{" "}
              <strong className="ml-1 font-mono font-medium text-foreground">
                {currency(sum(data.map(personalAmount)))}
              </strong>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground">
              Seite {table.getState().pagination.pageIndex + 1} /{" "}
              {Math.max(1, table.getPageCount())}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
              aria-label="Vorherige Seite"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
              aria-label="Nächste Seite"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </section>
      {editor && (
        <TransactionForm transaction={editor} onClose={() => setEditor(null)} returnFocus={returnActionFocus} />
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent variant="confirmation" onCloseAutoFocus={(event) => { event.preventDefault(); returnActionFocus(); }}>
          <DialogHeader>
            <DialogTitle>Umsatz löschen?</DialogTitle>
            <DialogDescription>
              {deleting?.description} · {deleting && currency(deleting.amount)}.
              Diese Buchung wird aus allen Berechnungen entfernt.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleting) return;
                const removed = deleting;
                const stored = state.transactions.some(
                  (row) => row.id === removed.id,
                );
                const keys = new Set([
                  removed.id,
                  statementFingerprint(removed),
                  legacyFingerprint(removed),
                ]);
                const receipts =
                  state.fixedReceipts?.filter((item) => keys.has(item.key)) ??
                  [];
                update((current) => ({
                  ...current,
                  transactions: current.transactions.filter(
                    (row) => row.id !== removed.id,
                  ),
                  ...(current.fixedReceipts
                    ? {
                        fixedReceipts: current.fixedReceipts.filter(
                          (item) => !keys.has(item.key),
                        ),
                      }
                    : {}),
                }));
                setDeleting(null);
                toast("Umsatz gelöscht", {
                  action: {
                    label: "Rückgängig",
                    onClick: () =>
                      update((current) => ({
                        ...current,
                        transactions: stored
                          ? [...current.transactions, removed]
                          : current.transactions,
                        ...(receipts.length
                          ? {
                              fixedReceipts: [
                                ...(current.fixedReceipts ?? []),
                                ...receipts,
                              ],
                            }
                          : {}),
                      })),
                  },
                });
              }}
            >
              Endgültig löschen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
