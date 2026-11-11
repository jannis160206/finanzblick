"use client";

import { ArrowDownRight, ArrowUpRight, CheckCheck, Minus, Trash2, TriangleAlert } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { payrollPeriod } from "@/components/payroll-presentation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { currency, monthLabel } from "@/lib/format";
import {
  comparePayroll,
  payrollBreakdown,
  previousPayslip,
  previousYearPayslip,
  type PayrollAmountKey,
  type PayrollComparison,
  type PayrollMonthBreakdown,
  type PayrollPart,
} from "@/lib/payroll-overview";
import type { Payslip } from "@/lib/payslip-schema";
import type { PayslipCheck } from "@/lib/payslip-validation";
import { cn } from "@/lib/utils";

export const notOnPayslip = "nicht auf der Abrechnung";

const shareFormat = new Intl.NumberFormat("de-AT", {
  style: "percent",
  maximumFractionDigits: 1,
});
export const payrollShare = (value: number) => shareFormat.format(value);

export const payrollSegments: { key: PayrollAmountKey; label: string; color: string }[] = [
  { key: "net", label: "Netto", color: "bg-chart-1" },
  { key: "tax", label: "Lohnsteuer", color: "bg-chart-2" },
  { key: "sv", label: "Sozialversicherung", color: "bg-chart-3" },
  { key: "other", label: "Sonstige Abzüge", color: "bg-chart-7" },
];

/** Segment widths in % of gross; inconsistent payslips are scaled down so the bar never overflows. */
export function payrollSegmentWidths(breakdown: PayrollMonthBreakdown) {
  const known = payrollSegments.flatMap((segment) => {
    const value = breakdown[segment.key];
    return value !== undefined && value > 0 ? [{ ...segment, value }] : [];
  });
  const scale = Math.max(breakdown.gross, known.reduce((sum, segment) => sum + segment.value, 0));
  return known.map((segment) => ({
    ...segment,
    width: scale > 0 ? (segment.value / scale) * 100 : 0,
  }));
}

/** Net fills from the start and deductions from the end, so an unexplained remainder stays empty track in between. */
export function PayrollSegmentFill({ breakdown, vertical = false }: { breakdown: PayrollMonthBreakdown; vertical?: boolean }) {
  const segments = payrollSegmentWidths(breakdown);
  const piece = (segment: (typeof segments)[number]) => (
    <span
      key={segment.key}
      data-segment={segment.key}
      className={cn(
        "block shrink-0",
        segment.color,
        vertical ? "w-full" : "h-full",
        !vertical && segment.key !== "net" && "border-l-2 border-card",
      )}
      style={vertical ? { height: `${segment.width}%` } : { width: `${segment.width}%` }}
    />
  );
  return (
    <>
      {segments.filter((segment) => segment.key === "net").map(piece)}
      <span className="block min-h-0 min-w-0 flex-1" />
      {segments.filter((segment) => segment.key !== "net").map(piece)}
    </>
  );
}

function comparisonText(comparison: PayrollComparison, target: string) {
  const metric = comparison.metric === "gross" ? "Brutto " : "";
  if (comparison.delta === 0) return `${metric}unverändert ${target}`;
  const sign = comparison.delta > 0 ? "+" : "−";
  return `${sign}${currency(Math.abs(comparison.delta))} ${metric}${target}`;
}

function ComparisonChip({ comparison, target }: { comparison: PayrollComparison; target: string }) {
  const Icon = comparison.delta > 0 ? ArrowUpRight : comparison.delta < 0 ? ArrowDownRight : Minus;
  return (
    <Badge variant="secondary" className="min-h-6 max-w-full px-2.5 text-xs whitespace-normal">
      <Icon aria-hidden="true" />
      <span className="min-w-0 tabular-nums">{comparisonText(comparison, target)}</span>
    </Badge>
  );
}

