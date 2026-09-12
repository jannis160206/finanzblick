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
import { classify, monthKey, sum } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import {
  categories,
  pocketNames,
  transactionSchema,
  type Transaction,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { StatementImport } from "@/components/statement-import";

function availablePockets(transactions: Transaction[]) {
  return [
    ...new Set([
      ...pocketNames,
      ...transactions.flatMap((row) => (row.pocket ? [row.pocket] : [])),
    ]),
  ].sort();
}

function TransactionForm({
  transaction,
  onClose,
}: {
  transaction: Transaction;
  onClose: () => void;
}) {
  const { state, update } = useFinance();
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
    update((current) => ({
      ...current,
      transactions: current.transactions.map((row) =>
        row.id === transaction.id ? value : row,
      ),
    }));
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
          <DialogTitle>Umsatz bearbeiten</DialogTitle>
          <DialogDescription>
            Ausgaben negativ, Einnahmen positiv. Gelbe Felder sind editierbar.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(save)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="tx-date">Datum</Label>
              <Input
                id="tx-date"
                type="date"
                className="editable mt-2"
                {...form.register("date")}
              />
              {error("date")}
            </div>
            <div>
              <Label htmlFor="tx-amount">Betrag (€)</Label>
              <Input
                id="tx-amount"
                type="number"
                step="0.01"
                className="editable mt-2"
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
              autoFocus
              className="editable mt-2"
              placeholder="Händler oder Verwendungszweck"
              {...form.register("description")}
            />
            {error("description")}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="tx-bank">Bank</Label>
              <Input
                id="tx-bank"
                className="editable mt-2"
                list="banks"
                {...form.register("bank")}
              />
              <datalist id="banks">
                {[
                  ...new Set([
                    "N26",
                    "Trade Republic",
                    "Bargeld",
                    ...state.transactions.map((row) => row.bank),
                  ]),
                ].map((bank) => (
                  <option key={bank} value={bank} />
                ))}
              </datalist>
              {error("bank")}
            </div>
            <div>
              <Label htmlFor="tx-pocket">Pocket</Label>
              <select
                id="tx-pocket"
                className="select-input editable mt-2 w-full"
                {...form.register("pocket", {
                  setValueAs: (value) => value || null,
                })}
              >
                <option value="">Hauptkonto</option>
                {availablePockets(state.transactions).map((pocket) => (
                  <option key={pocket}>{pocket}</option>
                ))}
              </select>
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
              {categories.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-amber-400"
              {...form.register("includeInPlan")}
            />
            Im variablen Plan berücksichtigen
          </label>
          <div className="rounded-lg border bg-muted/40 p-3 text-xs">
            <p className="mb-1 text-muted-foreground">Automatische Zuordnung</p>
            <p className="font-medium">
              {preview.category}
              {preview.pocket ? ` → ${preview.pocket}` : ""}
              <span className="ml-2 font-normal text-muted-foreground">
                {preview.reason || "Planrelevant"}
              </span>
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit">Umsatz speichern</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Transactions() {
  "use no memo";
  const { state, dashboard, update } = useFinance();
  const [editor, setEditor] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState<Transaction | null>(null);
  const [query, setQuery] = useState("");
  const [selectedMonth, setMonth] = useState<string | null>(null);
  const month = selectedMonth ?? dashboard.currentMonth;
  const [showTransfers, setShowTransfers] = useState(false);
  const [category, setCategory] = useState("");
  const [bank, setBank] = useState("");
  const [pocket, setPocket] = useState("");
  const [plan, setPlan] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "date", desc: true },
  ]);
  const data = useMemo(
    () =>
      state.transactions.filter((row) => {
        const result = classify(row);
        return (
          (showTransfers || !result.isTransfer) &&
          (!query ||
            `${row.description} ${row.bank} ${result.merchant}`
              .toLocaleLowerCase("de")
              .includes(query.toLocaleLowerCase("de"))) &&
          (!month || monthKey(row.date) === month) &&
          (!category || result.category === category) &&
          (!bank || row.bank === bank) &&
          (!pocket || (row.pocket ?? "Hauptkonto") === pocket) &&
          (!plan || result.includeInPlan === (plan === "yes")) &&
          (!from || row.date >= from) &&
          (!to || row.date <= to)
        );
      }),
    [
      state.transactions,
      query,
      month,
      category,
      bank,
      pocket,
      plan,
      from,
      to,
      showTransfers,
    ],
  );
  const columns: ColumnDef<Transaction>[] = [
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
      accessorKey: "bank",
      header: "Bank",
      cell: ({ getValue }) => (
        <span className="text-xs text-muted-foreground">
          {getValue<string>()}
        </span>
      ),
    },
    {
      id: "pocket",
      accessorFn: (row) => row.pocket ?? "Hauptkonto",
      header: "Pocket",
      cell: ({ getValue }) => (
        <span className="whitespace-nowrap text-xs">{getValue<string>()}</span>
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
      accessorKey: "amount",
      header: "Betrag",
      cell: ({ getValue }) => (
        <span
          className={cn(
            "block text-right font-mono font-medium whitespace-nowrap",
            getValue<number>() > 0 ? "text-primary" : "text-foreground",
          )}
        >
          {currency(getValue<number>())}
        </span>
      ),
    },
    {
      id: "month",
      accessorFn: (row) => monthKey(row.date),
      header: "Monat",
      cell: ({ getValue }) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {monthLabel(getValue<string>(), true)}
        </span>
      ),
    },
    {
      id: "planCategory",
      accessorFn: (row) => classify(row).planCategory,
      header: "Plan-Kat",
      cell: ({ getValue }) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {getValue<string>()}
        </span>
      ),
    },
    {
      id: "plan",
      accessorFn: (row) => classify(row).includeInPlan,
      header: "Im Plan",
      cell: ({ row }) => {
        const result = classify(row.original);
        return (
          <span
            title={
              result.reason ||
              "Für Durchschnitt zugelassen; mindestens zwei historische Monate erforderlich"
            }
            className={cn(
              "text-xs",
              result.includeInPlan ? "text-primary" : "text-muted-foreground",
            )}
          >
            {result.includeInPlan ? "Ja" : "Nein"}
          </span>
        );
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`Bearbeiten: ${row.original.description}`}
            onClick={() => setEditor(row.original)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label={`Löschen: ${row.original.description}`}
            onClick={() => setDeleting(row.original)}
          >
            <Trash2 className="size-3.5" />
          </Button>
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
    bank ||
    pocket ||
    plan ||
    from ||
    to ||
    showTransfers;
  return (
    <>
      <PageHeading
        eyebrow="BUCHUNGEN"
        title="Umsätze"
        description={`${state.transactions.length.toLocaleString("de-AT")} Buchungen · Alle Konten an einem Ort`}
      />
      <StatementImport />
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b p-4">
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
                ...state.transactions.map((row) => monthKey(row.date)),
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
            {categories.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            aria-label="Bank filtern"
            className="select-input"
            value={bank}
            onChange={(e) => setBank(e.target.value)}
          >
            <option value="">Alle Banken</option>
            {[...new Set(state.transactions.map((row) => row.bank))]
              .sort()
              .map((value) => (
                <option key={value}>{value}</option>
              ))}
          </select>
          <select
            aria-label="Pocket filtern"
            className="select-input"
            value={pocket}
            onChange={(e) => setPocket(e.target.value)}
          >
            <option value="">Alle Pockets</option>
            {["Hauptkonto", ...availablePockets(state.transactions)].map(
              (value) => (
                <option key={value}>{value}</option>
              ),
            )}
          </select>
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
          {filtersActive && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQuery("");
                setMonth(null);
                setShowTransfers(false);
                setCategory("");
                setBank("");
                setPocket("");
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
                {currency(sum(data.map((row) => row.amount)))}
              </strong>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <select
              className="select-input h-8"
              aria-label="Zeilen pro Seite"
              value={table.getState().pagination.pageSize}
              onChange={(e) => table.setPageSize(Number(e.target.value))}
            >
              {[25, 50, 100].map((value) => (
                <option key={value} value={value}>
                  {value} Zeilen
                </option>
              ))}
            </select>
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
                update((current) => ({
                  ...current,
                  transactions: current.transactions.filter(
                    (row) => row.id !== removed.id,
                  ),
                }));
                setDeleting(null);
                toast("Umsatz gelöscht", {
                  action: {
                    label: "Rückgängig",
                    onClick: () =>
                      update((current) => ({
                        ...current,
                        transactions: [...current.transactions, removed],
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
