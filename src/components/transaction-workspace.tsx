"use client";

import { useId, useState, type ReactNode } from "react";
import { flexRender, type Row, type Table } from "@tanstack/react-table";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  EyeOff,
  ListFilter,
  Repeat,
  Scale,
  X,
  type LucideIcon,
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

import { useMediaQuery } from "@/components/ui/use-compact-layout";

/** Phones, tablets and narrow windows get booking cards; the table starts at 1280px. */
export function useMobileLedger() {
  return useMediaQuery("(max-width: 1279px)");
}

/** Below 1440px the table keeps only edit and "⋯" inline, so the merchant column keeps its room. */
export function useCompactLedgerActions() {
  return useMediaQuery("(max-width: 1439px)");
}

export function TransactionToolbar({
  search,
  filters,
  actions,
  chips,
  reset,
}: {
  search: ReactNode;
  filters: ReactNode;
  actions: ReactNode;
  chips: FilterChip[];
  /** Clears every filter; shown next to the active filter chips. */
  reset?: ReactNode;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  return (
    <div
      role="group"
      aria-label="Umsatz-Werkzeugleiste"
      className="@container space-y-3 p-3 sm:p-4"
    >
      <div className="flex flex-col gap-2 @5xl:flex-row @5xl:items-center">
        <div className="flex min-w-0 gap-2 @5xl:flex-1">
          <div className="min-w-0 flex-1">{search}</div>
          <Button
            type="button"
            variant={filtersOpen ? "secondary" : "outline"}
            size="icon"
            className="relative size-11 shrink-0 rounded-xl md:hidden"
            aria-label={chips.length ? `Filter (${chips.length} aktiv)` : "Filter"}
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <ListFilter className="size-4" aria-hidden="true" />
            {chips.length > 0 && (
              <span aria-hidden="true" className="absolute -top-1 -right-1 inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-2xs leading-5 font-semibold text-primary-foreground tabular-nums">
                {chips.length}
              </span>
            )}
          </Button>
        </div>
        <div id={filtersId} className={cn("grid gap-2 sm:grid-cols-3 @5xl:flex @5xl:shrink-0 @5xl:items-center",
          !filtersOpen && "max-md:hidden", filtersOpen && "max-md:animate-in max-md:fade-in-0 max-md:slide-in-from-top-1 motion-reduce:animate-none")}>{filters}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {chips.length > 0 && (
          <div className="flex min-w-0 items-center gap-1 max-md:order-last max-md:basis-full">
            <FinancialData
              role="group"
              aria-label="Aktive Filter"
              className="flex min-w-0 flex-wrap items-center gap-1.5"
            >
              {chips.map((chip) => (
                <Button
                  key={chip.id}
                  type="button"
                  size="sm"
                  variant="soft"
                  className="h-auto min-h-8 max-w-full rounded-full py-1 pr-2 pl-3 text-xs hover:translate-y-0 hover:shadow-none active:scale-95"
                  aria-label={`Filter entfernen: ${chip.label}`}
                  onClick={chip.remove}
                >
                  <span className="min-w-0 truncate">{chip.label}</span>
                  <X className="size-3.5 opacity-70" aria-hidden="true" />
                </Button>
              ))}
            </FinancialData>
            {reset}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1 max-md:w-full max-md:[&>:first-child]:mr-auto">{actions}</div>
      </div>
    </div>
  );
}

/** Income, spending and balance of the filtered view as three calm cards. */
export function LedgerSummary({ income, spending }: { income: number; spending: number }) {
  const balance = Math.round((income + spending) * 100) / 100;
  const items: { label: string; value: number; tone: string; tile: string; icon: LucideIcon }[] = [
    { label: "Einnahmen", value: income, tone: "text-money-in", tile: "bg-success-soft text-success", icon: ArrowDownLeft },
    { label: "Ausgaben", value: spending, tone: "text-money-out", tile: "bg-destructive/10 text-destructive", icon: ArrowUpRight },
    { label: "Saldo", value: balance, tone: balance < 0 ? "text-money-out" : "text-money-in", tile: "bg-accent-muted text-primary", icon: Scale },
  ];
  return (
    <FinancialData as="dl" aria-label="Summe der gefilterten Umsätze" className="grid grid-cols-3 gap-2 sm:gap-3">
      {items.map(({ label, value, tone, tile, icon: Icon }) => (
        <div key={label} className="min-w-0 rounded-2xl border border-border/70 bg-card px-3 py-2.5 shadow-xs sm:px-4 sm:py-3">
          <dt className="flex items-center gap-2 text-2xs text-muted-foreground sm:text-xs">
            <span aria-hidden="true" className={cn("hidden size-6 shrink-0 items-center justify-center rounded-lg sm:flex", tile)}>
              <Icon className="size-3.5" />
            </span>
            {label}
          </dt>
          <dd className={cn("amount mt-1 truncate text-sm sm:text-lg", tone)}>{currency(value)}</dd>
        </div>
      ))}
    </FinancialData>
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
    <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center has-disabled:cursor-not-allowed">
      <span className="grid size-[18px] place-items-center">
        <input
          type="checkbox"
          className="col-start-1 row-start-1 size-[18px] cursor-pointer appearance-none rounded-md border border-input bg-card transition-[background-color,border-color,scale] duration-150 ease-soft checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary hover:border-primary/60 active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100"
          aria-label={label}
          checked={checked}
          disabled={disabled}
          ref={(input) => {
            if (input) input.indeterminate = mixed;
          }}
          onChange={(event) => onChange(event.target.checked)}
        />
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"
          className="pointer-events-none col-start-1 row-start-1 size-3 text-primary-foreground">
          {mixed ? (
            <path d="M4 8h8" />
          ) : (
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" pathLength={1}
              className={cn("[stroke-dasharray:1] transition-[stroke-dashoffset] ease-soft motion-reduce:transition-none",
                checked ? "[stroke-dashoffset:0] delay-75 duration-200" : "[stroke-dashoffset:1] duration-100")} />
          )}
        </svg>
      </span>
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
    <div className="flex min-w-0 items-center gap-3">
      <MerchantMark booking={booking} classification={classification} fallbackName={shown} className="size-9 rounded-xl" />
      <span className="min-w-0">
        <span
          className="block min-w-0 text-sm font-medium break-words md:max-w-[320px] md:truncate"
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
    <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-muted/70 px-2.5 py-1 text-xs font-medium text-foreground/85">
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
            <Repeat className="size-3.5" aria-hidden="true" />
          </span>
        )}
        {booking.ignored && (
          <span
            title="Zählt in keiner Statistik, keinem Budget und keiner Auswertung"
            className="inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-2xs font-medium text-muted-foreground"
          >
            <EyeOff className="size-3" aria-hidden="true" />
            Ignoriert
          </span>
        )}
      <PremiumDialog>
        <PremiumDialogTrigger asChild>
          <button
            type="button"
            aria-label={`Zuordnungsdetails: ${booking.description}`}
            title={reason ? "Prüfung offen" : reviewed ? "Geprüft" : "Zugeordnet"}
            className={cn(
              "inline-flex items-center justify-center transition-[background-color,color,scale] duration-150 ease-soft active:scale-90 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none",
              reason
                ? "min-h-7 gap-1 rounded-full bg-warning-soft px-2 text-2xs font-medium text-warning hover:brightness-95"
                : "size-7 rounded-full text-muted-foreground/80 hover:bg-muted hover:text-foreground",
            )}
          >
            {reason ? (
              <>
                <CircleHelp className="size-3.5" aria-hidden="true" />
                Prüfung offen
              </>
            ) : (
              <>
                {reviewed ? <CheckCheck className="size-3.5 text-primary" aria-hidden="true" /> : <Check className="size-3.5" aria-hidden="true" />}
                <span className="sr-only">{reviewed ? "Geprüft" : "Zugeordnet"}</span>
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
          amount > 0 ? "text-money-in" : amount < 0 ? "text-money-out" : undefined,
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
      className="space-y-2 xl:hidden"
    >
      {rows.map((row, index) => {
        const showDay = groupByDay && rows[index - 1]?.original.date !== row.original.date;
        const daySum = Math.round((daySums.get(row.original.date) ?? 0) * 100) / 100;
        return [
          showDay && (
            <li key={`day-${row.original.date}-${index}`} role="presentation"
              className="flex items-baseline justify-between gap-3 px-1 pt-3 pb-0.5 text-xs first:pt-0">
              <span className="font-medium text-muted-foreground">{dayHeading(row.original.date)}</span>
              <span className={cn("tabular-nums", daySum > 0 ? "text-money-in" : "text-muted-foreground")}>{currency(daySum)}</span>
            </li>
          ),
          <li
            key={row.id}
            aria-label={`Buchung: ${row.original.merchantAlias ?? row.original.description}`}
            className={cn(
              "group/card grid grid-cols-[auto_minmax(0,1fr)] rounded-2xl border border-border/60 bg-card py-2 pr-3 shadow-xs transition-[background-color,border-color] duration-150 ease-soft motion-reduce:transition-none",
              row.getIsSelected() && "border-primary/40 bg-accent-muted",
              row.original.ignored && "opacity-55",
            )}
          >
            <div className="self-start">{mobileCell(row, "selection")}</div>
            <div className="min-w-0 pt-1">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">{mobileCell(row, "description")}</div>
                <div className="min-w-0 max-w-[46%] pt-2">{mobileCell(row, "amount")}</div>
              </div>
              <div className="mt-1 flex items-end gap-2 group-has-[[data-merchant-mark]]/card:pl-12">
                <div className="min-w-0 flex-1 space-y-1">
                  {mobileCell(row, "category")}
                  <p className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                    <span className="min-w-0 truncate">{mobileCell(row, "account")}</span>
                    {!groupByDay && <span className="shrink-0">· {dateLabel(row.original.date)}</span>}
                  </p>
                </div>
                <div className="-mr-1 shrink-0">{mobileCell(row, "actions")}</div>
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
    <div className="flex items-center justify-between gap-2 pr-1 xl:hidden">
      <div className="-ml-1 flex items-center text-xs text-muted-foreground">
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
        className="select-input h-9 min-w-0 max-w-[60%] rounded-xl text-xs"
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

/** Up to seven page slots around the current page; `null` marks a gap (1 … 4 5 6 … 12). */
export function pageWindow(current: number, count: number): (number | null)[] {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, null, count];
  if (current >= count - 3) return [1, null, count - 4, count - 3, count - 2, count - 1, count];
  return [1, null, current - 1, current, current + 1, null, count];
}

const pageSizes = [25, 50, 100];

export function LedgerFooter({
  table,
  count,
  total,
}: {
  table: Table<AccountedTransaction>;
  count: number;
  total: number;
}) {
  const { pageIndex, pageSize } = table.getState().pagination;
  const pages = Math.max(1, table.getPageCount());
  const current = Math.min(pageIndex + 1, pages);
  const first = count ? pageIndex * pageSize + 1 : 0;
  const last = Math.min(count, (pageIndex + 1) * pageSize);
  return (
    <footer className="flex flex-col gap-3 pt-3 text-xs sm:flex-row sm:items-center sm:justify-between xl:border-t xl:border-border/60 xl:px-5 xl:py-3">
      <FinancialData className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 text-muted-foreground sm:justify-start xl:px-0">
        <span>{count.toLocaleString("de-AT")} Treffer</span>
        <span>
          Summe{" "}
          <strong className={cn("amount ml-1 text-sm", total > 0 ? "text-money-in" : total < 0 ? "text-money-out" : "text-foreground")}>
            {currency(total)}
          </strong>
        </span>
      </FinancialData>
      <nav aria-label="Seiten" className="flex items-center justify-between gap-2 sm:justify-end">
        {count > pageSizes[0] && (
          <label className="hidden items-center gap-2 text-muted-foreground lg:flex">
            <FinancialData as="span" className="tabular-nums">{first}–{last}</FinancialData>
            <select
              aria-label="Buchungen pro Seite"
              className="select-input h-9 rounded-xl text-xs"
              value={pageSize}
              onChange={(event) => table.setPageSize(Number(event.target.value))}
            >
              {pageSizes.map((size) => <option key={size} value={size}>{size} pro Seite</option>)}
            </select>
          </label>
        )}
        <div className="flex w-full items-center justify-between gap-1 sm:w-auto sm:justify-end">
          <PageButton label="Vorherige Seite" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
            <ChevronLeft className="size-4" />
          </PageButton>
          <FinancialData className="hidden items-center gap-1 sm:flex">
            {pageWindow(current, pages).map((page, index) => page === null ? (
              <span key={`gap-${index}`} aria-hidden="true" className="w-6 text-center text-muted-foreground">…</span>
            ) : (
              <PageButton key={page} label={`Seite ${page}`} current={page === current} onClick={() => table.setPageIndex(page - 1)}>
                {page}
              </PageButton>
            ))}
          </FinancialData>
          <FinancialData as="span" className="text-center text-muted-foreground tabular-nums sm:hidden">
            Seite {current} von {pages}
          </FinancialData>
          <PageButton label="Nächste Seite" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
            <ChevronRight className="size-4" />
          </PageButton>
        </div>
      </nav>
    </footer>
  );
}

function PageButton({ label, current = false, disabled, onClick, children }: {
  label: string;
  current?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={current ? "page" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-xl text-xs font-medium tabular-nums transition-[background-color,color,scale] duration-150 ease-soft active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-35 motion-reduce:transition-none motion-reduce:active:scale-100 pointer-coarse:size-11",
        current ? "bg-primary text-primary-foreground shadow-xs" : "text-muted-foreground hover:bg-muted hover:text-foreground max-sm:border max-sm:border-border/70 max-sm:bg-card",
      )}
    >
      {children}
    </button>
  );
}
