"use client";

import type { Dispatch, SetStateAction } from "react";
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
import {
  Field,
  PremiumDialog,
  PremiumDialogBody,
  PremiumDialogClose,
  PremiumDialogContent,
  PremiumDialogFooter,
  PremiumDialogHeader,
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
  const advanced = !!(
    filters.plan ||
    filters.from ||
    filters.to ||
    filters.showTransfers
  );
  return (
    <TransactionToolbar
      chips={chips}
      search={
        <FinancialData className="relative min-w-0">
          <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Umsätze durchsuchen"
            className="h-11 w-full pl-9"
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
              variant={reviewCount ? "outline" : "ghost"}
              className="h-11 gap-2"
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
                variant="outline"
                size="icon"
                className="relative size-11"
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
            <PremiumDialogContent size="sm">
              <PremiumDialogHeader
                icon={SlidersHorizontal}
                title="Weitere Filter"
                description="Umsätze nach Plan, Zeitraum und Transfers eingrenzen. Änderungen gelten sofort."
              />
              <PremiumDialogBody className="space-y-5">
                <Field label="Planrelevanz">
                  <select
                    aria-label="Planrelevanz filtern"
                    className="select-input w-full"
                    value={filters.plan}
                    onChange={(event) =>
                      change(
                        "plan",
                        event.target.value === "yes"
                          ? "yes"
                          : event.target.value === "no"
                            ? "no"
                            : "",
                      )
                    }
                  >
                    <option value="">Plan: alle</option>
                    <option value="yes">Im Plan</option>
                    <option value="no">Nicht im Plan</option>
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Von">
                    <Input
                      type="date"
                      aria-label="Datum von"
                      value={filters.from}
                      onChange={(event) => change("from", event.target.value)}
                    />
                  </Field>
                  <Field label="Bis" error={filters.from && filters.to && filters.to < filters.from ? "Liegt vor dem Startdatum." : null}>
                    <Input
                      type="date"
                      aria-label="Datum bis"
                      value={filters.to}
                      onChange={(event) => change("to", event.target.value)}
                    />
                  </Field>
                </div>
                <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border border-border/70 px-4 py-3 text-sm transition-colors hover:bg-muted/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring motion-reduce:transition-none">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">Transfers anzeigen</span>
                    <span className="block text-xs text-muted-foreground">Umbuchungen zwischen eigenen Konten einblenden</span>
                  </span>
                  <input
                    type="checkbox"
                    aria-label="Transfers anzeigen"
                    className="size-5 shrink-0 accent-primary"
                    checked={filters.showTransfers}
                    onChange={(event) =>
                      change("showTransfers", event.target.checked)
                    }
                  />
                </label>
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
                    {resultCount === undefined ? "Fertig" : `${resultCount.toLocaleString("de-AT")} Treffer anzeigen`}
                  </Button>
                </PremiumDialogClose>
              </PremiumDialogFooter>
            </PremiumDialogContent>
          </PremiumDialog>
          <Tooltip label="Alle gefilterten Treffer als CSV exportieren">
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              disabled={exportDisabled}
              aria-label="Ansicht exportieren"
              onClick={onExport}
            >
              <Download className="size-4" />
            </Button>
          </Tooltip>
          {chips.length > 0 && (
            <Tooltip label="Alle Filter zurücksetzen">
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                aria-label="Zurücksetzen"
                onClick={() => setFilters(emptyLedgerFilters)}
              >
                <X className="size-4" />
              </Button>
            </Tooltip>
          )}
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
              className="select-input h-11 w-full min-w-0"
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
              className="[&_select]:h-11"
              value={filters.category}
              onValueChange={(value) => change("category", value)}
            />
          </div>
          <label className="min-w-0 sm:col-span-2 xl:col-span-1">
            <span className="sr-only">
              Konto / Pocket
            </span>
            <FinancialData>
            <select
              aria-label="Konto/Pocket filtern"
              className="select-input h-11 w-full min-w-0"
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
