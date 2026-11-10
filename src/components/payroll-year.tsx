"use client";

import { FinancialData } from "@/components/financial-data";
import { notOnPayslip, PayrollSegmentFill, payrollSegments, payrollShare } from "@/components/payroll-focus";
import { payrollPeriod } from "@/components/payroll-presentation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { currency, monthLabel } from "@/lib/format";
import {
  payrollYearMonths,
  payrollYearTotals,
  type PayrollMonthBreakdown,
  type PayrollStripMonth,
  type PayrollTotal,
} from "@/lib/payroll-overview";
import type { Payslip, PayrollForecastMonth } from "@/lib/payslip-schema";
import { cn } from "@/lib/utils";

const monthsText = (count: number) => `${count} ${count === 1 ? "Monat" : "Monaten"}`;

function stripLabel(year: number, entry: PayrollStripMonth) {
  const label = monthLabel(payrollPeriod(year, entry.month));
  const special = "special" in entry && entry.special ? ", mit Sonderzahlung" : "";
  switch (entry.kind) {
    case "actual":
      return entry.breakdown.net === undefined
        ? `${label}: Brutto ${currency(entry.breakdown.gross)}, Netto ${notOnPayslip}${special}`
        : `${label}: Netto ${currency(entry.breakdown.net)}${special}`;
    case "forecast":
      return `${label}: Prognose, Brutto ${currency(entry.gross)}${special}`;
    case "missing":
      return `${label}: Abrechnung fehlt`;
    default:
      return `${label}: noch keine Abrechnung`;
  }
}

function StackedColumn({ breakdown }: { breakdown: PayrollMonthBreakdown }) {
  return (
    <span className="flex h-full flex-col-reverse overflow-hidden rounded-t-[3px] bg-muted">
      <PayrollSegmentFill breakdown={breakdown} vertical />
    </span>
  );
}

function StripColumn({ entry, max }: { entry: PayrollStripMonth; max: number }) {
  const gross = entry.kind === "actual" ? entry.breakdown.gross : entry.kind === "forecast" ? entry.gross : 0;
  const special = "special" in entry && entry.special;
  return (
    <span aria-hidden="true" className="relative block w-full flex-1">
      {gross > 0 ? (
        <span className="absolute inset-x-0 bottom-0 block" style={{ height: `${Math.max(4, (gross / max) * 100)}%` }}>
          {special && (
            <span className="absolute -top-2.5 left-1/2 block size-1.5 -translate-x-1/2 rounded-full bg-chart-4" />
          )}
          {entry.kind === "actual" ? (
            <StackedColumn breakdown={entry.breakdown} />
          ) : (
            <span className="block h-full rounded-t-[3px] border border-b-0 border-dashed border-muted-foreground/70 bg-muted/50" />
          )}
        </span>
      ) : (
        <span className="absolute inset-x-0 bottom-0 block h-0.5 rounded-full bg-border" />
      )}
    </span>
  );
}

function Figure({ label, total, months }: { label: string; total: PayrollTotal | undefined; months: number }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-words", total ? "amount text-lg" : "text-xs text-muted-foreground")}>
        {total ? currency(total.value) : notOnPayslip}
      </dd>
      {total && total.months < months && (
        <dd className="text-2xs text-muted-foreground">aus {monthsText(total.months)}</dd>
      )}
    </div>
  );
}

export function PayrollYearCard({
  year,
  entries,
  forecast,
  selectedMonth,
  onSelectMonth,
}: {
  year: number;
  entries: readonly Payslip[];
  forecast: readonly PayrollForecastMonth[];
  selectedMonth?: number;
  onSelectMonth: (month: number) => void;
}) {
  const totals = payrollYearTotals(entries);
  const months = payrollYearMonths(entries, forecast);
  const max = Math.max(
    1,
    ...months.map((entry) => (entry.kind === "actual" ? entry.breakdown.gross : entry.kind === "forecast" ? entry.gross : 0)),
  );
  const hasForecast = months.some((entry) => entry.kind === "forecast");
  const hasSpecial = months.some((entry) => "special" in entry && entry.special);
  const hasOther = months.some((entry) => entry.kind === "actual" && (entry.breakdown.other ?? 0) > 0);
  return (
    <Card as="section" aria-labelledby="payroll-year-title">
      <CardHeader>
        <CardTitle id="payroll-year-title">Jahr bisher</CardTitle>
        <CardDescription>
          {totals.months} {totals.months === 1 ? "Monat" : "Monate"} mit Abrechnung
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-4">
        <FinancialData as="dl" className="grid grid-cols-2 gap-x-4 gap-y-4">
          <Figure label="Brutto" total={totals.gross.months ? totals.gross : undefined} months={totals.months} />
          <Figure label="Netto" total={totals.net} months={totals.months} />
          <Figure label="Lohnsteuer" total={totals.tax} months={totals.months} />
          <Figure label="Sozialversicherung" total={totals.sv} months={totals.months} />
        </FinancialData>
        {totals.deductionRate && (
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <span>Ø Abzüge</span>
            <FinancialData as="span" className="font-semibold text-foreground tabular-nums">
              {payrollShare(totals.deductionRate.value)}
            </FinancialData>
            <span>vom Brutto</span>
            <InfoTip label="Durchschnittliche Abzüge">
              Brutto minus Netto im Verhältnis zum Brutto, nur aus Monaten mit Netto auf der Abrechnung
              ({monthsText(totals.deductionRate.months)}).
            </InfoTip>
          </div>
        )}
        <div>
          <FinancialData as="ul" aria-label={`Monatsleiste ${year}`} className="grid h-32 grid-cols-12 gap-1">
            {months.map((entry) => {
              const label = stripLabel(year, entry);
              const initial = monthLabel(payrollPeriod(year, entry.month)).slice(0, 1);
              const selected = entry.kind === "actual" && entry.month === selectedMonth;
              return (
                <li key={entry.month} className="flex min-w-0">
                  {entry.kind === "actual" ? (
                    <button
                      type="button"
                      aria-label={label}
                      aria-pressed={selected}
                      onClick={() => onSelectMonth(entry.month)}
                      className={cn(
                        "flex w-full flex-col rounded-md px-0.5 pt-3 pb-0.5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                        selected && "bg-accent-muted hover:bg-accent-muted",
                      )}
                    >
                      <StripColumn entry={entry} max={max} />
                      <span aria-hidden="true" className={cn("mt-1 text-center text-2xs", selected ? "font-semibold text-foreground" : "text-muted-foreground")}>
                        {initial}
                      </span>
                    </button>
                  ) : (
                    <div className="flex w-full flex-col px-0.5 pt-3 pb-0.5">
                      <StripColumn entry={entry} max={max} />
                      <span aria-hidden="true" className="mt-1 text-center text-2xs text-muted-foreground">{initial}</span>
                      <span className="sr-only">{label}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </FinancialData>
          <ul aria-label="Legende Monatsleiste" className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
            {payrollSegments
              .filter((segment) => segment.key !== "other" || hasOther)
              .map((segment) => (
                <li key={segment.key} className="flex items-center gap-1">
                  <span aria-hidden="true" className={cn("size-2 rounded-[2px]", segment.color)} />
                  {segment.label}
                </li>
              ))}
            {hasForecast && (
              <li className="flex items-center gap-1">
                <span aria-hidden="true" className="size-2 rounded-[2px] border border-dashed border-muted-foreground" />
                Prognose
              </li>
            )}
            {hasSpecial && (
              <li className="flex items-center gap-1">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-chart-4" />
                Sonderzahlung
              </li>
            )}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
