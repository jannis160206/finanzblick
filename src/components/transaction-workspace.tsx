"use client";

import { useId, useState, type ReactNode } from "react";
import { flexRender, type Row, type Table } from "@tanstack/react-table";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  EyeOff,
  ListFilter,
  Repeat,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MerchantMark } from "@/components/merchant-mark";
import {
  PremiumDialog,
  PremiumDialogBody,
  PremiumDialogClose,
  PremiumDialogContent,
  PremiumDialogHeader,
  PremiumDialogItem,
  PremiumDialogTrigger,
} from "@/components/ui/premium-dialog";
import { currency, dateLabel } from "@/lib/format";
import { bookingDescription } from "@/lib/import/merchant-description";
import { cleanMerchantName } from "@/lib/merchant-display";
import type { classify } from "@/lib/calc";
import type { Category } from "@/lib/types";
import type { CategoryExplanation } from "@/lib/category-why";
import type {
  AccountedTransaction,
  HolidayReceivable,
} from "@/lib/shared-holiday";
import { cn } from "@/lib/utils";
import { FinancialData } from "@/components/financial-data";
import { useSecurityMode } from "@/components/security-mode-provider";
import { hasManualCategory } from "@/lib/manual-category";
import { categoryTone } from "@/components/category-tone";

export type FilterChip = { id: string; label: string; remove: () => void };

export { useCompactLayout as useMobileLedger } from "@/components/ui/use-compact-layout";

