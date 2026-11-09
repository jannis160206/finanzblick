"use client";

import type { Ref } from "react";
import { ChevronLeft, ChevronRight, LayoutList, Pencil, Plus, Search, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputLegend } from "@/components/finance-ui";
import { FinancialData } from "@/components/financial-data";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { planningEndYear, planningMonths, planningStartYear } from "@/lib/planning-range";
import { monthLabel } from "@/lib/format";
import type { FinanceRow } from "@/lib/types";

export type MonthPlanView = "month" | "year";
export type MonthPlanDisplay = "overview" | "table";
export type MonthPlanArea = "all" | FinanceRow["kind"];
export const monthPlanAreas = [
  { value: "all", label: "Alle Bereiche" },
  { value: "income", label: "Einnahmen" },
  { value: "fixed", label: "Fixkosten" },
  { value: "variable", label: "Variable Ausgaben" },
] as const;

export function MonthPlanToolbar({
  view,
  month,
  currentMonth,
  query,
  area,
  editing,
  disabled,
  addRef,
  editRef,
  onViewChange,
  onMonthChange,
  onQueryChange,
  onAreaChange,
  onEditingChange,
  onAdd,
  display = "table",
  onDisplayChange,
}: {
  display?: MonthPlanDisplay;
  onDisplayChange?: (display: MonthPlanDisplay) => void;
  view: MonthPlanView;
  month: string;
  currentMonth: string;
  query: string;
  area: MonthPlanArea;
  editing: boolean;
  disabled: boolean;
  addRef: Ref<HTMLButtonElement>;
  editRef: Ref<HTMLButtonElement>;
  onViewChange: (view: MonthPlanView) => void;
  onMonthChange: (month: string) => void;
  onQueryChange: (query: string) => void;
  onAreaChange: (area: MonthPlanArea) => void;
  onEditingChange: () => void;
  onAdd: () => void;
}) {
  const allMonths = planningMonths(currentMonth);
  const index = allMonths.indexOf(month);
  const year = Number(month.slice(0, 4));
  return (
    <div className="space-y-4 border-b border-border/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="Zeitraumansicht"
            value={view}
            onChange={onViewChange}
            options={[{ value: "month", label: "Monat" }, { value: "year", label: "Jahr" }]}
          />
          {view === "year" ? (
            <div role="group" aria-label="Planungsjahr" className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-10"
                aria-label="Vorheriges Jahr"
                disabled={year <= planningStartYear}
                onClick={() => onMonthChange(`${year - 1}${month.slice(4)}`)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span aria-live="polite" className="min-w-14 text-center text-sm font-medium tabular-nums">{year}</span>
              <Button
                size="icon"
                variant="ghost"
                className="size-10"
                aria-label="Nächstes Jahr"
                disabled={year >= planningEndYear(currentMonth)}
                onClick={() => onMonthChange(`${year + 1}${month.slice(4)}`)}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          ) : (
            <div className="flex min-w-0 max-w-full items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-10"
                aria-label="Vorheriger Monat"
                disabled={index <= 0}
                onClick={() => onMonthChange(allMonths[index - 1])}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <select
                aria-label="Planungsmonat"
                className="select-input min-w-0 max-w-full font-medium"
                value={month}
                onChange={(event) => onMonthChange(event.target.value)}
              >
                {allMonths.map((value) => (
                  <option key={value} value={value}>
                    {monthLabel(value, true)}
                  </option>
                ))}
              </select>
              <Button
                size="icon"
                variant="ghost"
                className="size-10"
                aria-label="Nächster Monat"
                disabled={index >= allMonths.length - 1}
                onClick={() => onMonthChange(allMonths[index + 1])}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
          {(view === "year" || month !== currentMonth) && (
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-muted-foreground"
              onClick={() => {
                onMonthChange(currentMonth);
                onViewChange("month");
              }}
            >
              Aktueller Monat
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {view === "month" && onDisplayChange && !editing && (
            <SegmentedControl
              label="Monatsdarstellung"
              value={display}
              onChange={onDisplayChange}
              options={[
                { value: "overview", label: "Übersicht", icon: LayoutList },
                { value: "table", label: "Tabelle", icon: Table2 },
              ]}
            />
          )}
          <Button
            ref={editRef}
            size="sm"
            variant={editing ? "outline" : "ghost"}
            disabled={disabled}
            aria-pressed={editing}
            onClick={onEditingChange}
          >
            <Pencil className="size-3.5" />
            {editing ? "Bearbeitung beenden" : "Plan bearbeiten"}
          </Button>
          {editing && (
            <Button ref={addRef} size="sm" disabled={disabled} onClick={onAdd}>
              <Plus className="size-4" />
              Position hinzufügen
            </Button>
          )}
        </div>
      </div>
      {(view === "year" || display === "table" || editing) && <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <FinancialData className="relative min-w-0">
          <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Positionen suchen"
            placeholder="Position suchen …"
            className="h-10 pl-9"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </FinancialData>
        <select
          aria-label="Planbereich filtern"
          className="select-input w-full min-w-0"
          value={area}
          onChange={(event) => {
            const option = monthPlanAreas.find(
              (item) => item.value === event.target.value,
            );
            if (option) onAreaChange(option.value);
          }}
        >
          {monthPlanAreas.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>}
      {editing && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            Manuelle Ausnahmen · aktuelle und künftige variable Budgets bleiben
            automatisch.
          </span>
          <InputLegend />
        </div>
      )}
    </div>
  );
}
