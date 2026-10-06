"use client";

import { useMemo } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { fixedCostSchedule, type FixedCostScheduleItem } from "@/lib/fixed-cost-schedule";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

function debitDate(item: FixedCostScheduleItem) {
  if (item.status === "booked") return item.bookedDates.map(dateLabel).join(" · ");
  if (!item.expectedFrom || !item.expectedTo) return "Termin unbekannt";
  return item.expectedFrom === item.expectedTo
    ? `ca. ${dateLabel(item.expectedFrom)}`
    : `ca. ${Number(item.expectedFrom.slice(8))}.–${dateLabel(item.expectedTo)}`;
}

function DebitList({ items }: { items: FixedCostScheduleItem[] }) {
  return <ul className="divide-y" aria-label={items[0]?.status === "booked" ? "Abgebuchte Fixkosten" : "Offene Fixkosten"}>
    {items.map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium">{item.name}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {debitDate(item)}{item.account && ` · ${item.account}`}
        </p>
        {item.status !== "booked" && item.bookedAmount > 0 &&
          <p className="mt-1 text-xs text-muted-foreground">{currency(item.bookedAmount)} bereits abgebucht</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm tabular-nums">{currency(item.status === "booked" ? item.bookedAmount : item.openAmount)}</p>
        <p className={cn("mt-1 text-xs", item.status === "due" ? "text-primary" : "text-muted-foreground")}>
          {item.status === "booked" ? "Abgebucht" : item.status === "due" ? "Heute erwartet" :
            item.status === "unconfirmed" ? "Noch nicht bestätigt" : "Offen"}
        </p>
      </div>
    </li>)}
  </ul>;
}

export function FixedCostSchedule() {
  const { state } = useFinance();
  const schedule = useMemo(() => fixedCostSchedule(state), [state]);
  if (!schedule.open.length && !schedule.booked.length) return null;
  return <section className="mb-4" aria-label="Fixkosten diesen Monat">
    <details className="group rounded-xl border bg-card/50">
      <summary aria-label="Fixkosten-Abbuchungen anzeigen"
        className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <CalendarDays className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">Fixkosten · {monthLabel(schedule.month)}</span>
        <span className="ml-auto whitespace-nowrap tabular-nums">
          {schedule.open.length ? `${currency(schedule.openTotal)} offen` : "Alles abgebucht"}
        </span>
        <ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
      </summary>
      <div className="px-4 pb-4">
        <p className="mb-3 text-xs text-muted-foreground">
          Stand {dateLabel(schedule.asOf)} · {schedule.open.length} offene Posten
        </p>
    {schedule.open.length ? <DebitList items={schedule.open} /> :
      <p className="py-2 text-sm text-muted-foreground">Alle Fixkosten dieses Monats sind abgebucht.</p>}
    {schedule.booked.length > 0 && <details className="mt-3 border-t pt-3">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Bereits abgebucht ({schedule.booked.length}) · {currency(schedule.bookedTotal)}
      </summary>
      <DebitList items={schedule.booked} />
    </details>}
    <p className="mt-3 text-xs text-muted-foreground">Termine aus bisherigen Buchungen · offen = noch nicht im Auszug.</p>
      </div>
    </details>
  </section>;
}
