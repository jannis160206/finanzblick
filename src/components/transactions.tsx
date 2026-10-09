"use client";

import { memo, useMemo, useRef, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDownUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { StatementImport } from "@/components/statement-import";
import { MerchantLookupDialog } from "@/components/merchant-lookup-dialog";
import { shouldShowMerchantMark } from "@/components/merchant-mark";
import { MerchantMarksProvider } from "@/components/merchant-marks-provider";
import { merchantLogoName } from "@/lib/automation/merchant-mark-name";
import {
  TransactionActions,
  type LedgerAction,
} from "@/components/transaction-actions";
import {
  BatchAssignmentDialog,
  TransactionForm,
} from "@/components/transaction-assignment-dialogs";
import {
  TransactionFilters,
  emptyLedgerFilters,
} from "@/components/transaction-filters";
import {
  LedgerFooter,
  MobileLedgerControls,
  MobileTransactionList,
  SelectionCheckbox,
  TransactionAmountCell,
  TransactionCategoryCell,
  TransactionDescriptionCell,
  useMobileLedger,
} from "@/components/transaction-workspace";
import {
  actualBookings,
  bookingMonth,
  classify,
  monthKey,
  sum,
} from "@/lib/calc";
import {
  personalAmount,
  reconcileSharedHoliday,
  type AccountedTransaction,
} from "@/lib/shared-holiday";
import { legacyFingerprint, statementFingerprint } from "@/lib/import/identity";
import { currency, dateLabel } from "@/lib/format";
import type { Transaction } from "@/lib/types";
import { accountLabel } from "@/lib/accounts";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import {
  confirmMerchantAlias,
  merchantLookupQuery,
  needsMerchantLookup,
} from "@/lib/merchant-lookup";
import { lookupMerchant } from "@/lib/merchant-lookup-client";
import type { MerchantLookupResult } from "@/lib/merchant-lookup-schema";
import {
  exportTransactionsCsv,
  matchesTransactionSearch,
} from "@/lib/transaction-tools";
import { cn } from "@/lib/utils";

export function Transactions() {
  const { state, update, openReviewCount, storageError } = useFinance();
  return (
    <TransactionLedger
      state={state}
      update={update}
      openReviewCount={openReviewCount}
      storageError={storageError}
    />
  );
}

const TransactionLedger = memo(function TransactionLedger({
  state,
  update,
  openReviewCount,
  storageError,
}: Pick<
  ReturnType<typeof useFinance>,
  "state" | "update" | "openReviewCount" | "storageError"
>) {
  "use no memo";
  const [reviewRequest, setReviewRequest] = useState(0);
  const mobile = useMobileLedger();
  const ledger = useMemo(() => actualBookings(state), [state]);
  // Preserve cached classifications when only other rows receive an approval.
  const classifyBooking = useMemo(() => {
    const cache = new WeakMap<
      AccountedTransaction,
      ReturnType<typeof classify>
    >();
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
  const reviewReasons = useMemo(() => {
    const reasons = new Map<string, string>();
    const fixedKeys = new Set<string>();
    for (const item of state.reviewQueue ?? []) {
      if (item.kind === "booking") reasons.set(item.draft.id, item.message);
      else
        for (const booking of item.change.bookings) {
          reasons.set(booking.id, "Fixkostenbetrag hat sich geändert.");
          fixedKeys.add(statementFingerprint(booking));
        }
    }
    for (const row of ledger) {
      if (
        !(row.reviewed && row.categoryOverride) &&
        fixedKeys.size &&
        fixedKeys.has(statementFingerprint(row))
      )
        reasons.set(row.id, "Fixkostenbetrag hat sich geändert.");
      if (
        !reasons.has(row.id) &&
        classifications.get(row)!.category === "Prüfen"
      )
        reasons.set(row.id, "Kategorie noch offen oder widersprüchlich.");
    }
    return reasons;
  }, [state.reviewQueue, ledger, classifications]);
  const holiday = useMemo(
    () =>
      reconcileSharedHoliday(ledger, state.settings.asOf, state.plannedOneOffs),
    [ledger, state.settings.asOf, state.plannedOneOffs],
  );
  const [editor, setEditor] = useState<Transaction | null>(null);
  const [deleting, setDeleting] = useState<Transaction | null>(null);
  const [batch, setBatch] = useState<AccountedTransaction[] | null>(null);
  const [lookup, setLookup] = useState<{
    booking: Transaction;
    results: MerchantLookupResult[] | null;
  } | null>(null);
  const [lookupPending, setLookupPending] = useState(false);
  const lookupBusy = useRef(false);
  const lookupRequest = useRef(0);
  const batchTrigger = useRef<HTMLButtonElement>(null);
  const actionTrigger = useRef<{ id: string; action: LedgerAction } | null>(
    null,
  );

  function closeLookup() {
    lookupRequest.current++;
    setLookup(null);
  }
  async function startLookup(booking: Transaction) {
    if (lookupBusy.current) return;
    const query = merchantLookupQuery(booking);
    if (!query) {
      toast.error(
        "Im Banktext fehlt ein verwendbarer Händlername für die Suche.",
      );
      return;
    }
    lookupBusy.current = true;
    setLookupPending(true);
    const request = ++lookupRequest.current;
    setLookup({ booking, results: null });
    try {
      const results = await lookupMerchant(query);
      if (lookupRequest.current === request) setLookup({ booking, results });
    } catch (error) {
      if (lookupRequest.current === request) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Der Name konnte nicht nachgeschlagen werden.",
        );
        closeLookup();
      }
    } finally {
      lookupBusy.current = false;
      setLookupPending(false);
    }
  }
  function returnActionFocus() {
    const target = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-ledger-action]"),
    ].find(
      (button) =>
        button.dataset.bookingId === actionTrigger.current?.id &&
        button.dataset.ledgerAction === actionTrigger.current?.action &&
        button.getClientRects().length > 0,
    );
    if (target) target.focus();
    else
      document
        .querySelector<HTMLInputElement>('[aria-label="Umsätze durchsuchen"]')
        ?.focus();
  }
  function returnBatchFocus() {
    if (batchTrigger.current) batchTrigger.current.focus();
    else
      document
        .querySelector<HTMLInputElement>('[aria-label="Umsätze durchsuchen"]')
        ?.focus();
  }
  const [filters, setFilters] = useState(emptyLedgerFilters);
  const currentMonth = monthKey(state.settings.asOf);
  const month = filters.month ?? currentMonth;
  const [sorting, setSorting] = useState<SortingState>([
    { id: "date", desc: true },
  ]);
  const filtered = useMemo(
    () =>
      ledger.filter((row) => {
        const result = classifications.get(row)!;
        return (
          (filters.showTransfers ||
            !result.isTransfer ||
            !!row.holidayReimbursementFor) &&
          matchesTransactionSearch(row, filters.query, result.merchant) &&
          (!month || bookingMonth(row) === month) &&
          (!filters.category || result.category === filters.category) &&
          (!filters.account || accountLabel(row) === filters.account) &&
          (!filters.plan ||
            result.includeInPlan === (filters.plan === "yes")) &&
          (!filters.from || row.date >= filters.from) &&
          (!filters.to || row.date <= filters.to)
        );
      }),
    [ledger, classifications, filters, month],
  );
  const pendingCount = filtered.filter((row) =>
    reviewReasons.has(row.id),
  ).length;
  const data = useMemo(
    () =>
      filtered.filter(
        (row) =>
          filters.assignment === "all" ||
          reviewReasons.has(row.id) === (filters.assignment === "review"),
      ),
    [filtered, reviewReasons, filters.assignment],
  );
  const scope = JSON.stringify([filters, currentMonth]);
  const [selection, setSelection] = useState<{
    scope: string;
    rows: RowSelectionState;
  }>({ scope: "", rows: {} });
  const rowSelection = useMemo(
    () =>
      selection.scope === scope
        ? Object.fromEntries(
            data
              .filter((row) => selection.rows[row.id])
              .map((row) => [row.id, true]),
          )
        : {},
    [selection, scope, data],
  );
  const selected = data.filter((row) => rowSelection[row.id]);
  const columns: ColumnDef<AccountedTransaction>[] = [
    {
      id: "selection",
      enableSorting: false,
      header: () => (
        <SelectionCheckbox
          label="Buchungen dieser Seite auswählen"
          disabled={!!storageError || !data.length}
          checked={table.getIsAllPageRowsSelected()}
          mixed={table.getIsSomePageRowsSelected()}
          onChange={(checked) => table.toggleAllPageRowsSelected(checked)}
        />
      ),
      cell: ({ row }) => (
        <SelectionCheckbox
          label={`Auswählen: ${row.original.description}`}
          checked={row.getIsSelected()}
          disabled={!!storageError}
          onChange={(checked) => row.toggleSelected(checked)}
        />
      ),
    },
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
      id: "description",
      accessorFn: (row) => row.merchantAlias ?? row.description,
      header: "Beschreibung",
      cell: ({ row }) => (
        <TransactionDescriptionCell
          booking={row.original}
          classification={classifications.get(row.original)!}
        />
      ),
    },
    {
      id: "category",
      accessorFn: (row) => classifications.get(row)!.category,
      header: "Kategorie",
      cell: ({ row }) => {
        const result = classifications.get(row.original)!;
        return (
          <TransactionCategoryCell
            booking={row.original}
            category={result.category}
            fixed={result.isFixedCost}
            reason={reviewReasons.get(row.original.id)}
            explanation={
              result.reason ||
              (result.includeInPlan
                ? "Im Alltagsbudget berücksichtigt"
                : "Außerhalb des Alltagsbudgets")
            }
          />
        );
      },
    },
    {
      id: "amount",
      accessorFn: (row) =>
        row.sharedWithRaphael ? personalAmount(row) : row.amount,
      header: "Betrag",
      cell: ({ getValue, row }) => (
        <TransactionAmountCell
          amount={getValue<number>()}
          items={holiday.receivables.filter(
            (item) => item.bookingId === row.original.id,
          )}
          reimbursement={!!row.original.holidayReimbursementFor}
        />
      ),
    },
    {
      id: "account",
      accessorFn: accountLabel,
      header: "Konto/Pocket",
      cell: ({ row }) => (
        <span className="text-xs break-words text-muted-foreground">
          {accountLabel(row.original)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Aktionen",
      enableSorting: false,
      cell: ({ row }) => (
        <TransactionActions
          booking={row.original}
          disabled={!!storageError}
          lookupPending={lookupPending}
          dialogOpen={!!editor || !!deleting}
          onTrigger={(id, action) => {
            actionTrigger.current = { id, action };
          }}
          onEdit={() => setEditor(row.original)}
          onLookup={() => {
            void startLookup(row.original);
          }}
          onDelete={() => setDeleting(row.original)}
        />
      ),
    },
  ];
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack state stays outside compiler memoization.
  const table = useReactTable({
    data,
    columns,
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: (updater) =>
      setSelection({
        scope,
        rows: typeof updater === "function" ? updater(rowSelection) : updater,
      }),
    enableRowSelection: !storageError,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
    getRowId: (row) => row.id,
  });
  const displayedRows = table.getRowModel().rows;
  const merchantIds = displayedRows.flatMap(({ original }) =>
    original.merchantId &&
    shouldShowMerchantMark(original, classifications.get(original)!)
      ? [original.merchantId]
      : [],
  );
  const merchantNames = displayedRows.flatMap(({ original }) => {
    const name = merchantLogoName(original);
    return name &&
      shouldShowMerchantMark(original, classifications.get(original)!)
      ? [name]
      : [];
  });
  function exportView() {
    const rows = table
      .getPrePaginationRowModel()
      .rows.map((row) => row.original);
    if (!rows.length) {
      toast.error("Für diese Ansicht gibt es keine Buchungen zum Exportieren.");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([exportTransactionsCsv(rows)], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `Finanzblick_Umsaetze_${month || "alle"}_${state.settings.asOf}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast.success(`${rows.length} gefilterte Buchungen exportiert`);
  }
  return (
    <>
      <PageHeading
        eyebrow="BUCHUNGEN"
        title="Umsätze"
        description={`${ledger.length.toLocaleString("de-AT")} Buchungen`}
      />
      <StatementImport reviewRequest={reviewRequest} />
      <section
        aria-label="Umsatzliste"
        className="min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
      >
        <TransactionFilters
          filters={filters}
          setFilters={(updater) => {
            setSelection({ scope: "", rows: {} });
            setFilters(updater);
          }}
          currentMonth={currentMonth}
          ledger={ledger}
          receivables={holiday.receivables}
          count={filtered.length}
          pending={pendingCount}
          reviewCount={openReviewCount}
          disabled={!!storageError}
          exportDisabled={!data.length}
          onReview={() => setReviewRequest((request) => request + 1)}
          onExport={exportView}
        />
        {selected.length > 0 && (
          <div
            role="group"
            aria-label="Ausgewählte Buchungen"
            className="flex flex-wrap items-center gap-2 border-b border-primary/15 bg-primary/5 px-4 py-3 sm:px-5"
          >
            <span role="status" className="mr-auto text-sm font-medium">
              {selected.length} ausgewählt
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelection({ scope, rows: {} })}
            >
              Auswahl aufheben
            </Button>
            <Button
              ref={batchTrigger}
              size="sm"
              disabled={!!storageError}
              onClick={() => setBatch(selected)}
            >
              Auswahl zuordnen
            </Button>
          </div>
        )}
        <MerchantMarksProvider
          merchantIds={merchantIds}
          merchantNames={merchantNames}
        >
          {mobile ? (
            <>
              <MobileLedgerControls table={table} disabled={!!storageError} />
              <MobileTransactionList rows={displayedRows} />
            </>
          ) : (
            <div className="hidden overflow-x-auto md:block">
              <table className="data-table w-full" aria-label="Buchungen">
                <thead>
                  {table.getHeaderGroups().map((group) => (
                    <tr key={group.id}>
                      {group.headers.map((header) => (
                        <th
                          key={header.id}
                          className={cn(
                            header.column.id === "selection" &&
                              "w-12 !px-1 !py-1",
                            (header.column.id === "amount" ||
                              header.column.id === "actions") &&
                              "text-right",
                          )}
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
                              className={cn(
                                "flex min-h-8 items-center gap-1.5 whitespace-nowrap hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                                header.column.id === "amount" && "ml-auto",
                              )}
                              onClick={header.column.getToggleSortingHandler()}
                            >
                              {flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )}
                              <ArrowDownUp
                                className={cn(
                                  "size-3",
                                  header.column.getIsSorted()
                                    ? "text-primary"
                                    : "opacity-40",
                                )}
                              />
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
                  {displayedRows.map((row) => (
                    <tr
                      key={row.id}
                      className={
                        row.getIsSelected() ? "bg-primary/5" : undefined
                      }
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={
                            cell.column.id === "selection"
                              ? "!px-1 !py-1"
                              : undefined
                          }
                        >
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
          )}
        </MerchantMarksProvider>
        {!data.length && (
          <EmptyState
            title="Keine Umsätze gefunden"
            description={
              ledger.length
                ? "Filter anpassen oder Kontoauszüge importieren."
                : "Kontoauszüge oben ablegen."
            }
          />
        )}
        <LedgerFooter
          table={table}
          count={data.length}
          total={sum(data.map(personalAmount))}
        />
      </section>
      {editor && (
        <TransactionForm
          transaction={editor}
          onClose={() => setEditor(null)}
          returnFocus={returnActionFocus}
        />
      )}
      {batch && (
        <BatchAssignmentDialog
          bookings={batch}
          returnFocus={returnBatchFocus}
          onClose={(saved) => {
            setBatch(null);
            if (saved) setSelection({ scope, rows: {} });
          }}
        />
      )}
      {lookup && (
        <MerchantLookupDialog
          key={lookup.booking.id}
          results={lookup.results}
          onClose={closeLookup}
          returnFocus={returnActionFocus}
          disabled={!!storageError}
          onConfirm={(result) => {
            const current = ledger.find((row) => row.id === lookup.booking.id);
            if (
              !current ||
              !needsMerchantLookup(current) ||
              current.merchantAlias !== lookup.booking.merchantAlias ||
              merchantRuleKey(current) !== merchantRuleKey(lookup.booking)
            ) {
              toast.error(
                "Die Buchung wurde inzwischen geändert. Bitte erneut öffnen.",
              );
              closeLookup();
              return;
            }
            update((state) =>
              confirmMerchantAlias(state, lookup.booking, result),
            );
            closeLookup();
            toast.success("Händlername übernommen");
          }}
        />
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent
          variant="confirmation"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnActionFocus();
          }}
        >
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
              disabled={!!storageError}
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
