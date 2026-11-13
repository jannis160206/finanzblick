"use client";

import { useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import {
  Field, PremiumDialog, PremiumDialogBody, PremiumDialogContent, PremiumDialogFooter, PremiumDialogForm, PremiumDialogHeader, PremiumDialogItem,
  PremiumDialogTrigger,
} from "@/components/ui/premium-dialog";
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
  const chips = <div className="flex flex-wrap gap-1.5" aria-label="Aktive Urlaubszeiträume">
    {ranges.map((range) => <span key={`${range.from}|${range.to}`} className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border/70 bg-card py-1 pr-1 pl-3.5 text-xs font-medium tabular-nums">
      {dateLabel(range.from)}–{dateLabel(range.to)}
      <button type="button" disabled={!!storageError} className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none" aria-label={`Urlaub löschen: ${range.from} bis ${range.to}`}
        onClick={() => update((current) => ({ ...current, holidayRanges: current.holidayRanges?.filter((item) => item.from !== range.from || item.to !== range.to) }))}><X className="size-3" /></button>
    </span>)}
  </div>;
  return <>
    <PremiumDialog open={open} onOpenChange={changeOpen}>
      <Tooltip label="Urlaubszeiträume verwalten">
        <PremiumDialogTrigger asChild>
          <Button size={iconOnly ? "icon" : "sm"} variant="outline" className={iconOnly ? "size-11" : undefined}
            disabled={!!storageError} aria-label="Urlaub" title="Urlaub"><CalendarDays className="size-3.5" />{!iconOnly && "Urlaub"}</Button>
        </PremiumDialogTrigger>
      </Tooltip>
      <PremiumDialogContent size="sm">
        <PremiumDialogHeader icon={CalendarDays} title="Urlaubs-Zeiträume" description="Max. 25 Tage je Zeitraum · Wiederkehrende Heimkosten bleiben im Alltag." />
        <PremiumDialogForm noValidate onSubmit={(event) => {
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
          <PremiumDialogBody className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Von" error={error && !from ? error : null}>
                <Input name="from" type="date" required value={from} onChange={(e) => { setFrom(e.target.value); setError(""); }} />
              </Field>
              <Field label="Bis" error={error && from ? error : null}>
                <Input name="to" type="date" required value={to} onChange={(e) => { setTo(e.target.value); setError(""); }} />
              </Field>
            </div>
            {storageError && <p role="alert" className="text-sm font-medium text-destructive">{storageError}</p>}
            <p className="text-xs text-muted-foreground">Speichern und Entfernen wirken sofort.</p>
            {ranges.length > 0 && <PremiumDialogItem className="space-y-3 border-t border-border/60 pt-5">
              <h3 className="eyebrow">Gespeicherte Zeiträume</h3>
              {chips}
            </PremiumDialogItem>}
          </PremiumDialogBody>
          <PremiumDialogFooter><Button type="button" variant="outline" onClick={() => changeOpen(false)}>Fertig</Button><Button type="submit" disabled={!!storageError}>Zeitraum speichern</Button></PremiumDialogFooter>
        </PremiumDialogForm>
      </PremiumDialogContent>
    </PremiumDialog>
  </>;
}
