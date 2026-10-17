import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Dashboard } from "@/lib/calc";
import { FinancialData } from "@/components/financial-data";
import { round } from "@/lib/calc";
import { currency } from "@/lib/format";
import { cn } from "@/lib/utils";

type BudgetPosition = Dashboard["plan"]["rows"][number] & { remaining: number };

export function BudgetSummary({
  total,
  actual,
}: {
  total: number;
  actual: number;
}) {
  const remaining = round(total - actual);
  const figures = [
    { label: "Monatsbudget", value: total },
    { label: "Ist-Ausgaben", value: actual },
    { label: "Budgetrest", value: remaining },
  ];
  return (
    <section
      aria-label="Budgetübersicht"
      className="panel rounded-2xl p-5 shadow-sm"
    >
      <dl className="grid grid-cols-2 gap-5 sm:grid-cols-3">
        {figures.map(({ label, value }) => (
          <div
            key={label}
            className={cn(
              "min-w-0",
              label === "Monatsbudget" && "col-span-2 sm:col-span-1",
            )}
          >
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd
              aria-label={label}
              className={cn(
                "mt-2 break-words text-2xl font-semibold tracking-tight tabular-nums",
                label === "Budgetrest" && remaining < 0 && "text-destructive",
              )}
            >
              <FinancialData as="span">{currency(value)}</FinancialData>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function BudgetCard({ row, href }: { row: BudgetPosition; href?: string }) {
  const exceeded = row.remaining < 0;
  const used =
    row.total > 0
      ? Math.min(100, Math.max(0, (row.actual / row.total) * 100))
      : row.actual > 0
        ? 100
        : 0;
  return (
    <article
      aria-label={row.label}
      className={cn(
        "panel flex min-w-0 flex-col rounded-2xl p-5 shadow-sm",
        exceeded && "border-destructive/30",
      )}
    >
      <h3 className="text-sm font-medium leading-5 sm:min-h-10">
        {href ? (
          <Link
            href={href}
            title="Buchungen dieses Budgets anzeigen"
            className="inline-flex min-h-11 items-center gap-1 rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-0"
          >
            {row.label}
            <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </Link>
        ) : (
          row.label
        )}
      </h3>
      <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
        {[
          { label: "Plan", name: "Plan", value: row.total },
          { label: "Ist", name: "Ist", value: row.actual },
          {
            label: exceeded ? "Über Budget" : "Rest",
            name: exceeded ? "Überschreitung" : "Restbudget",
            value: Math.abs(row.remaining),
          },
        ].map(({ label, name, value }) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground">
              {name === "Plan" || name === "Ist" ? (
                label
              ) : (
                <FinancialData as="span">{label}</FinancialData>
              )}
            </dt>
            <dd
              className={cn(
                "mt-1 break-words text-sm font-medium tabular-nums",
                name !== "Plan" && name !== "Ist" && "font-semibold",
                name === "Überschreitung" && "text-destructive",
              )}
            >
              <FinancialData as="span" aria-label={`${row.label} ${name}`}>
                {currency(value)}
              </FinancialData>
            </dd>
          </div>
        ))}
      </dl>
      <FinancialData
        role="progressbar"
        aria-label={`${row.label} Budgetverbrauch`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-valuetext={`${currency(row.actual)} von ${currency(row.total)}`}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            exceeded ? "bg-destructive" : "bg-primary/60",
          )}
          style={{ width: `${used}%` }}
        />
      </FinancialData>
    </article>
  );
}
