"use client";

import { useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogForm, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { appStateSchema } from "@/lib/types";
import { dateLabel } from "@/lib/format";

export function HolidayRanges({ iconOnly = false }: { iconOnly?: boolean }) {
  const { state, update, storageError } = useFinance();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  const ranges = state.holidayRanges ?? [];
  const changeOpen = (value: boolean) => {
    setOpen(value);
    setFrom("");
    setTo("");
    setError("");
  };
  const chips = <div className="flex flex-wrap gap-1" aria-label="Aktive Urlaubszeiträume">
    {ranges.map((range) => <span key={`${range.from}|${range.to}`} className="inline-flex items-center gap-1 rounded-md border bg-muted/30 px-2 py-1 text-2xs">
      {dateLabel(range.from)}–{dateLabel(range.to)}
      <button type="button" disabled={!!storageError} className="rounded p-1 text-destructive hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Urlaub löschen: ${range.from} bis ${range.to}`}
        onClick={() => update((current) => ({ ...current, holidayRanges: current.holidayRanges?.filter((item) => item.from !== range.from || item.to !== range.to) }))}><X className="size-3" /></button>
    </span>)}
  </div>;
  return <>
    <Dialog open={open} onOpenChange={changeOpen}>
      <Tooltip label="Urlaubszeiträume verwalten">
        <DialogTrigger asChild>
          <Button size={iconOnly ? "icon" : "sm"} variant="outline" className={iconOnly ? "size-11" : undefined}
            disabled={!!storageError} aria-label="Urlaub" title="Urlaub"><CalendarDays className="size-3.5" />{!iconOnly && "Urlaub"}</Button>
        </DialogTrigger>
      </Tooltip>
      <DialogContent>
        <DialogHeader><DialogTitle>Urlaubs-Zeiträume</DialogTitle><DialogDescription>Max. 25 Tage je Zeitraum · Wiederkehrende Heimkosten bleiben im Alltag.</DialogDescription></DialogHeader>
        <DialogForm noValidate onSubmit={(event) => {
          event.preventDefault();
          if (storageError) return;
          if (!from || !to) {
            setError("Bitte Anfang und Ende des Urlaubszeitraums angeben.");
            const input = event.currentTarget.elements.namedItem(!from ? "from" : "to");
            if (input instanceof HTMLElement) input.focus();
            return;
          }
          const parsed = appStateSchema.shape.holidayRanges.safeParse([...ranges, { from, to }]);
          if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
          update((current) => ({ ...current, holidayRanges: parsed.data }));
          setFrom(""); setTo(""); setError("");
        }}>
          <DialogBody className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <div><Label htmlFor="holiday-from">Von</Label><Input id="holiday-from" name="from" className="mt-2" type="date" required value={from} aria-invalid={!!error} aria-describedby={error ? "holiday-range-error" : undefined} onChange={(e) => { setFrom(e.target.value); setError(""); }} /></div>
              <div><Label htmlFor="holiday-to">Bis</Label><Input id="holiday-to" name="to" className="mt-2" type="date" required value={to} aria-invalid={!!error} aria-describedby={error ? "holiday-range-error" : undefined} onChange={(e) => { setTo(e.target.value); setError(""); }} /></div>
            </div>
            {error && <p id="holiday-range-error" role="alert" className="text-sm text-destructive">{error}</p>}
            {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
            <p className="text-xs text-muted-foreground">Speichern und Entfernen wirken sofort.</p>
            {ranges.length > 0 && <section className="space-y-3 border-t pt-5">
              <h3 className="text-sm font-medium">Gespeicherte Zeiträume</h3>
              {chips}
            </section>}
          </DialogBody>
          <DialogFooter><Button type="button" variant="outline" onClick={() => changeOpen(false)}>Fertig</Button><Button type="submit" disabled={!!storageError}>Zeitraum speichern</Button></DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  </>;
}
