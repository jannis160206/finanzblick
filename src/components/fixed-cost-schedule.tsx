"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useFinance } from "@/components/finance-provider";
import { SectionHeading } from "@/components/finance-ui";
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
  return <section className="panel mb-6 p-5 sm:p-6" aria-label="Fixkosten diesen Monat">
    <SectionHeading title={`Fixkosten · ${monthLabel(schedule.month)}`} subtitle={`Stand ${dateLabel(schedule.asOf)}`}>
      <Link href="/monate" className="shrink-0 text-xs text-primary hover:underline">Monatsplan</Link>
    </SectionHeading>
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <p className="text-sm font-medium">Noch offen <span className="ml-2 tabular-nums">{currency(schedule.openTotal)}</span></p>
      <span className="text-xs text-muted-foreground">{schedule.open.length} Posten</span>
    </div>
    {schedule.open.length ? <DebitList items={schedule.open} /> :
      <p className="py-2 text-sm text-muted-foreground">Alle Fixkosten dieses Monats sind abgebucht.</p>}
    {schedule.booked.length > 0 && <details className="mt-3 border-t pt-3">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Bereits abgebucht ({schedule.booked.length}) · {currency(schedule.bookedTotal)}
      </summary>
      <DebitList items={schedule.booked} />
    </details>}
    <p className="mt-3 text-xs text-muted-foreground">Termine aus bisherigen Buchungen · offen = noch nicht im Auszug.</p>
  </section>;
}
