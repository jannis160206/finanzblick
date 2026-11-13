"use client";

import { useState } from "react";
import { CalendarDays, Pencil, Plane, X } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import {
  Field, PremiumDialog, PremiumDialogBody, PremiumDialogContent, PremiumDialogFooter, PremiumDialogForm, PremiumDialogHeader, PremiumDialogItem,
  PremiumDialogTrigger,
} from "@/components/ui/premium-dialog";
import { RangeCalendar, daysInclusive, type DateRange } from "@/components/ui/range-calendar";
import { appStateSchema } from "@/lib/types";
import { dateLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const MAX_DAYS = 25;
const sameRange = (a: DateRange, b: DateRange) => a.from === b.from && a.to === b.to;

function rangeStatus(range: DateRange, today: string) {
  if (range.to < today) return "vorbei";
  if (range.from > today) return "geplant";
  return "läuft gerade";
}

export function HolidayRanges({ iconOnly = false }: { iconOnly?: boolean }) {
  const { state, update, storageError } = useFinance();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<DateRange | null>(null);
  const ranges = state.holidayRanges ?? [];
  const today = state.settings.asOf;
  const reset = () => {
    setFrom("");
    setTo("");
    setError("");
    setEditing(null);
  };
  const changeOpen = (value: boolean) => {
    setOpen(value);
    reset();
  };
  const length = from && to && to >= from ? daysInclusive(from, to) : 0;
  const tooLong = length > MAX_DAYS;
  const backwards = !!from && !!to && to < from;
  const remove = (range: DateRange) => {
    update((current) => ({ ...current, holidayRanges: current.holidayRanges?.filter((item) => !sameRange(item, range)) }));
    if (editing && sameRange(editing, range)) reset();
  };
  const sorted = [...ranges].sort((a, b) => b.from.localeCompare(a.from));
  return <>
    <PremiumDialog open={open} onOpenChange={changeOpen}>
      <Tooltip label="Urlaubszeiträume verwalten">
        <PremiumDialogTrigger asChild>
          <Button size={iconOnly ? "icon" : "sm"} variant={iconOnly ? "ghost" : "outline"} className={iconOnly ? "size-10 rounded-xl" : undefined}
            disabled={!!storageError} aria-label="Urlaub" title="Urlaub"><CalendarDays className="size-3.5" />{!iconOnly && "Urlaub"}</Button>
        </PremiumDialogTrigger>
      </Tooltip>
      <PremiumDialogContent size="md" snapPoints={[0.92]}>
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
          const rest = editing ? ranges.filter((item) => !sameRange(item, editing)) : ranges;
          const parsed = appStateSchema.shape.holidayRanges.safeParse([...rest, { from, to }]);
          if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
          update((current) => ({ ...current, holidayRanges: parsed.data }));
          reset();
        }}>
          <PremiumDialogBody className="space-y-6">
            {sorted.length > 0 && <PremiumDialogItem className="space-y-2">
              <h3 className="eyebrow px-1">Gespeicherte Zeiträume</h3>
              <div aria-label="Aktive Urlaubszeiträume" className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card">
                {sorted.map((range) => {
                  const status = rangeStatus(range, today);
                  const active = !!editing && sameRange(editing, range);
                  return <div key={`${range.from}|${range.to}`} className={cn("flex items-center gap-3 px-3 py-2.5 transition-colors motion-reduce:transition-none", active && "bg-accent-muted")}>
                    <span aria-hidden="true" className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl",
                      status === "läuft gerade" ? "bg-primary text-primary-foreground" : "bg-accent-muted text-primary")}>
                      <Plane className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium tabular-nums">{dateLabel(range.from)}–{dateLabel(range.to)}</span>
                      <span className="block text-xs text-muted-foreground">{daysInclusive(range.from, range.to)} Tage · {status}</span>
                    </span>
                    <Tooltip label="Bearbeiten">
                      <Button type="button" size="icon-sm" variant="ghost" disabled={!!storageError} aria-label={`Urlaub bearbeiten: ${range.from} bis ${range.to}`}
                        onClick={() => { setEditing(range); setFrom(range.from); setTo(range.to); setError(""); }}>
                        <Pencil />
                      </Button>
                    </Tooltip>
                    <Tooltip label="Löschen">
                      <Button type="button" size="icon-sm" variant="ghost" disabled={!!storageError} className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Urlaub löschen: ${range.from} bis ${range.to}`} onClick={() => remove(range)}>
                        <X />
                      </Button>
                    </Tooltip>
                  </div>;
                })}
              </div>
            </PremiumDialogItem>}
            <PremiumDialogItem className="space-y-3">
              <h3 className="eyebrow px-1">{editing ? "Zeitraum bearbeiten" : "Neuer Zeitraum"}</h3>
              <RangeCalendar value={{ from, to }} today={today} marked={ranges.filter((range) => !editing || !sameRange(range, editing))}
                label="Urlaub im Kalender wählen" disabled={!!storageError}
                onChange={(range) => { setFrom(range.from); setTo(range.to); setError(""); }} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Von" error={error && !from ? error : null}>
                  <Input name="from" type="date" required value={from} className="h-11" onChange={(e) => { setFrom(e.target.value); setError(""); }} />
                </Field>
                <Field label="Bis" error={error && from ? error : backwards ? "Liegt vor dem Anfang." : null}>
                  <Input name="to" type="date" required value={to} className="h-11" onChange={(e) => { setTo(e.target.value); setError(""); }} />
                </Field>
              </div>
              <div aria-live="polite" className="space-y-1.5 rounded-2xl bg-surface-sunken/70 px-4 py-3">
                <p className={cn("flex items-baseline justify-between gap-3 text-sm", tooLong && "text-destructive")}>
                  <span className="font-medium">{length ? `${length} ${length === 1 ? "Tag" : "Tage"}` : from ? "Ende im Kalender antippen" : "Anfang im Kalender antippen"}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">max. {MAX_DAYS}</span>
                </p>
                <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full w-full origin-left rounded-full transition-transform duration-300 ease-soft motion-reduce:transition-none", tooLong ? "bg-destructive" : "bg-primary")}
                    style={{ transform: `scaleX(${Math.min(1, length / MAX_DAYS)})` }} />
                </div>
              </div>
            </PremiumDialogItem>
            {storageError && <p role="alert" className="text-sm font-medium text-destructive">{storageError}</p>}
            <p className="text-xs text-muted-foreground">Speichern und Entfernen wirken sofort.</p>
          </PremiumDialogBody>
          <PremiumDialogFooter>
            {editing
              ? <Button type="button" variant="ghost" className="sm:mr-auto" onClick={reset}>Bearbeiten abbrechen</Button>
              : <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Fertig</Button>}
            <Button type="submit" disabled={!!storageError}>{editing ? "Änderung speichern" : "Zeitraum speichern"}</Button>
          </PremiumDialogFooter>
        </PremiumDialogForm>
      </PremiumDialogContent>
    </PremiumDialog>
  </>;
}
