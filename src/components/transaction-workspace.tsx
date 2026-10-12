"use client";

import type { ReactNode } from "react";
import { flexRender, type Row, type Table } from "@tanstack/react-table";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Repeat,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MerchantMark } from "@/components/merchant-mark";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { currency, dateLabel } from "@/lib/format";
import { bookingDescription } from "@/lib/import/merchant-description";
import type { classify } from "@/lib/calc";
import type { Category } from "@/lib/types";
import type {
  AccountedTransaction,
  HolidayReceivable,
} from "@/lib/shared-holiday";
import { cn } from "@/lib/utils";
import { FinancialData } from "@/components/financial-data";
import { useSecurityMode } from "@/components/security-mode-provider";

export type AssignmentStatus = "all" | "review" | "assigned";
export type FilterChip = { id: string; label: string; remove: () => void };

export { useCompactLayout as useMobileLedger } from "@/components/ui/use-compact-layout";

export function TransactionToolbar({
  search,
  filters,
  actions,
  status,
  chips,
}: {
  search: ReactNode;
  filters: ReactNode;
  actions: ReactNode;
  status: ReactNode;
  chips: FilterChip[];
}) {
  return (
    <div
      role="group"
      aria-label="Umsatz-Werkzeugleiste"
      className="space-y-4 border-b border-border/70 p-4 sm:p-5"
    >
      <div className="grid items-center gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">{search}</div>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{filters}</div>
      {status}
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
              variant="outline"
              className="h-auto min-h-9 max-w-full rounded-full py-1.5 text-xs"
              aria-label={`Filter entfernen: ${chip.label}`}
              onClick={chip.remove}
            >
              <span className="min-w-0 truncate">{chip.label}</span>
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          ))}
        </FinancialData>
      )}
    </div>
  );
}

export function AssignmentSwitch({
  value,
  count,
  pending,
  onChange,
}: {
  value: AssignmentStatus;
  count: number;
  pending: number;
  onChange: (value: AssignmentStatus) => void;
}) {
  const options = [
    { value: "all", label: "Alle", count },
    { value: "review", label: "Prüfung offen", count: pending },
    { value: "assigned", label: "Zugeordnet", count: count - pending },
  ] as const;
  return (
    <div
      role="group"
      aria-label="Zuordnungsstatus filtern"
      className="grid grid-cols-3 gap-1 rounded-xl bg-muted/50 p-1 sm:inline-grid"
    >
      {options.map((option) => (
        <Button
          key={option.value}
          variant="ghost"
          size="sm"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-auto min-h-11 min-w-0 flex-wrap rounded-lg px-2 text-xs whitespace-normal sm:px-4",
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground",
          )}
        >
          {option.label}
          <FinancialData as="span" className="tabular-nums text-muted-foreground">
            {option.count}
          </FinancialData>
        </Button>
      ))}
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
  return (
    <div className="flex min-w-0 items-center gap-2">
      <MerchantMark booking={booking} classification={classification} />
      <span
        className="block min-w-0 text-sm font-medium break-words md:max-w-[300px] md:truncate"
        title={description}
      >
        {description}
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
}: {
  booking: AccountedTransaction;
  category: Category;
  fixed: boolean;
  reason?: string;
  explanation: string;
}) {
  const reviewed = booking.reviewed && booking.categoryOverride;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
          {category}
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
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Zuordnungsdetails: ${booking.description}`}
            className={cn(
              "inline-flex min-h-7 items-center gap-1.5 rounded-md px-1 text-[11px] transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none",
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
        </PopoverTrigger>
        <PopoverContent className="space-y-2 text-xs">
          <p className="text-sm font-semibold">
            {reason ? "Noch zu prüfen" : "Aktuelle Einordnung"}
          </p>
          <p className="leading-relaxed text-muted-foreground">
            {reason ??
              (reviewed
                ? "Diese Buchung wurde manuell geprüft."
                : "Für diese Buchung ist keine Prüfung offen.")}
          </p>
          <p>{explanation}</p>
        </PopoverContent>
      </Popover>
    </div>
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
          "block text-sm font-semibold whitespace-nowrap tabular-nums",
          amount > 0 && "text-primary",
        )}
      >
        {currency(amount)}
      </span>
      {items.map((item) => (
        <span
          key={item.bookingId}
          className="mt-1 block text-[11px] leading-relaxed whitespace-normal text-muted-foreground"
        >
          Gesamt {currency(item.fullAmount)} · Meine Hälfte · {item.status}
        </span>
      ))}
      {reimbursement && (
        <span className="mt-1 block text-[11px] whitespace-normal text-muted-foreground">
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
}: {
  rows: Row<AccountedTransaction>[];
}) {
  const { locked } = useSecurityMode();
  return (
    <ol
      data-financial-data=""
      aria-hidden={locked || undefined}
      inert={locked || undefined}
      aria-label="Mobile Buchungen"
      className="divide-y divide-border/70 md:hidden"
    >
      {rows.map((row) => (
        <li
          key={row.id}
          aria-label={`Buchung: ${row.original.merchantAlias ?? row.original.description}`}
          className="space-y-3 p-4"
        >
          <div className="flex items-start gap-2">
            <div className="-mt-2 -ml-2 shrink-0">
              {mobileCell(row, "selection")}
            </div>
            <div className="min-w-0 flex-1">
              {mobileCell(row, "description")}
              <p className="mt-1 text-xs text-muted-foreground">
                {dateLabel(row.original.date)}
              </p>
            </div>
            <div className="min-w-0 max-w-[48%]">
              {mobileCell(row, "amount")}
            </div>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            {mobileCell(row, "category")}
            <div className="max-w-full text-xs text-muted-foreground">
              {mobileCell(row, "account")}
            </div>
          </div>
          <div className="flex justify-end border-t border-border/50 pt-2">
            {mobileCell(row, "actions")}
          </div>
        </li>
      ))}
    </ol>
  );
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
