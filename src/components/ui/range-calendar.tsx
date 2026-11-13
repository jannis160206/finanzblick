"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type DateRange = { from: string; to: string };

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const longDay = new Intl.DateTimeFormat("de-AT", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const monthTitle = new Intl.DateTimeFormat("de-AT", { month: "long", year: "numeric", timeZone: "UTC" });

const toTime = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (time: number) => new Date(time).toISOString().slice(0, 10);
export const addDaysIso = (iso: string, days: number) => toIso(toTime(iso) + days * DAY_MS);
export const daysInclusive = (from: string, to: string) => Math.round((toTime(to) - toTime(from)) / DAY_MS) + 1;
const isIso = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(toTime(value));
const monthOf = (iso: string) => iso.slice(0, 7);
const shiftMonth = (month: string, by: number) => {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
};

/**
 * A month calendar for picking a date range by tapping start and end; arrow keys move the focus day by day and
 * week by week. Marked ranges (e.g. saved holidays) show a dot.
 */
export function RangeCalendar({ value, onChange, today, marked = [], label = "Zeitraum wählen", disabled = false }: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  today: string;
  marked?: readonly DateRange[];
  label?: string;
  disabled?: boolean;
}) {
  const start = isIso(value.from) ? value.from : "";
  const end = isIso(value.to) ? value.to : "";
  const [month, setMonth] = useState(() => monthOf(start || today));
  const [focus, setFocus] = useState(() => start || today);
  // A date typed into the fields shows its month.
  const [shown, setShown] = useState(start);
  if (shown !== start) {
    setShown(start);
    if (start && monthOf(start) !== month) setMonth(monthOf(start));
  }
  const grid = useRef<HTMLDivElement>(null);
  const first = `${month}-01`;
  const lead = (new Date(toTime(first)).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const days = Array.from({ length }, (_, index) => addDaysIso(first, index));
  const focusDay = monthOf(focus) === month ? focus : start && monthOf(start) === month ? start : first;

  function choose(day: string) {
    if (!start || end) onChange({ from: day, to: "" });
    else if (day < start) onChange({ from: day, to: "" });
    else onChange({ from: start, to: day });
    setFocus(day);
  }

  function move(event: KeyboardEvent<HTMLButtonElement>, day: string) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = addDaysIso(day, step);
    setFocus(next);
    setMonth(monthOf(next));
    requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus());
  }

  return (
    <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Vorheriger Monat" disabled={disabled} onClick={() => setMonth(shiftMonth(month, -1))}>
          <ChevronLeft />
        </Button>
        <p aria-live="polite" className="text-sm font-semibold capitalize">{monthTitle.format(new Date(toTime(first)))}</p>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Nächster Monat" disabled={disabled} onClick={() => setMonth(shiftMonth(month, 1))}>
          <ChevronRight />
        </Button>
      </div>
      <div ref={grid} role="group" aria-label={label} className="grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAYS.map((day) => <span key={day} aria-hidden="true" className="pb-1 text-2xs font-medium text-muted-foreground">{day}</span>)}
        {Array.from({ length: lead }, (_, index) => <span key={`lead-${index}`} aria-hidden="true" />)}
        {days.map((day) => {
          const edge = day === start || day === end;
          const inside = !!start && !!end && day > start && day < end;
          const holiday = marked.some((range) => day >= range.from && day <= range.to);
          const weekday = (new Date(toTime(day)).getUTCDay() + 6) % 7;
          return (
            <span key={day} className={cn("relative flex justify-center",
              inside && "bg-primary/12",
              inside && weekday === 0 && "rounded-l-xl", inside && weekday === 6 && "rounded-r-xl",
              day === start && end && start !== end && "bg-linear-to-r from-transparent from-50% to-primary/12 to-50%",
              day === end && start && start !== end && "bg-linear-to-l from-transparent from-50% to-primary/12 to-50%")}>
              <button type="button" data-day={day} disabled={disabled} tabIndex={day === focusDay ? 0 : -1}
                aria-label={`${longDay.format(new Date(toTime(day)))}${holiday ? ", Urlaub gespeichert" : ""}`}
                aria-pressed={edge || inside}
                onClick={() => choose(day)} onKeyDown={(event) => move(event, day)}
                className={cn(
                  "relative flex size-10 items-center justify-center rounded-xl text-sm tabular-nums transition-[background-color,color,scale] duration-150 ease-soft active:scale-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100 pointer-fine:size-9",
                  edge ? "bg-primary font-semibold text-primary-foreground shadow-sm" : inside ? "font-medium text-foreground" : "hover:bg-muted",
                  day === today && !edge && "font-semibold text-primary",
                )}>
                {Number(day.slice(8, 10))}
                {holiday && <span aria-hidden="true" className={cn("absolute bottom-1 size-1 rounded-full", edge ? "bg-primary-foreground" : "bg-warning")} />}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
