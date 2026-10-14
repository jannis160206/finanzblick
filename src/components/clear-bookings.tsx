"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFinance } from "@/components/finance-provider";
import { clearAllBookings } from "@/lib/import/clear-bookings";

export function ClearBookings() {
  const { state, update } = useFinance();
  const [open, setOpen] = useState(false);
  const count = state.transactions.length;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 sm:p-5">
      <div className="max-w-md">
        <h3 className="text-sm font-medium">Alle Buchungen entfernen</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Löscht alle Umsätze, offenen Prüfungen und Fixkostenbelege. Regeln,
          Planung, Ziele und Einstellungen bleiben. Vorher ein Excel-Backup
          erstellen.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={count === 0}
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden="true" className="size-4" />
        Buchungen entfernen
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {count.toLocaleString("de-AT")} Buchungen entfernen?
            </DialogTitle>
            <DialogDescription>
              Das lässt sich nur über ein Backup rückgängig machen. Danach
              können die Kontoauszüge neu importiert werden.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Abbrechen
            </Button>
            <Button
              type="button"
              onClick={() => {
                update(clearAllBookings);
                setOpen(false);
                toast.success("Alle Buchungen wurden entfernt");
              }}
            >
              Endgültig entfernen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
