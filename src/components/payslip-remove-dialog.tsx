"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { usePayslipMutation } from "@/components/payslip-mutation";
import { payslipDraftLabel } from "@/components/payslip-upload";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";
import { removeReviewedPayslip } from "@/lib/payslip-storage";

export type PayslipRemoval = { entry: Payslip; trigger: HTMLButtonElement | null };

/** Removes one stored payslip after confirmation; the original PDF and bank bookings stay untouched. */
export function PayslipRemoveDialog({ target, onClose, fallbackFocus }: {
  target: PayslipRemoval | null;
  onClose: () => void;
  fallbackFocus?: () => void;
}) {
  const { state, update, storageError } = useFinance();
  const mutate = usePayslipMutation(state, update);
  const [error, setError] = useState("");
  const deleting = target?.entry;
  const close = () => { setError(""); onClose(); };
  return (
    <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent variant="confirmation" onCloseAutoFocus={(event) => {
        event.preventDefault();
        const trigger = target?.trigger;
        if (trigger?.isConnected && !trigger.disabled) trigger.focus();
        else fallbackFocus?.();
      }}>
        <DialogHeader>
          <DialogTitle>Lohnabrechnung entfernen?</DialogTitle>
          <DialogDescription>Nur gespeicherte Rechenwerte entfernen; Original-PDF und Kontoumsätze bleiben unverändert.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {deleting && <p className="mb-2 text-sm">{payslipDraftLabel(deleting, 0)} · {deleting.employer}</p>}
          {(error || storageError) && <p role="alert" className="text-sm text-destructive">{storageError || error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Abbrechen</Button>
          <Button variant="destructive" disabled={!!storageError} onClick={() => {
            if (!deleting) return;
            if (storageError) { setError(storageError); return; }
            mutate((current) => {
              const payslips = removeReviewedPayslip(current.payslips ?? [], deleting);
              const matches = (entry: { year: number; employer: string }) => entry.year === deleting.year &&
                payrollEmployerKey(entry.employer) === payrollEmployerKey(deleting.employer);
              return { ...current, payslips,
                payrollForecasts: current.payrollForecasts?.filter((forecast) => !matches(forecast) || payslips?.some(matches))
                  .map((forecast) => matches(forecast) ? { ...forecast, standardPayrollConfirmed: false } : forecast),
              };
            }, () => {
              close();
              toast.success("Lohnabrechnung entfernt");
            }, (cause) => setError(cause.message));
          }}>Entfernen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
