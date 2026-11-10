"use client";

import { FinancialData } from "@/components/financial-data";
import { PayrollDetails } from "@/components/payroll-details";
import { notOnPayslip } from "@/components/payroll-focus";
import type { PayrollPresentation } from "@/components/payroll-presentation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currency } from "@/lib/format";
import { payrollYearMonths, type PayrollStripMonth } from "@/lib/payroll-overview";
import type { Payslip } from "@/lib/payslip-schema";
import { cn } from "@/lib/utils";

const monthNameFormat = new Intl.DateTimeFormat("de-AT", { month: "long", timeZone: "UTC" });
export const payrollMonthName = (month: number) =>
  monthNameFormat.format(new Date(Date.UTC(2026, month - 1, 15)));

const statusBadge: Record<PayrollStripMonth["kind"], { label: string; variant: "success" | "info" | "warning" | "secondary" }> = {
  actual: { label: "belegt", variant: "success" },
  forecast: { label: "geschätzt", variant: "info" },
  missing: { label: "fehlt", variant: "warning" },
  open: { label: "offen", variant: "secondary" },
};

const columns = ["Brutto", "Netto", "Lohnsteuer", "SV"] as const;

function Unknown({ text }: { text: string }) {
  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground">–</span>
      <span className="sr-only">{text}</span>
    </>
  );
}

function MonthRow({ entry, selected }: { entry: PayrollStripMonth; selected: boolean }) {
  const status = statusBadge[entry.kind];
  const special = "special" in entry && entry.special;
  const values: (number | undefined)[] =
    entry.kind === "actual"
      ? [entry.breakdown.gross, entry.breakdown.net, entry.breakdown.tax, entry.breakdown.sv]
      : entry.kind === "forecast"
        ? [entry.gross, undefined, undefined, undefined]
        : [undefined, undefined, undefined, undefined];
  const unknown = entry.kind === "actual" ? notOnPayslip : entry.kind === "forecast" ? "erst mit Abrechnung" : "keine Abrechnung";
  return (
    <li
      aria-current={selected || undefined}
      className={cn(
        "grid gap-x-3 gap-y-1 py-2.5 sm:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] sm:items-center",
        selected && "-mx-2 rounded-lg bg-accent-muted px-2",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm font-medium">{payrollMonthName(entry.month)}</span>
        {entry.kind === "actual"
          ? <span className="sr-only">{status.label}</span>
          : <Badge variant={status.variant}>{status.label}</Badge>}
        {special && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-chart-4" />
            <span className="sm:max-lg:sr-only">Sonderzahlung</span>
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:col-span-4 sm:grid-cols-4 sm:gap-3 sm:text-sm">
        {columns.map((label, index) => {
          const value = values[index];
          return (
            <div
              key={label}
              className={cn(
                "flex min-w-0 gap-1 sm:block sm:text-right",
                value === undefined && entry.kind !== "actual" && "hidden sm:block",
              )}
            >
              <dt className="text-muted-foreground sm:sr-only">{label}</dt>
              <dd className="break-words tabular-nums">
                {value === undefined ? <Unknown text={unknown} /> : currency(value)}
              </dd>
            </div>
          );
        })}
      </dl>
    </li>
  );
}

export function PayrollMonths({
  view,
  entries,
  selectedMonth,
}: {
  view: PayrollPresentation;
  entries: readonly Payslip[];
  selectedMonth?: number;
}) {
  const months = payrollYearMonths(entries, view.analysis.forecast.months);
  return (
    <Card as="section" aria-labelledby="payroll-months-title">
      <CardHeader>
        <CardTitle id="payroll-months-title">Monate</CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        <div
          aria-hidden="true"
          className="hidden grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] gap-3 border-b pb-2 text-xs text-muted-foreground sm:grid"
        >
          <span>Monat</span>
          {columns.map((label) => (
            <span key={label} className="text-right">{label}</span>
          ))}
        </div>
        <FinancialData as="ul" aria-label={`Monate ${view.year}`} className="divide-y divide-border/60">
          {months.map((entry) => (
            <MonthRow
              key={entry.month}
              entry={entry}
              selected={entry.kind === "actual" && entry.month === selectedMonth}
            />
          ))}
        </FinancialData>
        <PayrollDetails view={view} />
      </CardContent>
    </Card>
  );
}
