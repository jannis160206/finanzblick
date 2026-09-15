"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Trash2 } from "lucide-react";
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
import { InputLegend, MoneyInput, PageHeading } from "@/components/finance-ui";
import { financeRowValue, monthsForYear, sum } from "@/lib/calc";
import { currency, monthLabel, number } from "@/lib/format";
import {
  emptyMonth,
  financeRowSchema,
  type FinanceRow,
  type MonthInput,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { CategoryOptions } from "@/components/category-options";

function RowEditor({
  row,
  close,
}: {
  row: FinanceRow | null;
  close: () => void;
}) {
  const { update } = useFinance();
  const form = useForm<FinanceRow>({
    resolver: zodResolver(financeRowSchema),
    defaultValues: row ?? {
      id: crypto.randomUUID(),
      kind: "fixed",
      label: "",
      values: {},
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {row ? "Position bearbeiten" : "Position hinzufügen"}
          </DialogTitle>
          <DialogDescription>
            Die Position steht in beiden Jahren zur Verfügung.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={form.handleSubmit((value) => {
            update((current) => ({
              ...current,
              financeRows: row
                ? current.financeRows.map((item) =>
                    item.id === row.id ? value : item,
                  )
                : [...current.financeRows, value],
            }));
            close();
            toast.success("Position gespeichert");
          })}
        >
          <div>
            <Label htmlFor="row-label">Bezeichnung</Label>
            <Input
              id="row-label"
              className="editable mt-2"
              autoFocus
              {...form.register("label")}
            />
            {form.formState.errors.label && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {form.formState.errors.label.message}
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="row-kind">Bereich</Label>
            <select
              id="row-kind"
              className="select-input editable mt-2 w-full"
              {...form.register("kind")}
            >
              <option value="income">Einnahmen</option>
              <option value="fixed">Fixkosten</option>
              <option value="variable">Variable Ausgaben</option>
            </select>
          </div>
          <div>
            <Label htmlFor="row-plan">
              Kategorie / Planverknüpfung
            </Label>
            <select
              id="row-plan"
              className="select-input editable mt-2 w-full"
              {...form.register("planCategory", {
                setValueAs: (value) => value || undefined,
              })}
            >
              <option value="">Keine Verknüpfung</option>
              <CategoryOptions />
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={close}>
              Abbrechen
            </Button>
            <Button type="submit">Position speichern</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Months() {
  const { state, dashboard: d, update } = useFinance();
  const [year, setYear] = useState(
    Number(state.settings.asOf.slice(0, 4)) === 2027 ? 2027 : 2026,
  );
  const [editor, setEditor] = useState<FinanceRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<FinanceRow | null>(null);
  const [repair, setRepair] = useState(false);
  const months = monthsForYear(year);
  const timeline = d.timeline.filter((row) =>
    row.month.startsWith(String(year)),
  );
  const setInput = (
    month: string,
    updater: (input: MonthInput) => MonthInput,
  ) =>
    update((current) => ({
      ...current,
      months: {
        ...current.months,
        [month]: updater(current.months[month] ?? emptyMonth()),
      },
    }));
  const calculatedRow = (
    label: string,
    values: (number | null)[],
    strong = false,
  ) => (
    <tr className={strong ? "summary-row" : ""}>
      <th className="sticky-label font-normal">{label}</th>
      {values.map((value, index) => (
        <td
          key={months[index]}
          className={cn(
            "text-right font-mono",
            strong && "font-semibold",
            value !== null && value < 0 && "text-destructive",
          )}
        >
          {value === null ? "—" : number(value)}
        </td>
      ))}
    </tr>
  );
  return (
    <>
      <PageHeading
        eyebrow="JAHRESPLANUNG"
        title="Monate"
        description="Automatische Monatsvorschau"
      >
        {repair && <InputLegend />}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setRepair(!repair)}
          aria-pressed={repair}
        >
          Ausnahmebearbeitung
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link href="/plan">Budgetdetails</Link>
        </Button>
        <div className="flex rounded-lg border bg-card p-1">
          {[2026, 2027].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={year === value ? "secondary" : "ghost"}
              className="h-7"
              onClick={() => setYear(value)}
            >
              {value}
            </Button>
          ))}
        </div>
        {repair && (
          <Button size="sm" onClick={() => setEditor("new")}>
            <Plus className="size-4" />
            Position
          </Button>
        )}
      </PageHeading>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        {[
          {
            label: `Einnahmen ${year}`,
            value: sum(timeline.map((row) => row.income)),
          },
          {
            label: `Fixkosten ${year}`,
            value: sum(timeline.map((row) => row.fixed)),
          },
          {
            label: `Überschuss ${year}`,
            value: sum(timeline.map((row) => row.surplus)),
          },
        ].map((item) => (
          <div className="panel p-4" key={item.label}>
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="mt-2 text-xl font-semibold tabular-nums">
              {currency(item.value)}
            </p>
          </div>
        ))}
      </div>
      <section className="panel overflow-hidden">
        <div className="max-h-[75vh] overflow-auto">
          <table className="month-grid data-table w-full">
            <thead>
              <tr>
                <th className="sticky-label min-w-64">Position · EUR</th>
                {months.map((month) => (
                  <th
                    key={month}
                    className={cn(
                      "min-w-32 text-right",
                      month === d.currentMonth && "text-primary",
                    )}
                  >
                    {monthLabel(month, true)}
                    {month === d.currentMonth && (
                      <span className="ml-1 text-primary">•</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["income", "fixed", "variable"] as const).map((kind) => (
                <Fragment key={kind}>
                  <tr className="section-row">
                    <th colSpan={13}>
                      {kind === "income"
                        ? "Einnahmen"
                        : kind === "fixed"
                          ? "Fixkosten"
                          : "Variable Ausgaben"}
                    </th>
                  </tr>
                  {state.financeRows
                    .filter((row) => row.kind === kind)
                    .map((row) => (
                      <tr key={row.id}>
                        <th className="sticky-label">
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className="max-w-40 truncate text-xs font-normal"
                              title={row.label}
                            >
                              {row.label}
                            </span>
                            {repair && (
                              <span className="flex">
                                <Button
                                  className="size-6"
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`${row.label} bearbeiten`}
                                  onClick={() => setEditor(row)}
                                >
                                  <Pencil className="size-3" />
                                </Button>
                                <Button
                                  className="size-6 text-muted-foreground hover:text-destructive"
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`${row.label} löschen`}
                                  onClick={() => setDeleting(row)}
                                >
                                  <Trash2 className="size-3" />
                                </Button>
                              </span>
                            )}
                          </div>
                        </th>
                        {months.map((month) => (
                          <td key={month}>
                            {repair ? (
                              <MoneyInput
                                label={`${row.label} ${monthLabel(month)}`}
                                value={
                                  row.values[month] ??
                                  (kind === "variable" ? null : 0)
                                }
                                nullable={kind === "variable"}
                                onCommit={(value) =>
                                  update((current) => ({
                                    ...current,
                                    financeRows: current.financeRows.map(
                                      (item) =>
                                        item.id === row.id
                                          ? {
                                              ...item,
                                              ...(item.kind === "variable"
                                                ? {
                                                    overrides: {
                                                      ...item.overrides,
                                                      [month]: value,
                                                    },
                                                  }
                                                : {}),
                                              values: {
                                                ...item.values,
                                                [month]: value,
                                              },
                                            }
                                          : item,
                                    ),
                                  }))
                                }
                              />
                            ) : (
                              <span
                                className="block text-right font-mono text-xs"
                                aria-label={`${row.label} ${monthLabel(month)}`}
                              >
                                {number(financeRowValue(row, month, d.plan))}
                              </span>
                            )}
                            {repair &&
                              kind === "variable" &&
                              row.values[month] == null && (
                                <p className="mt-1 text-right font-mono text-[10px] text-muted-foreground">
                                  {number(financeRowValue(row, month, d.plan))}
                                </p>
                              )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  {repair && kind === "variable" && (
                    <tr>
                      <th className="sticky-label text-xs font-normal">
                        Gesamtbudget ersetzen
                      </th>
                      {months.map((month) => (
                        <td key={month}>
                          <MoneyInput
                            label={`Variabel gesamt ${month}`}
                            nullable
                            value={
                              state.months[month]?.variableOverride ?? null
                            }
                            onCommit={(value) =>
                              setInput(month, (input) => ({
                                ...input,
                                variableOverride: value,
                              }))
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  )}
                  {calculatedRow(
                    kind === "income"
                      ? "Einnahmen gesamt"
                      : kind === "fixed"
                        ? "Fixkosten gesamt"
                        : "Variabel gesamt",
                    timeline.map((row) =>
                      kind === "income"
                        ? row.income
                        : kind === "fixed"
                          ? row.fixed
                          : row.variablePlan,
                    ),
                    true,
                  )}
                </Fragment>
              ))}
              {calculatedRow(
                "Überschuss",
                timeline.map((row) => row.surplus),
                true,
              )}
            </tbody>
          </table>
        </div>
      </section>
      {editor && (
        <RowEditor
          row={editor === "new" ? null : editor}
          close={() => setEditor(null)}
        />
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Position löschen?</DialogTitle>
            <DialogDescription>
              „{deleting?.label}“ und alle zugehörigen Werte für 2026 und 2027
              werden entfernt.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                update((current) => ({
                  ...current,
                  financeRows: current.financeRows.filter(
                    (row) => row.id !== deleting?.id,
                  ),
                }));
                setDeleting(null);
                toast.success("Position gelöscht");
              }}
            >
              Position löschen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