export function TransactionToolbar({
  search,
  filters,
  actions,
  chips,
}: {
  search: ReactNode;
  filters: ReactNode;
  actions: ReactNode;
  chips: FilterChip[];
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  return (
    <div
      role="group"
      aria-label="Umsatz-Werkzeugleiste"
      className="space-y-3 border-b border-border/70 p-4 sm:p-5"
    >
      <div className="grid items-center gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">{search}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={filtersOpen ? "secondary" : "outline"}
            className="h-11 gap-2 md:hidden"
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <ListFilter className="size-4" aria-hidden="true" />
            Filter
            {chips.length > 0 && (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-2xs leading-5 font-semibold text-primary-foreground tabular-nums">
                {chips.length}
              </span>
            )}
          </Button>
          {actions}
        </div>
      </div>
      <div id={filtersId} className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-3", !filtersOpen && "max-md:hidden")}>{filters}</div>
      {chips.length > 0 && (
        <FinancialData
          role="group"
          aria-label="Aktive Filter"
          className="flex flex-wrap gap-2"
        >
          {chips.map((chip) => (
            <Button
              key={chip.id}
              type="button"
              size="sm"
              variant="soft"
              className="h-auto min-h-8 max-w-full rounded-full py-1 pr-2 pl-3 text-xs hover:translate-y-0 hover:shadow-none"
              aria-label={`Filter entfernen: ${chip.label}`}
              onClick={chip.remove}
            >
              <span className="min-w-0 truncate">{chip.label}</span>
              <X className="size-3.5 opacity-70" aria-hidden="true" />
            </Button>
          ))}
        </FinancialData>
      )}
    </div>
  );
}

export function SelectionCheckbox({
  checked,
  mixed = false,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  mixed?: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        ref={(input) => {
          if (input) input.indeterminate = mixed;
        }}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function TransactionDescriptionCell({
  booking,
  classification,
}: {
  booking: AccountedTransaction;
  classification: Pick<ReturnType<typeof classify>, "category" | "isTransfer">;
}) {
  const description = bookingDescription(booking);
  // Raw bank texts ("AMZNPRIME DE*BT15Q46J4") get a readable name; a user alias always wins.
  const shown = booking.merchantAlias ? description : cleanMerchantName(description);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <MerchantMark booking={booking} classification={classification} />
      <span className="min-w-0">
        <span
          className="block min-w-0 text-sm font-medium break-words md:max-w-[300px] md:truncate"
          title={description}
        >
          {shown}
        </span>
        {!!booking.tags?.length && <span className="mt-1 flex flex-wrap gap-1">
          {booking.tags.map((tag) => <span key={tag} className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs text-primary">#{tag}</span>)}
        </span>}
        {booking.note && <span className="mt-0.5 block min-w-0 text-xs text-muted-foreground break-words md:max-w-[300px] md:truncate" title={booking.note}>
          <span className="sr-only">Notiz: </span>{booking.note}
        </span>}
      </span>
    </div>
  );
}

export function TransactionCategoryCell({
  booking,
  category,
  fixed,
  reason,
  explanation,
  why,
  onChangeCategory,
}: {
  booking: AccountedTransaction;
  category: Category;
  fixed: boolean;
  reason?: string;
  explanation: string;
  // Lazily computed "Warum diese Kategorie?" explanation; only evaluated while the popover is open.
  why?: () => CategoryExplanation;
  onChangeCategory?: () => void;
}) {
  const reviewed = booking.reviewed && booking.categoryOverride;
  const evidence = !hasManualCategory(booking) && !reason &&
    booking.automaticCategoryEvidence?.category === category
      ? booking.automaticCategoryEvidence : undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground/85">
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", categoryTone(category))} />
          <span className="min-w-0 truncate">{category}</span>
        </span>
        {fixed && (
          <span
            role="img"
            aria-label="Wiederkehrende Fixkosten"
            title="Fixkosten · wiederkehrend"
            className="inline-flex shrink-0 text-blue-600 dark:text-blue-400"
          >
            <Repeat className="size-4" aria-hidden="true" />
          </span>
        )}
        {booking.ignored && (
          <span
            title="Zählt in keiner Statistik, keinem Budget und keiner Auswertung"
            className="inline-flex items-center gap-1 rounded-md border border-border/70 px-1.5 py-0.5 text-2xs font-medium text-muted-foreground"
          >
            <EyeOff className="size-3" aria-hidden="true" />
            Ignoriert
          </span>
        )}
      </div>
      <PremiumDialog>
        <PremiumDialogTrigger asChild>
          <button
            type="button"
            aria-label={`Zuordnungsdetails: ${booking.description}`}
            className={cn(
              "inline-flex min-h-7 items-center gap-1.5 rounded-md px-1 text-2xs transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none",
              reason ? "font-medium text-primary" : "text-muted-foreground",
            )}
          >
            {reason ? (
              <>
                <CircleHelp className="size-3.5" />
                Prüfung offen
              </>
            ) : (
              <>
                <Check className="size-3" />
                {reviewed ? "Geprüft" : "Zugeordnet"}
              </>
            )}
          </button>
        </PremiumDialogTrigger>
        <PremiumDialogContent size="sm">
          <PremiumDialogHeader
            icon={reason ? CircleHelp : Check}
            title={reason ? "Noch zu prüfen" : "Aktuelle Einordnung"}
            description={bookingDescription(booking)}
          />
          <PremiumDialogBody className="space-y-4 text-sm">
            <PremiumDialogItem className="space-y-3 rounded-2xl bg-surface-sunken/70 p-4">
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs font-medium shadow-xs">
                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", categoryTone(category))} />
                <span className="min-w-0 truncate">{category}</span>
              </span>
              <p className="leading-relaxed text-muted-foreground">
                {reason ??
                  (reviewed
                    ? "Diese Buchung wurde manuell geprüft."
                    : "Für diese Buchung ist keine Prüfung offen.")}
              </p>
              <p>{explanation}</p>
              {evidence && <p className="leading-relaxed text-muted-foreground">
                Automatisch erkannt: {evidence.method === "mcc" ? "Händlerkategorie der Bank"
                  : evidence.method === "purpose" ? "eindeutiger Buchungszweck" : "öffentliche Händlerdaten"}
                {evidence.mcc ? ` · MCC ${evidence.mcc}` : ""}.
              </p>}
            </PremiumDialogItem>
            {why && <CategoryWhy why={why} onChangeCategory={onChangeCategory} />}
          </PremiumDialogBody>
        </PremiumDialogContent>
      </PremiumDialog>
    </div>
  );
}

function CategoryWhy({ why, onChangeCategory }: { why: () => CategoryExplanation; onChangeCategory?: () => void }) {
  const explanation = why();
  return (
    <PremiumDialogItem>
    <section aria-label="Warum diese Kategorie?" className="space-y-2">
      <h3 className="text-sm font-semibold">Warum diese Kategorie?</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted-foreground">Kategorie</dt>
        <dd>{explanation.category}</dd>
        <dt className="text-muted-foreground">Quelle</dt>
        <dd className="font-medium">{explanation.source}</dd>
        <dt className="text-muted-foreground">Datum</dt>
        <dd>{dateLabel(explanation.date)}</dd>
      </dl>
      <p className="leading-relaxed text-muted-foreground">{explanation.detail}</p>
      {onChangeCategory && (
        <PremiumDialogClose asChild>
          <Button type="button" size="sm" variant="soft" className="mt-1" onClick={onChangeCategory}>
            Falsch? Kategorie ändern
          </Button>
        </PremiumDialogClose>
      )}
    </section>
    </PremiumDialogItem>
  );
}

export function TransactionAmountCell({
  amount,
  items,
  reimbursement,
}: {
  amount: number;
  items: HolidayReceivable[];
  reimbursement: boolean;
}) {
  return (
    <div className="ml-auto max-w-64 text-right">
      <span
        className={cn(
          "amount block text-sm whitespace-nowrap",
          amount > 0 && "text-money-in",
        )}
      >
        {currency(amount)}
      </span>
      {items.map((item) => (
        <span
          key={item.bookingId}
          className="mt-1 block text-2xs leading-relaxed whitespace-normal text-muted-foreground"
        >
          Gesamt {currency(item.fullAmount)} · Meine Hälfte · {item.status}
        </span>
      ))}
      {reimbursement && (
        <span className="mt-1 block text-2xs whitespace-normal text-muted-foreground">
          Geteilt bezahlt · kein Einkommen
        </span>
      )}
    </div>
  );
}

function mobileCell(row: Row<AccountedTransaction>, id: string) {
  const cell = row.getAllCells().find((item) => item.column.id === id);
  return cell
    ? flexRender(cell.column.columnDef.cell, cell.getContext())
    : null;
}

export function MobileTransactionList({
  rows,
  groupByDay = false,
}: {
  rows: Row<AccountedTransaction>[];
  groupByDay?: boolean;
}) {
  const { locked } = useSecurityMode();
  const daySums = new Map<string, number>();
  if (groupByDay)
    for (const row of rows)
      if (!row.original.ignored)
        daySums.set(row.original.date, (daySums.get(row.original.date) ?? 0) + Number(row.getValue("amount") ?? 0));
  return (
    <ol
      data-financial-data=""
      aria-hidden={locked || undefined}
      inert={locked || undefined}
      aria-label="Mobile Buchungen"
      className="md:hidden"
    >
      {rows.map((row, index) => {
        const showDay = groupByDay && rows[index - 1]?.original.date !== row.original.date;
        const daySum = daySums.get(row.original.date) ?? 0;
        return [
          showDay && (
            <li key={`day-${row.original.date}-${index}`} role="presentation" className="sticky top-[var(--shell-header)] z-[1] flex items-center justify-between gap-3 border-y border-border/60 bg-surface-sunken/95 px-4 py-2 text-xs backdrop-blur-sm first:border-t-0">
              <span className="font-medium text-muted-foreground">{dayHeading(row.original.date)}</span>
              <span className={cn("font-medium tabular-nums", daySum > 0 ? "text-money-in" : "text-muted-foreground")}>{currency(Math.round(daySum * 100) / 100)}</span>
            </li>
          ),
          <li
            key={row.id}
            aria-label={`Buchung: ${row.original.merchantAlias ?? row.original.description}`}
            className={cn(
              "space-y-2 border-b border-border/60 px-4 py-3 transition-colors last:border-b-0",
              row.getIsSelected() && "bg-accent-muted",
              row.original.ignored && "opacity-55",
            )}
          >
            <div className="flex items-start gap-2">
              <div className="-mt-2 -ml-2 shrink-0">
                {mobileCell(row, "selection")}
              </div>
              <div className="min-w-0 flex-1">
                {mobileCell(row, "description")}
                {!groupByDay && <p className="mt-1 text-xs text-muted-foreground">
                  {dateLabel(row.original.date)}
                </p>}
              </div>
              <div className="min-w-0 max-w-[48%]">
                {mobileCell(row, "amount")}
              </div>
            </div>
            <div className="flex items-end justify-between gap-3 pl-9">
              <div className="min-w-0">{mobileCell(row, "category")}</div>
              <div className="flex min-w-0 flex-col items-end gap-1">
                <div className="max-w-full text-right text-xs text-muted-foreground">
                  {mobileCell(row, "account")}
                </div>
                {mobileCell(row, "actions")}
              </div>
            </div>
          </li>,
        ];
      })}
    </ol>
  );
}

function dayHeading(date: string) {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  const year = parsed.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined;
  return parsed.toLocaleDateString("de-AT", { weekday: "long", day: "numeric", month: "long", year });
}

export function MobileLedgerControls({
  table,
  disabled,
}: {
  table: Table<AccountedTransaction>;
  disabled: boolean;
}) {
  const orders = [
    { value: "date-desc", label: "Neueste zuerst", id: "date", desc: true },
    { value: "date-asc", label: "Älteste zuerst", id: "date", desc: false },
    {
      value: "amount-asc",
      label: "Betrag aufsteigend",
      id: "amount",
      desc: false,
    },
    {
      value: "amount-desc",
      label: "Betrag absteigend",
      id: "amount",
      desc: true,
    },
    {
      value: "description-asc",
      label: "Händler A–Z",
      id: "description",
      desc: false,
    },
  ];
  const sorting = table.getState().sorting[0];
  const value =
    orders.find(
      (order) => order.id === sorting?.id && order.desc === sorting.desc,
    )?.value ?? "";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 md:hidden">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <SelectionCheckbox
          label="Buchungen dieser Seite auswählen"
          checked={table.getIsAllPageRowsSelected()}
          mixed={table.getIsSomePageRowsSelected()}
          disabled={disabled || !table.getRowModel().rows.length}
          onChange={(checked) => table.toggleAllPageRowsSelected(checked)}
        />
        Diese Seite
      </div>
      <select
        aria-label="Buchungen sortieren"
        className="select-input min-w-0 max-w-full text-xs"
        value={value}
        onChange={(event) => {
          const order = orders.find(
            (item) => item.value === event.target.value,
          );
          if (order) table.setSorting([{ id: order.id, desc: order.desc }]);
        }}
      >
        {value === "" && <option value="">Eigene Sortierung</option>}
        {orders.map((order) => (
          <option key={order.value} value={order.value}>
            {order.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function LedgerFooter({
  table,
  count,
  total,
}: {
  table: Table<AccountedTransaction>;
  count: number;
  total: number;
}) {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 px-4 py-3 text-xs sm:px-5">
      <FinancialData className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>{count.toLocaleString("de-AT")} Treffer</span>
        <span>
          Summe{" "}
          <strong className="ml-1 font-semibold text-foreground tabular-nums">
            {currency(total)}
          </strong>
        </span>
      </FinancialData>
      <div className="flex items-center gap-2">
        <FinancialData as="span" className="mr-1 text-muted-foreground">
          Seite {table.getState().pagination.pageIndex + 1} /{" "}
          {Math.max(1, table.getPageCount())}
        </FinancialData>
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          disabled={!table.getCanPreviousPage()}
          onClick={() => table.previousPage()}
          aria-label="Vorherige Seite"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-9"
          disabled={!table.getCanNextPage()}
          onClick={() => table.nextPage()}
          aria-label="Nächste Seite"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </footer>
  );
}
