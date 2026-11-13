"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  Download,
  ListChecks,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { addDaysIso } from "@/components/ui/range-calendar";
import {
  Field,
  PremiumDialog,
  PremiumDialogBody,
  PremiumDialogClose,
  PremiumDialogContent,
  PremiumDialogFooter,
  PremiumDialogHeader,
  PremiumDialogItem,
  PremiumDialogTrigger,
} from "@/components/ui/premium-dialog";
import { CategorySelect } from "@/components/category-select";
import { SharedCosts } from "@/components/shared-costs";
import { HolidayRanges } from "@/components/holiday-ranges";
import { ReviewCount } from "@/components/review-count";
import { FinancialData } from "@/components/financial-data";
import {
  TransactionToolbar,
  type FilterChip,
} from "@/components/transaction-workspace";
import { accountLabel } from "@/lib/accounts";
import { bookingMonth, monthKey } from "@/lib/calc";
import { dateLabel, monthLabel } from "@/lib/format";
import type {
  AccountedTransaction,
  HolidayReceivable,
} from "@/lib/shared-holiday";
import type { Category } from "@/lib/types";
import { budgetGroupLabel } from "@/lib/ledger-link";
import { cn } from "@/lib/utils";
import type { VariableBudgetId } from "@/lib/variable-budgets";

export type LedgerFilters = {
  query: string;
  month: string | null;
  group: VariableBudgetId | null;
  category: Category | "";
  account: string;
  plan: "" | "yes" | "no";
  from: string;
  to: string;
  showTransfers: boolean;
};

export const emptyLedgerFilters: LedgerFilters = {
  query: "",
  month: null,
  group: null,
  category: "",
  account: "",
  plan: "",
  from: "",
  to: "",
  showTransfers: false,
};

