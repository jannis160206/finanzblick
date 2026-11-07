"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { EmptyState, PageHeading } from "@/components/finance-ui";
import { FixedCostSchedule } from "@/components/fixed-cost-schedule";
import {
  MonthPlanToolbar,
  type MonthPlanArea,
  type MonthPlanView,
} from "@/components/month-plan-toolbar";
import { MonthPlanGrid } from "@/components/month-plan-grid";
import {
  DeleteMonthPositionDialog,
  MonthPositionEditor,
} from "@/components/month-position-dialogs";
import { useCompactLayout } from "@/components/ui/use-compact-layout";
import { monthsForYear, sum } from "@/lib/calc";
import { currency, monthLabel } from "@/lib/format";
import type { FinanceRow } from "@/lib/types";
import { normalizeSearch } from "@/lib/transaction-tools";
import { cn } from "@/lib/utils";

export function Months({ title = "Monate", eyebrow = "JAHRESPLANUNG", initialView, monthExtras }: {
  title?: string;
  eyebrow?: string;
  initialView?: MonthPlanView;
  monthExtras?: ReactNode;
} = {}) {
  const { state, dashboard, update, storageError } = useFinance();
  const compact = useCompactLayout();
  const [chosenView, setView] = useState<MonthPlanView | null>(null);
  const view = chosenView ?? initialView ?? (compact ? "month" : "year");
  const [month, setMonth] = useState(dashboard.currentMonth);
  const year = Number(month.slice(0, 4));
  const months = useMemo(
    () => (view === "year" ? monthsForYear(year) : [month]),
    [view, year, month],
  );
  const timeline = dashboard.timeline.filter((row) =>
    months.includes(row.month),
  );
  const [query, setQuery] = useState("");
  const [area, setArea] = useState<MonthPlanArea>("all");
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<FinanceRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<FinanceRow | null>(null);
  const workspace = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnTarget = useRef<{ id: string; action: "edit" | "delete" } | null>(
    null,
  );
  const filtered = !!query || area !== "all";
  const rows = state.financeRows.filter(
    (row) =>
      (area === "all" || row.kind === area) &&
      normalizeSearch(row.label).includes(normalizeSearch(query)),
  );
  const periodLabel = view === "year" ? String(year) : monthLabel(month);
  const summaries = [
    {
      label: "Einnahmen",
      value: sum(timeline.map((row) => row.income)),
      strong: false,
    },
    {
      label: "Ausgaben",
      value: sum(
        timeline.map(
          (row) => row.fixed + row.variablePlan + row.plannedOneOffs,
        ),
      ),
      strong: false,
    },
    {
      label: "Überschuss",
      value: sum(timeline.map((row) => row.surplus)),
      strong: true,
    },
  ];
  function returnFocus() {
    const target = returnTarget.current;
    const trigger = Array.from(
      workspace.current?.querySelectorAll<HTMLButtonElement>(
        "[data-finance-row-action]",
      ) ?? [],
    ).find(
      (button) =>
        button.dataset.financeRowId === target?.id &&
        button.dataset.financeRowAction === target?.action,
    );
    (trigger ?? addButton.current ?? editButton.current)?.focus();
  }
  function changeValue(row: FinanceRow, key: string, value: number | null) {
    update((current) => ({
      ...current,
      financeRows: current.financeRows.map((item) =>
        item.id === row.id
          ? {
              ...item,
              ...(item.kind === "variable"
                ? { overrides: { ...item.overrides, [key]: value } }
                : {}),
              values: { ...item.values, [key]: value },
            }
          : item,
      ),
    }));
  }
  return (
    <>
      <PageHeading eyebrow={eyebrow} title={title} />
      <section
        aria-label={`Planübersicht ${periodLabel}`}
        className="mb-5 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
          <h2 className="text-sm font-medium">{periodLabel}</h2>
          <span className="text-xs text-muted-foreground">Planwerte</span>
        </div>
        <div className="grid divide-y divide-border/60 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {summaries.map((item) => (
            <article
              key={item.label}
              aria-label={`${item.label} ${periodLabel}`}
              className={cn(
                "flex items-center justify-between gap-3 px-4 py-4 sm:block sm:px-5 sm:py-5",
                item.strong && "bg-primary/5",
              )}
            >
              <h3 className="text-xs text-muted-foreground">{item.label}</h3>
              <FinancialData
                as="p"
                className={cn(
                  "text-lg font-semibold tracking-tight tabular-nums sm:mt-2 sm:text-2xl",
                  item.value < 0 && "text-destructive",
                  item.strong && item.value > 0 && "text-primary",
                )}
              >
                {currency(item.value)}
              </FinancialData>
            </article>
          ))}
        </div>
      </section>
      <section
        ref={workspace}
        aria-label="Monatsplan"
        className="min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm"
      >
        <MonthPlanToolbar
          view={view}
          month={month}
          currentMonth={dashboard.currentMonth}
          query={query}
          area={area}
          editing={editing}
          disabled={!!storageError}
          addRef={addButton}
          editRef={editButton}
          onViewChange={setView}
          onMonthChange={setMonth}
          onQueryChange={setQuery}
          onAreaChange={setArea}
          onEditingChange={() => setEditing((previous) => !previous)}
          onAdd={() => {
            returnTarget.current = null;
            setEditor("new");
          }}
        />
        {filtered && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs text-muted-foreground sm:px-5">
            <FinancialData as="p">
              {rows.length} Positionen · Summen bleiben vollständig.
            </FinancialData>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => {
                setQuery("");
                setArea("all");
              }}
            >
              Filter zurücksetzen
            </Button>
          </div>
        )}
        {filtered && !rows.length ? (
          <FinancialData>
            <EmptyState
              title="Keine Positionen gefunden"
              description="Suche oder Bereich anpassen."
            />
          </FinancialData>
        ) : (
          <MonthPlanGrid
            months={months}
            timeline={timeline}
            rows={rows}
            area={area}
            dashboard={dashboard}
            holidayRanges={state.holidayRanges}
            focused={view === "month"}
            editing={editing}
            disabled={!!storageError}
            onEdit={(row) => {
              returnTarget.current = { id: row.id, action: "edit" };
              setEditor(row);
            }}
            onDelete={(row) => {
              returnTarget.current = { id: row.id, action: "delete" };
              setDeleting(row);
            }}
            onCommit={changeValue}
          />
        )}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
          <span>{view === "year" ? "12 Monate" : "1 Monat"} · EUR</span>
          <Link
            href="/umsaetze"
            className="inline-flex min-h-9 items-center gap-1 rounded-md px-1 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            Umsätze ansehen
            <ArrowUpRight className="size-3.5" />
          </Link>
        </footer>
      </section>
      {view === "month" && month === dashboard.currentMonth && monthExtras && (
        <div className="mt-5 space-y-5">{monthExtras}</div>
      )}
      {months.includes(dashboard.currentMonth) && (
        <div className="mt-5">
          <FixedCostSchedule />
        </div>
      )}
      {editor && (
        <MonthPositionEditor
          row={editor === "new" ? null : editor}
          close={() => setEditor(null)}
          returnFocus={returnFocus}
        />
      )}
      {deleting && (
        <DeleteMonthPositionDialog
          row={deleting}
          close={() => setDeleting(null)}
          returnFocus={returnFocus}
        />
      )}
    </>
  );
}
