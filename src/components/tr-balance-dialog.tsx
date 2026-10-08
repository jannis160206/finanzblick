"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
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
import { number } from "@/lib/format";
import { parseStatementAmount } from "@/lib/import/statements";
import { trBalanceSchema } from "@/lib/types";

export function TRBalanceDialog({
  close,
  returnFocus,
}: {
  close: () => void;
  returnFocus: () => void;
}) {
  const { state, dashboard, update, storageError } = useFinance();
  const [source] = useState(() => JSON.stringify(state.trBalances ?? []));
  const [amount, setAmount] = useState(() =>
    number(dashboard.actual.Notgroschen),
  );
  const [date, setDate] = useState(state.settings.asOf);
  const [edited, setEdited] = useState(false);
  const balance = parseStatementAmount(amount);
  const parsed = trBalanceSchema.safeParse({ balance, date });
  const amountInvalid = balance === null || balance < 0;
  const dateInvalid =
    !trBalanceSchema.shape.date.safeParse(date).success ||
    date > state.settings.asOf;
  const stale = source !== JSON.stringify(state.trBalances ?? []);
  const full =
    (state.trBalances?.length ?? 0) >= 10000 &&
    !state.trBalances?.some((row) => row.date === date);
  const blocked =
    storageError ??
    (stale
      ? "Der Kontostand wurde inzwischen geändert. Bitte schließen und erneut öffnen."
      : full
        ? "Es sind höchstens 10.000 Kontostände möglich."
        : null);
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
          <DialogTitle>Kontostand aktualisieren</DialogTitle>
          <DialogDescription>
            Trade Republic · nur der Notgroschen. Revolut und Zinssätze bleiben
            unverändert.
          </DialogDescription>
        </DialogHeader>
        <DialogForm
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!parsed.success || dateInvalid || blocked) {
              setEdited(true);
              return;
            }
            update((current) => ({
              ...current,
              trBalances: [
                ...(current.trBalances ?? []).filter(
                  (row) => row.date !== parsed.data.date,
                ),
                parsed.data,
              ],
            }));
            close();
            toast.success("Kontostand gespeichert");
          }}
        >
          <DialogBody className="space-y-5">
            <div>
              <Label htmlFor="tr-pocket-balance">Kontostand (€)</Label>
              <Input
                id="tr-pocket-balance"
                aria-label="TR Kontostand"
                className="mt-2"
                inputMode="decimal"
                autoFocus
                value={amount}
                required
                aria-invalid={edited && amountInvalid}
                aria-describedby={
                  edited && amountInvalid ? "tr-pocket-amount-error" : undefined
                }
                onChange={(event) => {
                  setAmount(event.target.value);
                  setEdited(true);
                }}
              />
              {edited && amountInvalid && (
                <p
                  id="tr-pocket-amount-error"
                  role="alert"
                  className="mt-2 text-sm text-destructive"
                >
                  Gültigen Betrag ab 0 € mit höchstens zwei Nachkommastellen
                  eingeben.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="tr-pocket-date">Standdatum</Label>
              <Input
                id="tr-pocket-date"
                aria-label="TR Standdatum"
                className="mt-2"
                type="date"
                max={state.settings.asOf}
                value={date}
                required
                aria-invalid={edited && dateInvalid}
                aria-describedby={
                  edited && dateInvalid ? "tr-pocket-date-error" : undefined
                }
                onChange={(event) => {
                  setDate(event.target.value);
                  setEdited(true);
                }}
              />
              {edited && dateInvalid && (
                <p
                  id="tr-pocket-date-error"
                  role="alert"
                  className="mt-2 text-sm text-destructive"
                >
                  Gültiges Datum bis zum aktuellen Stand angeben.
                </p>
              )}
            </div>
            {blocked && (
              <p role="alert" className="text-sm text-destructive">
                {blocked}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Abbrechen
            </Button>
            <Button
              type="submit"
              disabled={!parsed.success || dateInvalid || !!blocked}
            >
              Kontostand speichern
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