export function TransactionFilters({
  filters,
  setFilters,
  currentMonth,
  today,
  ledger,
  receivables,
  reviewCount,
  disabled,
  exportDisabled,
  resultCount,
  onReview,
  onExport,
}: {
  filters: LedgerFilters;
  setFilters: Dispatch<SetStateAction<LedgerFilters>>;
  currentMonth: string;
  /** The app's "today" (settings.asOf) for the period shortcuts. */
  today?: string;
  ledger: AccountedTransaction[];
  receivables: HolidayReceivable[];
  reviewCount: number;
  disabled: boolean;
  exportDisabled: boolean;
  /** Bookings matching all filters, shown on the filter dialog's button. */
  resultCount?: number;
  onReview: () => void;
  onExport: () => void;
}) {
  function change<K extends keyof LedgerFilters>(
    key: K,
    value: LedgerFilters[K],
  ) {
    setFilters((previous) => ({ ...previous, [key]: value }));
  }
  const month = filters.month ?? currentMonth;
  const chips: FilterChip[] = [];
  if (filters.query)
    chips.push({
      id: "query",
      label: `Suche: ${filters.query}`,
      remove: () => change("query", ""),
    });
  if (month !== currentMonth)
    chips.push({
      id: "month",
      label: month ? monthLabel(month, true) : "Alle Monate",
      remove: () => change("month", null),
    });
  if (filters.group)
    chips.push({
      id: "group",
      label: `Budget: ${budgetGroupLabel(filters.group)}`,
      remove: () => change("group", null),
    });
  if (filters.category)
    chips.push({
      id: "category",
      label: filters.category,
      remove: () => change("category", ""),
    });
  if (filters.account)
    chips.push({
      id: "account",
      label: filters.account,
      remove: () => change("account", ""),
    });
  if (filters.plan)
    chips.push({
      id: "plan",
      label: filters.plan === "yes" ? "Im Plan" : "Nicht im Plan",
      remove: () => change("plan", ""),
    });
  if (filters.from)
    chips.push({
      id: "from",
      label: `Ab ${dateLabel(filters.from)}`,
      remove: () => change("from", ""),
    });
  if (filters.to)
    chips.push({
      id: "to",
      label: `Bis ${dateLabel(filters.to)}`,
      remove: () => change("to", ""),
    });
  if (filters.showTransfers)
    chips.push({
      id: "transfers",
      label: "Transfers sichtbar",
      remove: () => change("showTransfers", false),
    });
  const year = (today ?? `${currentMonth}-01`).slice(0, 4);
  const end = today ?? `${currentMonth}-28`;
  const periods = [
    { id: "7", label: "Letzte 7 Tage", from: addDaysIso(end, -6), to: end },
    { id: "30", label: "Letzte 30 Tage", from: addDaysIso(end, -29), to: end },
    { id: "year", label: "Dieses Jahr", from: `${year}-01-01`, to: `${year}-12-31` },
    { id: "last", label: "Letztes Jahr", from: `${Number(year) - 1}-01-01`, to: `${Number(year) - 1}-12-31` },
  ];
  const advanced = !!(
    filters.plan ||
    filters.from ||
    filters.to ||
    filters.showTransfers
  );
  return (
    <TransactionToolbar
      chips={chips}
      reset={
        <Tooltip label="Alle Filter zurücksetzen">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full text-muted-foreground hover:text-foreground"
            aria-label="Zurücksetzen"
            onClick={() => setFilters(emptyLedgerFilters)}
          >
            <X className="size-3.5" />
          </Button>
        </Tooltip>
      }
      search={
        <FinancialData className="relative min-w-0">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Umsätze durchsuchen"
            className="h-11 w-full rounded-xl border-transparent bg-surface-sunken/80 pl-10 shadow-none hover:border-border focus-visible:bg-card"
            placeholder="Händler, Bank oder Pocket suchen …"
            value={filters.query}
            onChange={(event) => change("query", event.target.value)}
          />
        </FinancialData>
      }
      actions={
        <>
          <Tooltip label="Gesamte Prüfliste öffnen">
            <Button
              variant="ghost"
              className={cn("h-10 gap-2 rounded-xl px-3", reviewCount > 0 && "text-foreground")}
              aria-label="Zuordnung prüfen"
              disabled={disabled}
              onClick={onReview}
            >
              <ListChecks className="size-4" />
              Prüfen
              <FinancialData as="span"><ReviewCount count={reviewCount} /></FinancialData>
            </Button>
          </Tooltip>
          <SharedCosts bookings={ledger} items={receivables} iconOnly />
          <HolidayRanges iconOnly />
          <PremiumDialog>
            <PremiumDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="relative size-10 rounded-xl"
                aria-label="Weitere Filter"
                title="Weitere Filter"
              >
                <SlidersHorizontal className="size-4" />
                {advanced && (
                  <span
                    className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary"
                    aria-label="Zusätzliche Filter aktiv"
                  />
                )}
              </Button>
            </PremiumDialogTrigger>
            <PremiumDialogContent size="sm" snapPoints={[0.55, 0.9]}>
              <PremiumDialogHeader
                icon={SlidersHorizontal}
                title="Weitere Filter"
                description="Zeitraum, Plan und Anzeige – Änderungen gelten sofort."
              />
              <PremiumDialogBody className="space-y-6">
                <FilterGroup title="Zeitraum">
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Zeitraum-Schnellwahl">
                    {periods.map((period) => {
                      const active = filters.from === period.from && filters.to === period.to;
                      return (
                        <button key={period.id} type="button" aria-pressed={active}
                          onClick={() => setFilters((previous) => active
                            ? { ...previous, from: "", to: "" }
                            : { ...previous, month: "", from: period.from, to: period.to })}
                          className={cn("min-h-9 rounded-full border px-3.5 text-xs font-medium transition-[background-color,border-color,color,scale] duration-150 ease-soft active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none pointer-coarse:min-h-11",
                            active ? "border-primary/50 bg-accent-muted text-primary" : "border-border/70 bg-card hover:border-primary/40 hover:text-primary")}>
                          {period.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Von">
                      <Input
                        type="date"
                        aria-label="Datum von"
                        className="h-11"
                        value={filters.from}
                        onChange={(event) => change("from", event.target.value)}
                      />
                    </Field>
                    <Field label="Bis" error={filters.from && filters.to && filters.to < filters.from ? "Liegt vor dem Startdatum." : null}>
                      <Input
                        type="date"
                        aria-label="Datum bis"
                        className="h-11"
                        value={filters.to}
                        onChange={(event) => change("to", event.target.value)}
                      />
                    </Field>
                  </div>
                  {(filters.from || filters.to) && month && (
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      Gilt zusätzlich zum Monat {monthLabel(month, true)}.
                      <button type="button" className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => change("month", "")}>Alle Monate</button>
                    </p>
                  )}
                </FilterGroup>
                <FilterGroup title="Planrelevanz">
                  <SegmentedControl
                    label="Planrelevanz filtern"
                    value={filters.plan}
                    onChange={(plan) => change("plan", plan)}
                    options={[
                      { value: "", label: "Alle" },
                      { value: "yes", label: "Im Plan" },
                      { value: "no", label: "Nicht im Plan" },
                    ]}
                    className="grid w-full grid-cols-3"
                  />
                </FilterGroup>
                <FilterGroup title="Anzeige">
                  <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3 text-sm transition-colors hover:bg-muted/40 motion-reduce:transition-none">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">Transfers anzeigen</span>
                      <span className="block text-xs text-muted-foreground">Umbuchungen zwischen eigenen Konten einblenden</span>
                    </span>
                    <span className="relative inline-flex shrink-0">
                      <input
                        type="checkbox"
                        aria-label="Transfers anzeigen"
                        className="peer h-6 w-11 cursor-pointer appearance-none rounded-full bg-muted-foreground/30 transition-colors duration-200 checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
                        checked={filters.showTransfers}
                        onChange={(event) =>
                          change("showTransfers", event.target.checked)
                        }
                      />
                      <span aria-hidden="true" className="pointer-events-none absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-soft peer-checked:translate-x-5 motion-reduce:transition-none" />
                    </span>
                  </label>
                </FilterGroup>
              </PremiumDialogBody>
              <PremiumDialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  className="sm:mr-auto"
                  disabled={!advanced}
                  onClick={() =>
                    setFilters((previous) => ({ ...previous, plan: "", from: "", to: "", showTransfers: false }))
                  }
                >
                  Filter zurücksetzen
                </Button>
                <PremiumDialogClose asChild>
                  <Button type="button">
                    <span aria-live="polite" className="tabular-nums">
                      {resultCount === undefined ? "Fertig" : `${resultCount.toLocaleString("de-AT")} Treffer anzeigen`}
                    </span>
                  </Button>
                </PremiumDialogClose>
              </PremiumDialogFooter>
            </PremiumDialogContent>
          </PremiumDialog>
          <Tooltip label="Alle gefilterten Treffer als CSV exportieren">
            <Button
              variant="ghost"
              size="icon"
              className="size-10 rounded-xl"
              disabled={exportDisabled}
              aria-label="Ansicht exportieren"
              onClick={onExport}
            >
              <Download className="size-4" />
            </Button>
          </Tooltip>
        </>
      }
      filters={
        <>
          <label className="min-w-0">
            <span className="sr-only">
              Monat
            </span>
            <select
              aria-label="Monat filtern"
              className="select-input h-11 w-full min-w-0 rounded-xl @5xl:w-44"
              value={month}
              onChange={(event) => change("month", event.target.value)}
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
          </label>
          <div className="min-w-0">
            <label
              htmlFor="ledger-category"
              className="sr-only"
            >
              Kategorie
            </label>
            <CategorySelect
              id="ledger-category"
              label="Kategorie filtern"
              allowAll
              className="[&_select]:h-11 [&_select]:rounded-xl @5xl:[&_select]:w-48"
              value={filters.category}
              onValueChange={(value) => change("category", value)}
            />
          </div>
          <label className="min-w-0">
            <span className="sr-only">
              Konto / Pocket
            </span>
            <FinancialData>
            <select
              aria-label="Konto/Pocket filtern"
              className="select-input h-11 w-full min-w-0 rounded-xl @5xl:w-52"
              value={filters.account}
              onChange={(event) => change("account", event.target.value)}
            >
              <option value="">Alle Konten/Pockets</option>
              {[...new Set(ledger.map(accountLabel))].sort().map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            </FinancialData>
          </label>
        </>
      }
    />
  );
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PremiumDialogItem>
      <section aria-label={title} className="space-y-3">
        <h3 className="eyebrow px-1">{title}</h3>
        {children}
      </section>
    </PremiumDialogItem>
  );
}
