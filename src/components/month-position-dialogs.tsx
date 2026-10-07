"use client";

import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { CategorySelect } from "@/components/category-select";
import { useFinance } from "@/components/finance-provider";
import { removeFixedPlanRow } from "@/lib/fixed-plan";
import { financeRowSchema, type FinanceRow } from "@/lib/types";

export function MonthPositionEditor({
  row,
  close,
  returnFocus,
}: {
  row: FinanceRow | null;
  close: () => void;
  returnFocus: () => void;
}) {
  const { state, update, storageError } = useFinance();
  const missing =
    !!row && !state.financeRows.some((item) => item.id === row.id);
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
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {row ? "Position bearbeiten" : "Position hinzufügen"}
          </DialogTitle>
          <DialogDescription>
            Bezeichnung und Bereich gelten für beide Jahre.
          </DialogDescription>
        </DialogHeader>
        <DialogForm
          noValidate
          onSubmit={form.handleSubmit((value) => {
            if (storageError || missing) {
              form.setError("root", {
                message:
                  storageError ?? "Diese Position wurde inzwischen entfernt.",
              });
              return;
            }
            if (!row && state.financeRows.length >= 200) {
              form.setError("root", {
                message:
                  "Es sind höchstens 200 Positionen möglich. Entferne zuerst eine nicht mehr benötigte Position.",
              });
              return;
            }
            update((current) => {
              if (!row)
                return {
                  ...current,
                  financeRows: [...current.financeRows, value],
                };
              const existing = current.financeRows.find(
                (item) => item.id === row.id,
              );
              if (!existing)
                throw new Error(
                  "Diese Position wurde inzwischen entfernt. Bitte erneut öffnen.",
                );
              const revised = {
                ...existing,
                label: value.label,
                kind: value.kind,
                planCategory: value.planCategory,
              };
              if (revised.fixedSource && revised.kind !== "fixed") {
                const next = removeFixedPlanRow(current, revised);
                return {
                  ...next,
                  financeRows: [
                    ...next.financeRows,
                    { ...revised, fixedSource: undefined },
                  ],
                };
              }
              return {
                ...current,
                financeRows: current.financeRows.map((item) =>
                  item.id === row.id ? revised : item,
                ),
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
                aria-describedby={
                  form.formState.errors.label ? "row-label-error" : undefined
                }
                {...form.register("label")}
              />
              {form.formState.errors.label && (
                <p
                  id="row-label-error"
                  role="alert"
                  className="mt-2 text-sm text-destructive"
                >
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
                    onValueChange={(value) =>
                      field.onChange(value || undefined)
                    }
                  />
                )}
              />
              <p
                id="row-plan-help"
                className="mt-2 text-xs text-muted-foreground"
              >
                Optional: Kategorie für den Budgetplan.
              </p>
            </div>
            {(form.formState.errors.root || storageError || missing) && (
              <p role="alert" className="text-sm text-destructive">
                {storageError ??
                  (missing
                    ? "Diese Position wurde inzwischen entfernt. Bitte schließen."
                    : form.formState.errors.root?.message)}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={close}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={!!storageError || missing}>
              Position speichern
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteMonthPositionDialog({
  row,
  close,
  returnFocus,
}: {
  row: FinanceRow;
  close: () => void;
  returnFocus: () => void;
}) {
  const { state, update, storageError } = useFinance();
  const currentRow = state.financeRows.find((item) => item.id === row.id);
  const missing = !currentRow;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        variant="confirmation"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Position löschen?</DialogTitle>
          <DialogDescription>
            Diese Aktion kann nicht rückgängig gemacht werden.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm">
            „{row.label}“ mit allen Werten für 2026 und 2027 entfernen.
          </p>
          {row.fixedSource && (
            <p className="text-sm">
              Buchungen bleiben erhalten; Fixkosten-Markierungen entfallen.
            </p>
          )}
          {(storageError || missing) && (
            <p role="alert" className="text-sm text-destructive">
              {storageError ??
                "Diese Position wurde inzwischen entfernt. Bitte schließen."}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Abbrechen
          </Button>
          <Button
            variant="destructive"
            disabled={!!storageError || missing}
            onClick={() => {
              update((current) => {
                const existing = current.financeRows.find(
                  (item) => item.id === row.id,
                );
                if (!existing)
                  throw new Error(
                    "Diese Position wurde inzwischen entfernt. Bitte erneut öffnen.",
                  );
                return removeFixedPlanRow(current, existing);
              });
              close();
              toast.success("Position gelöscht");
            }}
          >
            Position löschen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
