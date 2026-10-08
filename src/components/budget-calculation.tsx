import { ChevronDown } from "lucide-react";
import { HolidayRanges } from "@/components/holiday-ranges";
import type { Dashboard } from "@/lib/calc";
import { currency } from "@/lib/format";

export function BudgetCalculation({
  lunch,
}: {
  lunch: Dashboard["plan"]["lunch"];
}) {
  return (
    <details className="panel group rounded-2xl shadow-sm">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl p-5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        Budgetberechnung
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-4 border-t p-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">Mittagessen</h3>
          <HolidayRanges />
        </header>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {[
            {
              label: "Homeoffice · Mo & Fr",
              days: lunch.homeOfficeDays,
              rate: 5,
            },
            { label: "Büro · Di bis Do", days: lunch.officeDays, rate: 5.5 },
          ].map(({ label, days, rate }) => (
            <div key={label} className="rounded-xl bg-muted/40 p-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 tabular-nums">
                {days} Tage × {currency(rate)} = {currency(days * rate)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-sm font-medium">
          Mittagessen gesamt: {currency(lunch.total)}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Ohne Wochenenden, Feiertage und gespeicherte Urlaubstage. Die übrigen
          Monatsbudgets sind fest vorgegeben; Geschenke &amp; Spenden folgen dem
          Kalender.
        </p>
      </div>
    </details>
  );
}
