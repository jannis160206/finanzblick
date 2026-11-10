import { actualBookings, classify, monthKey, round, type Dashboard } from "@/lib/calc";
import { contractReminders, detectContracts } from "@/lib/contracts";
import { currency } from "@/lib/format";
import { ledgerHref } from "@/lib/ledger-link";
import type { AppState } from "@/lib/types";

export type NotificationEvent = { id: string; title: string; body: string; url: string };

export type NotificationOptions = {
  /** Stichtag (YYYY-MM-DD); bestimmt den aktuellen Monat und die obere Datumsgrenze. */
  asOf: string;
  largeDebitThreshold: number;
  /** Nur Abbuchungen ab diesem Datum (YYYY-MM-DD) melden. */
  sinceDate: string;
};

export function detectNotificationEvents(
  state: AppState,
  dashboard: Dashboard,
  options: NotificationOptions,
): NotificationEvent[] {
  const month = monthKey(options.asOf);
  const events: NotificationEvent[] = [];
  const bookings = actualBookings(state).filter((row) => row.date <= options.asOf);

  const salaryBooking = bookings.find((row) => monthKey(row.date) === month && row.amount > 0 && !row.ignored &&
    classify(row).category === "Gehalt");
  const salary = dashboard.currentMonth === month && dashboard.current.salaryReceived > 0
    ? dashboard.current.salaryReceived : salaryBooking?.amount ?? 0;
  if (salary > 0) events.push({
    id: `salary:${month}`, title: "Gehalt eingegangen",
    body: `${currency(salary)} sind auf deinem Konto eingegangen.`, url: "/",
  });

  if (dashboard.plan.currentMonth === month) {
    for (const row of dashboard.plan.rows) {
      if (row.actual <= 0 || row.actual <= row.total) continue;
      events.push({
        id: `budget:${month}:${row.id}`, title: `Budget überschritten: ${row.label}`,
        body: `${currency(row.actual)} von ${currency(row.total)} ausgegeben (${currency(round(row.actual - row.total))} darüber).`,
        url: ledgerHref({ month, group: row.id }),
      });
    }
  }

  const threshold = Math.abs(options.largeDebitThreshold);
  if (threshold > 0) {
    const debits = bookings
      .filter((row) => row.amount < 0 && Math.abs(row.amount) >= threshold && row.date >= options.sinceDate &&
        !row.ignored && !classify(row).isTransfer)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (const row of debits) events.push({
      id: `debit:${row.id}`, title: `Große Abbuchung: ${currency(Math.abs(row.amount))}`,
      body: `${classify(row).merchant || row.description} · ${row.date.split("-").reverse().join(".")}`,
      url: ledgerHref({ month: monthKey(row.date) }),
    });
  }
  for (const reminder of contractReminders(detectContracts(state, options.asOf), options.asOf)) {
    if (reminder.kind === "missed") continue;
    events.push({ id: `contract-${reminder.id}`, title: reminder.title, body: reminder.body, url: "/vertraege" });
  }
  return events;
}