function PartLine({ label, part }: { label: string; part: PayrollPart }) {
  const amount = (value: number | undefined) => (
    <span className={cn("tabular-nums", value === undefined ? "text-muted-foreground" : "font-medium")}>
      {value === undefined ? notOnPayslip : currency(value)}
    </span>
  );
  return (
    <li className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
      <span className="w-28 shrink-0 font-medium">{label}</span>
      <span><span className="text-muted-foreground">Brutto</span> {amount(part.gross)}</span>
      <span><span className="text-muted-foreground">Lohnsteuer</span> {amount(part.tax)}</span>
      <span><span className="text-muted-foreground">SV</span> {amount(part.sv)}</span>
    </li>
  );
}

export function PayrollFocusCard({ entry, payslips, review, onConfirm, onRemove, taxNote }: {
  entry: Payslip;
  payslips: readonly Payslip[];
  /** Contradictions that keep this payslip out of the budget until the user takes it in. */
  review?: readonly PayslipCheck[];
  onConfirm?: (entry: Payslip) => void;
  onRemove?: (entry: Payslip, trigger: HTMLButtonElement) => void;
  /** Small caption naming the tax logic, e.g. "Lohnsteuertarif AT 2026 · progressiv + Absetzbeträge". */
  taxNote?: string;
}) {
  const breakdown = payrollBreakdown(entry);
  const label = monthLabel(payrollPeriod(entry.year, entry.month));
  const previousEntry = previousPayslip(payslips, entry);
  const previousYearEntry = previousYearPayslip(payslips, entry);
  // Without months in between, the previous available payslip is the previous-year month: show that chip only once.
  const previous = previousEntry === previousYearEntry
    ? undefined
    : comparePayroll(breakdown, previousEntry && payrollBreakdown(previousEntry));
  const previousYear = comparePayroll(breakdown, previousYearEntry && payrollBreakdown(previousYearEntry));
  const figures = [
    { key: "gross", label: "Brutto", value: breakdown.gross, share: undefined, partial: false },
    {
      key: "tax", label: "Lohnsteuer", value: breakdown.tax, share: breakdown.shares.tax,
      partial: breakdown.tax !== undefined && !breakdown.taxComplete,
    },
    {
      key: "sv", label: "Sozialversicherung", value: breakdown.sv, share: breakdown.shares.sv,
      partial: breakdown.sv !== undefined && !breakdown.svComplete,
    },
  ];
  const legend = payrollSegments.filter((segment) => segment.key !== "other" || (breakdown.other ?? 0) > 0);
  return (
    <Card as="section" id="payroll-focus" tabIndex={-1} aria-label={`Gehalt ${label}`}
      className="scroll-mt-24 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="text-sm font-semibold tracking-tight">
            Brutto → Netto <span className="font-normal text-muted-foreground">· {label}</span>
          </h2>
          {(previous || previousYear) && (
            <FinancialData as="ul" aria-label="Vergleich" className="flex flex-wrap gap-1.5">
              {previous && (
                <li>
                  <ComparisonChip
                    comparison={previous}
                    target={previous.adjacent ? "zum Vormonat" : `zu ${monthLabel(payrollPeriod(previous.year, previous.month))}`}
                  />
                </li>
              )}
              {previousYear && (
                <li><ComparisonChip comparison={previousYear} target="zum Vorjahresmonat" /></li>
              )}
            </FinancialData>
          )}
        </div>
        {review && review.length > 0 && (
          <div role="note" className="rounded-xl border border-warning/50 bg-warning-soft px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
              Nicht im Budget – die Zahlen passen nicht zusammen
            </p>
            <ul className="mt-1.5 space-y-1 pl-5.5 text-xs leading-relaxed">
              {review.slice(0, 3).map((check) => <li key={check.id}>{check.message}</li>)}
            </ul>
          </div>
        )}
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:items-end">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Netto</p>
            <FinancialData
              as="p"
              className={cn(
                "mt-1 break-words",
                breakdown.net === undefined ? "text-base font-medium text-muted-foreground" : "amount text-display",
              )}
            >
              {breakdown.net === undefined ? notOnPayslip : currency(breakdown.net)}
            </FinancialData>
          </div>
          <FinancialData as="dl" className="grid grid-cols-3 gap-x-4 gap-y-1">
            {figures.map((figure) => (
              <div key={figure.key} className="min-w-0">
                <dt className="text-xs break-words text-muted-foreground">
                  {figure.key === "sv" ? (
                    <>
                      <span aria-hidden="true" className="sm:hidden">SV</span>
                      <span className="sr-only sm:not-sr-only">{figure.label}</span>
                    </>
                  ) : figure.label}
                </dt>
                <dd
                  className={cn(
                    "mt-0.5 break-words",
                    figure.value === undefined ? "text-xs text-muted-foreground" : "amount text-sm sm:text-base",
                  )}
                >
                  {figure.value === undefined ? notOnPayslip : currency(figure.value)}
                </dd>
                {figure.share !== undefined && (
                  <dd className="text-xs text-muted-foreground tabular-nums">
                    {payrollShare(figure.share)}
                    {figure.partial && " · ohne Sonderzahlung"}
                  </dd>
                )}
              </div>
            ))}
          </FinancialData>
        </div>
        <div>
          <div aria-hidden="true" className="h-3 overflow-hidden rounded-full bg-muted sm:h-4">
            <div data-payroll-bar="" className="flex h-full origin-left motion-safe:animate-bar-grow">
              <PayrollSegmentFill breakdown={breakdown} />
            </div>
          </div>
          <FinancialData as="ul" aria-label="Aufteilung des Bruttos" className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            {legend.map((segment) => {
              const value = breakdown[segment.key];
              const share = breakdown.shares[segment.key];
              return (
                <li key={segment.key} className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2.5 shrink-0 rounded-sm",
                      value === undefined ? "border border-dashed border-muted-foreground" : segment.color,
                    )}
                  />
                  <span>{segment.label}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {value === undefined
                      ? notOnPayslip
                      : segment.key === "other"
                        ? `${currency(value)}${share === undefined ? "" : ` · ${payrollShare(share)}`}`
                        : share === undefined ? "" : payrollShare(share)}
                  </span>
                  {segment.key === "other" && (
                    <InfoTip label="Sonstige Abzüge" className="-my-1.5 size-6">
                      Brutto minus Netto, Lohnsteuer und Sozialversicherung – etwa Betriebsratsumlage,
                      Gewerkschaftsbeitrag oder e-card. Nur berechnet, wenn alle vier Werte auf der Abrechnung stehen.
                    </InfoTip>
                  )}
                </li>
              );
            })}
          </FinancialData>
        </div>
        {breakdown.special && (
          <div className="border-t pt-4">
            <FinancialData as="ul" aria-label="Laufend und Sonderzahlung" className="space-y-2 text-xs">
              <PartLine label="Laufend" part={breakdown.regular} />
              <PartLine label="Sonderzahlung" part={breakdown.special} />
            </FinancialData>
            {breakdown.unresolvedBonus !== undefined && (
              <FinancialData as="p" className="mt-2 text-xs text-muted-foreground">
                Sonderzahlung inkl. Prämie {currency(breakdown.unresolvedBonus)} · Sechstelzuordnung offen
              </FinancialData>
            )}
          </div>
        )}
        {entry.backPayGross ? (
          <FinancialData as="p" className="text-xs text-muted-foreground">
            Dazu Nachzahlung für Vormonate {currency(entry.backPayGross)} brutto
          </FinancialData>
        ) : null}
        {(taxNote || onRemove || (review?.length && onConfirm)) && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t pt-3">
            <p className="text-2xs text-muted-foreground">{taxNote}</p>
            <span className="-mr-2 flex flex-wrap items-center gap-1">
              {review && review.length > 0 && onConfirm && (
                <Button variant="outline" size="sm" onClick={() => onConfirm(entry)}>
                  <CheckCheck aria-hidden="true" />Ins Budget übernehmen
                </Button>
              )}
              {onRemove && (
                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive"
                  aria-label={`Abrechnung ${label} entfernen`} onClick={(event) => onRemove(entry, event.currentTarget)}>
                  <Trash2 aria-hidden="true" />Entfernen
                </Button>
              )}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
