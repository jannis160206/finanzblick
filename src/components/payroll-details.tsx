import { FinancialData } from "@/components/financial-data";
import { PayrollDisclosure } from "@/components/payroll-ui";
import {
  payrollEstimate,
  payrollMoney,
  payrollPeriod,
  type PayrollPresentation,
} from "@/components/payroll-presentation";
import { Badge } from "@/components/ui/badge";
import { monthLabel } from "@/lib/format";

export function PayrollDetails({ view }: { view: PayrollPresentation }) {
  const { analysis, year, projectedMonths } = view;
  if (!projectedMonths.length) return null;
  return (
    <PayrollDisclosure
      title="Monatliche Prognose anzeigen"
      label="Monatliche Prognose"
      inset
    >
      <section aria-label="Monatliche Gehaltsprognose">
        <FinancialData className="divide-y divide-border/60">
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
                className="grid min-w-0 gap-x-4 gap-y-2 py-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:items-center"
              >
                <header className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium">{label}</h3>
                  {hasSpecial && <Badge>Sonderzahlung</Badge>}
                </header>
                <dl className="grid grid-cols-3 gap-3">
                  {[
                    {
                      label: "Laufendes Brutto",
                      aria: "Laufendes Brutto",
                      value: payrollMoney(forecast?.regularGross),
                    },
                    {
                      label: "Sonderzahlung",
                      aria: "Sonderzahlung",
                      value:
                        special === 0 ? "Keine geplant" : payrollMoney(special),
                    },
                    {
                      label: "Jahressechstel · Schätzung",
                      aria: "Jahressechstel",
                      value: payrollEstimate(month),
                    },
                  ].map((figure) => (
                    <div key={figure.aria} className="min-w-0">
                      <dt className="text-xs text-muted-foreground">
                        {figure.label}
                      </dt>
                      <dd
                        aria-label={`${label} ${figure.aria}`}
                        className="mt-0.5 break-words text-sm font-medium tabular-nums"
                      >
                        {figure.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </article>
            );
          })}
        </FinancialData>
      </section>
    </PayrollDisclosure>
  );
}
