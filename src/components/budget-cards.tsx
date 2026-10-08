import type { Dashboard } from "@/lib/calc";
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
              {currency(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function BudgetCard({ row }: { row: BudgetPosition }) {
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
      <h3 className="text-sm font-medium leading-5 sm:min-h-10">{row.label}</h3>
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
            <dt className="text-muted-foreground">{label}</dt>
            <dd
              aria-label={`${row.label} ${name}`}
              className={cn(
                "mt-1 break-words text-sm font-medium tabular-nums",
                name !== "Plan" && name !== "Ist" && "font-semibold",
                name === "Überschreitung" && "text-destructive",
              )}
            >
              {currency(value)}
            </dd>
          </div>
        ))}
      </dl>
      <div
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
      </div>
    </article>
  );
}
