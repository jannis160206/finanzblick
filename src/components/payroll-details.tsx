import { CalendarDays } from "lucide-react";
import { PayrollDisclosure } from "@/components/payroll-ui";
import {
  payrollEstimate,
  payrollMoney,
  payrollPeriod,
  type PayrollPresentation,
} from "@/components/payroll-presentation";
import { monthLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PayrollDetails({ view }: { view: PayrollPresentation }) {
  const { analysis, year, projectedMonths } = view;
  if (!projectedMonths.length) return null;
  return (
    <PayrollDisclosure
      title="Monatliche Prognose anzeigen"
      label="Monatliche Prognose"
    >
      <section aria-label="Monatliche Gehaltsprognose">
        <p className="mb-4 text-xs text-muted-foreground">
          {projectedMonths.length} Monatswerte · Schätzungen, keine bestätigten
          Zahlungen
        </p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projectedMonths.map((month) => {
            const forecast = analysis.forecast.months.find(
              (entry) => entry.month === month.month,
            );
            const special = analysis.hasSpecialPaymentModel
              ? forecast?.specialGross
              : undefined;
            const label = monthLabel(payrollPeriod(year, month.month));
            const hasSpecial = special !== undefined && special > 0;
            return (
              <article
                key={month.month}
                aria-label={label}
                className={cn(
                  "min-w-0 rounded-xl border bg-muted/15 p-4",
                  hasSpecial && "border-primary/30 bg-primary/5",
                )}
              >
                <header className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <CalendarDays
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    {label}
                  </h3>
                  {hasSpecial && (
                    <span className="rounded-md bg-primary/10 px-2 py-1 text-2xs font-medium text-primary">
                      Sonderzahlung
                    </span>
                  )}
                </header>
                <dl className="mt-4 grid grid-cols-2 gap-3">
                  {[
                    {
                      label: "Laufendes Brutto",
                      value: payrollMoney(forecast?.regularGross),
                    },
                    {
                      label: "Sonderzahlung",
                      value:
                        special === 0 ? "Keine geplant" : payrollMoney(special),
                    },
                  ].map((figure) => (
                    <div key={figure.label} className="min-w-0">
                      <dt className="text-xs text-muted-foreground">
                        {figure.label}
                      </dt>
                      <dd
                        aria-label={`${label} ${figure.label}`}
                        className="mt-1 break-words text-base font-semibold tabular-nums"
                      >
                        {figure.value}
                      </dd>
                    </div>
                  ))}
                  <div className="col-span-2 min-w-0 border-t pt-3">
                    <dt className="text-xs text-muted-foreground">
                      Jahressechstel · Schätzung
                    </dt>
                    <dd
                      aria-label={`${label} Jahressechstel`}
                      className="mt-1 break-words text-sm font-medium tabular-nums"
                    >
                      {payrollEstimate(month)}
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      </section>
    </PayrollDisclosure>
  );
}
