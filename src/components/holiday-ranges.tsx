"use client";

import { useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { appStateSchema } from "@/lib/types";
import { dateLabel } from "@/lib/format";

export function HolidayRanges() {
  const { state, update, storageError } = useFinance();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  const ranges = state.holidayRanges ?? [];
  const chips = <div className="flex flex-wrap gap-1" aria-label="Aktive Urlaubszeiträume">
    {ranges.map((range) => <span key={`${range.from}|${range.to}`} className="inline-flex items-center gap-1 rounded-md border bg-muted/30 px-2 py-1 text-[10px]">
      {dateLabel(range.from)}–{dateLabel(range.to)}
      <button type="button" disabled={!!storageError} className="rounded p-1 hover:bg-muted" aria-label={`Urlaub löschen: ${range.from} bis ${range.to}`}
        onClick={() => update((current) => ({ ...current, holidayRanges: current.holidayRanges?.filter((item) => item.from !== range.from || item.to !== range.to) }))}><X className="size-3" /></button>
    </span>)}
  </div>;
  return <>
    <Button size="sm" variant="outline" disabled={!!storageError} onClick={() => { setOpen(true); setError(""); }}><CalendarDays className="size-3.5" />Urlaub</Button>
    {!open && chips}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Urlaubs-Zeiträume</DialogTitle><DialogDescription>Max. 25 Tage je Zeitraum · Wiederkehrende Heimkosten bleiben im Alltag.</DialogDescription></DialogHeader>
        {chips}
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          const parsed = appStateSchema.shape.holidayRanges.safeParse([...ranges, { from, to }]);
          if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
          update((current) => ({ ...current, holidayRanges: parsed.data }));
          setFrom(""); setTo(""); setError("");
        }}>
          <div className="grid grid-cols-2 gap-3">
            <div><Label htmlFor="holiday-from">Von</Label><Input id="holiday-from" className="mt-2" type="date" required value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div><Label htmlFor="holiday-to">Bis</Label><Input id="holiday-to" className="mt-2" type="date" required value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Fertig</Button><Button type="submit" disabled={!!storageError}>Zeitraum speichern</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
