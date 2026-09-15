"use client";

import { useMemo, useState } from "react";
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
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFinance } from "@/components/finance-provider";
import { EmptyState, PageHeading } from "@/components/finance-ui";
import { actualBookings, bookingMonth, classify, monthKey, sum } from "@/lib/calc";
import { personalAmount, reconcileSharedHoliday, type AccountedTransaction } from "@/lib/shared-holiday";
import { legacyFingerprint, statementFingerprint } from "@/lib/import/identity";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { transactionSchema, type Transaction } from "@/lib/types";
import { CategoryOptions } from "@/components/category-options";
import { cn } from "@/lib/utils";
import { StatementImport } from "@/components/statement-import";
import { ReviewCount } from "@/components/review-count";
import { rememberMerchants } from "@/lib/import/merchant-rules";
import { SharedCosts, SharedRowAction } from "@/components/shared-costs";
import { HolidayRanges } from "@/components/holiday-ranges";

const accountLabel = (row: Transaction) =>
  `${row.bank} · ${row.pocket ?? "Hauptkonto"}`;

function TransactionForm({
  transaction,
  onClose,
}: {
  transaction: Transaction;
  onClose: () => void;
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
    sourceCategory: values.sourceCategory,
    bank: values.bank,
  });
  function save(value: Transaction) {
    update((current) =>
      rememberMerchants(
        {
          ...current,
          transactions: current.transactions.map((row) =>
            row.id === transaction.id
              ? {
                  ...row,
                  category: value.category,
                  categoryOverride: true,
                  includeInPlan: true,
                }
              : row,
          ),
          ...(current.fixedReceipts
            ? {
                fixedReceipts: current.fixedReceipts.map((receipt) =>
                  receipt.key === transaction.id ||
                  receipt.key === statementFingerprint(transaction)
                    ? { ...receipt, category: value.category }
                    : receipt,
                ),
              }
            : {}),
        },
        [{ ...transaction, category: value.category, categoryOverride: true }],
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Zuordnung ändern</DialogTitle>
          <DialogDescription>
            {preview.reason || "Im Alltagsbudget berücksichtigt"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(save)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="tx-date">Datum</Label>
              <Input
                id="tx-date"
                readOnly
                type="date"
                className="mt-2"
                {...form.register("date")}
              />
              {error("date")}
            </div>
            <div>
              <Label htmlFor="tx-amount">Betrag (€)</Label>
              <Input
                id="tx-amount"
                readOnly
                type="number"
                step="0.01"
                className="mt-2"
                placeholder="−24,90"
                {...form.register("amount", { valueAsNumber: true })}
              />
              {error("amount")}
            </div>
          </div>
          <div>
            <Label htmlFor="tx-description">Beschreibung</Label>
            <Input
              id="tx-description"
              readOnly
              className="mt-2"
              placeholder="Händler oder Verwendungszweck"
              {...form.register("description")}
            />
            {error("description")}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="tx-bank">Konto/Pocket</Label>
              <Input
                id="tx-bank"
                className="mt-2"
                readOnly
                value={accountLabel(transaction)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="tx-category">Kategorie</Label>
            <select
              id="tx-category"
              className="select-input editable mt-2 w-full"
              {...form.register("category", {
                onChange: () =>
                  form.setValue("categoryOverride", true, {
                    shouldDirty: true,
                  }),
              })}
            >
              <CategoryOptions />
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit">Speichern</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Transactions() {
  "use no memo";
  const { state, dashboard, update, openReviewCount, storageError } = useFinance();
  const [reviewRequest, setReviewRequest] = useState(0);
  const ledger = useMemo(() => actualBookings(state), [state]);
  const holiday = useMemo(() => reconcileSharedHoliday(ledger, state.settings.asOf), [ledger, state.settings.asOf]);
  const [editor, setEditor] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState<Transaction | null>(null);
  const [query, setQuery] = useState("");
  const [selectedMonth, setMonth] = useState<string | null>(null);
  const month = selectedMonth ?? dashboard.currentMonth;
  const [showTransfers, setShowTransfers] = useState(false);
  const [category, setCategory] = useState("");
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
        const result = classify(row);
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
    [ledger, query, month, category, account, plan, from, to, showTransfers],
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
      accessorFn: (row) => classify(row).category,
      header: "Kategorie",
      cell: ({ getValue }) => (
        <span className="rounded-md border bg-muted/30 px-2 py-1 text-[10px]">
          {getValue<string>()}
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
            onClick={() => setEditor(row.original)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <details>
            <summary
              className="cursor-pointer text-xs"
              aria-label={`Weitere Aktionen: ${row.original.description}`}
            >
              Weitere Aktionen
            </summary>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-destructive"
              aria-label={`Löschen: ${row.original.description}`}
              onClick={() => setDeleting(row.original)}
            >
              <Trash2 className="size-3.5" />
            </Button>
            <SharedRowAction booking={row.original} />
          </details>
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
    month !== dashboard.currentMonth ||
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
                dashboard.currentMonth,
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
          <select
            aria-label="Kategorie filtern"
            className="select-input"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Alle Kategorien</option>
            <CategoryOptions />
          </select>
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
          <details>
            <summary className="cursor-pointer text-xs">Weitere Filter</summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                aria-label="Planrelevanz filtern"
                className="select-input"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
              >
                <option value="">Plan: alle</option>
                <option value="yes">Im Plan</option>
                <option value="no">Nicht im Plan</option>
              </select>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Von
                <Input
                  type="date"
                  aria-label="Datum von"
                  className="w-36"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Bis
                <Input
                  type="date"
                  aria-label="Datum bis"
                  className="w-36"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="accent-amber-400"
                  checked={showTransfers}
                  onChange={(event) => setShowTransfers(event.target.checked)}
                />
                Transfers anzeigen
              </label>
            </div>
          </details>
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
        <TransactionForm transaction={editor} onClose={() => setEditor(null)} />
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
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
}
