"use client";

import { Fragment, useRef, useState } from "react";
import Link from "next/link";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFinance } from "@/components/finance-provider";
import { InputLegend, MoneyInput, PageHeading } from "@/components/finance-ui";
import { financeRowValue, monthsForYear, sum } from "@/lib/calc";
import { currency, monthLabel, number } from "@/lib/format";
import {
  financeRowSchema,
  type FinanceRow,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { CategorySelect } from "@/components/category-select";
import { removeFixedPlanRow } from "@/lib/fixed-plan";

function RowEditor({
  row,
  close,
  returnFocus,
}: {
  row: FinanceRow | null;
  close: () => void;
  returnFocus: () => void;
}) {
  const { state, update, storageError } = useFinance();
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
      <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus(); }}>
        <DialogHeader>
          <DialogTitle>
            {row ? "Position bearbeiten" : "Position hinzufügen"}
          </DialogTitle>
          <DialogDescription>
            Gilt für beide Jahre.
          </DialogDescription>
        </DialogHeader>
        <DialogForm
          noValidate
          onSubmit={form.handleSubmit((value) => {
            if (storageError) return;
            if (!row && state.financeRows.length >= 200) {
              form.setError("root", {
                message: "Es sind höchstens 200 Positionen möglich. Entferne zuerst eine nicht mehr benötigte Position.",
              });
              return;
            }
            update((current) => {
              if (row?.fixedSource && value.kind !== "fixed") {
                const next = removeFixedPlanRow(current, row);
                return { ...next, financeRows: [...next.financeRows, { ...value, fixedSource: undefined }] };
              }
              return {
                ...current,
                financeRows: row
                  ? current.financeRows.map((item) => item.id === row.id ? value : item)
                  : [...current.financeRows, value],
              };
            });
            close();
            toast.success("Position gespeichert");
          })}
        >
          <DialogBody className="space-y-5">
          <div>
            <Label htmlFor="row-label">Bezeichnung</Label>
            <Input
              id="row-label"
              className="mt-2"
              autoFocus
              required
              maxLength={100}
              aria-invalid={!!form.formState.errors.label}
              aria-describedby={form.formState.errors.label ? "row-label-error" : undefined}
              {...form.register("label")}
            />
            {form.formState.errors.label && (
              <p id="row-label-error" role="alert" className="mt-2 text-sm text-destructive">
                Bitte eine Bezeichnung mit 1 bis 100 Zeichen eingeben.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="row-kind">Bereich</Label>
            <select
              id="row-kind"
              className="select-input mt-2 w-full"
              {...form.register("kind")}
            >
              <option value="income">Einnahmen</option>
              <option value="fixed">Fixkosten</option>
            </select>
          </div>
          <div>
            <Label htmlFor="row-plan">Kategorie / Planverknüpfung</Label>
            <Controller
              control={form.control}
              name="planCategory"
              render={({ field }) => (
                <CategorySelect
                  id="row-plan"
                  name={field.name}
                  label="Kategorie / Planverknüpfung"
                  className="mt-2"
                  aria-describedby="row-plan-help"
                  allowAll
                  allLabel="Keine Verknüpfung"
                  value={field.value ?? ""}
                  onBlur={field.onBlur}
                  onValueChange={(value) => field.onChange(value || undefined)}
                />
              )}
            />
            <p id="row-plan-help" className="mt-2 text-xs text-muted-foreground">
              Optional: Kategorie für den Budgetplan.
            </p>
          </div>
          {(form.formState.errors.root || storageError) && (
            <p role="alert" className="text-sm text-destructive">
              {storageError ?? form.formState.errors.root?.message}
            </p>
          )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={close}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={!!storageError}>Position speichern</Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

export function Months() {
  const { state, dashboard: d, update, storageError } = useFinance();
  const [year, setYear] = useState(
    Number(state.settings.asOf.slice(0, 4)) === 2027 ? 2027 : 2026,
  );
  const [editor, setEditor] = useState<FinanceRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<FinanceRow | null>(null);
  const [repair, setRepair] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnTarget = useRef<{ id: string; action: "edit" | "delete" } | null>(null);
  const returnFocus = () => {
    const target = returnTarget.current;
    const trigger = Array.from(tableRef.current?.querySelectorAll<HTMLButtonElement>("[data-finance-row-action]") ?? [])
      .find((button) => button.dataset.financeRowId === target?.id && button.dataset.financeRowAction === target?.action);
    (trigger ?? addButton.current)?.focus();
  };
  const months = monthsForYear(year);
  const timeline = d.timeline.filter((row) =>
    row.month.startsWith(String(year)),
  );
  const calculatedRow = (
    label: string,
    values: (number | null)[],
    strong = false,
    title?: string,
  ) => (
    <tr className={strong ? "summary-row" : ""}>
      <th className="sticky-label font-normal" title={title}>{label}</th>
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
          <Button ref={addButton} size="sm" onClick={() => { returnTarget.current = null; setEditor("new"); }}>
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
          <table ref={tableRef} className="month-grid data-table w-full">
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
                            {repair && kind !== "variable" && (
                              <span className="flex">
                                <Button
                                  className="size-6"
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`${row.label} bearbeiten`}
                                  data-finance-row-id={row.id}
                                  data-finance-row-action="edit"
                                  onClick={() => { returnTarget.current = { id: row.id, action: "edit" }; setEditor(row); }}
                                >
                                  <Pencil className="size-3" />
                                </Button>
                                <Button
                                  className="size-6 text-muted-foreground hover:text-destructive"
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`${row.label} löschen`}
                                  data-finance-row-id={row.id}
                                  data-finance-row-action="delete"
                                  onClick={() => { returnTarget.current = { id: row.id, action: "delete" }; setDeleting(row); }}
                                >
                                  <Trash2 className="size-3" />
                                </Button>
                              </span>
                            )}
                          </div>
                        </th>
                        {months.map((month) => (
                          <td key={month}>
                            {repair && (kind !== "variable" || month < d.currentMonth) ? (
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
                                {number(financeRowValue(row, month, d.plan, state.holidayRanges))}
                              </span>
                            )}
                            {repair &&
                              kind === "variable" &&
                              month < d.currentMonth &&
                              row.values[month] == null && (
                                <p className="mt-1 text-right font-mono text-[10px] text-muted-foreground">
                                  {number(financeRowValue(row, month, d.plan, state.holidayRanges))}
                                </p>
                              )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  {kind === "variable" && calculatedRow(
                    "Amex offen",
                    timeline.map((row) => row.amexOpen),
                    false,
                    `Karte ${currency(d.amex.outstanding)} · Eigenanteil ${currency(d.amex.ownOutstanding)} · Rücklage ${currency(d.amex.reserved)}`,
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
          returnFocus={returnFocus}
        />
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent variant="confirmation" onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus(); }}>
          <DialogHeader>
            <DialogTitle>Position löschen?</DialogTitle>
            <DialogDescription>
              Diese Aktion kann nicht rückgängig gemacht werden.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <p className="text-sm">
              „{deleting?.label}“ mit allen Werten für 2026 und 2027 entfernen.
            </p>
            {deleting?.fixedSource && <p className="text-sm">Buchungen bleiben erhalten; Fixkosten-Markierungen entfallen.</p>}
            {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              disabled={!!storageError}
              onClick={() => {
                if (!deleting) return;
                update((current) => removeFixedPlanRow(current, deleting));
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
