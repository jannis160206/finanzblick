"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedProgress, type ProgressTone } from "@/components/motion/animated-progress";
import { round, sum } from "@/lib/calc";
import { currency, monthLabel } from "@/lib/format";
import { ledgerHref, parseBudgetGroup } from "@/lib/ledger-link";
import { cn } from "@/lib/utils";

export function budgetTone(actual: number, total: number): ProgressTone {
  if (total <= 0) return actual > 0 ? "destructive" : "muted";
  const ratio = actual / total;
  return ratio > 1 ? "destructive" : ratio >= 0.85 ? "warning" : "default";
}

const usage = (row: { actual: number; total: number }) =>
  row.total > 0 ? row.actual / row.total : row.actual > 0 ? Number.POSITIVE_INFINITY : 0;

export function BudgetProgressCard({ className }: { className?: string }) {
  const { dashboard: { plan, currentMonth } } = useFinance();
  const rows = plan.rows.map((row) => ({ ...row, remaining: round(row.total - row.actual) }));
  const actual = round(sum(rows.map((row) => row.actual)));
  const remaining = round(plan.total - actual);
  const ranked = [...rows].sort((a, b) => usage(b) - usage(a)).slice(0, 5);
  const over = rows.filter((row) => row.remaining < 0).length;
  return (
    <Card as="section" aria-labelledby="overview-budget-title" className={className}>
      <CardHeader>
        <CardTitle id="overview-budget-title">Budget {monthLabel(currentMonth)}</CardTitle>
        <CardDescription>
          Alltagsausgaben · <FinancialData as="span">{over ? `${over} über Plan` : "alles im Rahmen"}</FinancialData>
        </CardDescription>
        <CardAction>
          <Link href="/budget" className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-primary transition-colors hover:bg-accent-muted focus-visible:outline-2 focus-visible:outline-ring">
            Budget<ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="pt-4">
        <FinancialData>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-sm text-muted-foreground">
              <span className={cn("amount mr-1.5 text-2xl text-foreground", remaining < 0 && "text-destructive")}>{currency(Math.abs(remaining))}</span>
              {remaining < 0 ? "über Budget" : "übrig"}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">{currency(actual)} von {currency(plan.total)}</p>
          </div>
          <AnimatedProgress
            value={actual}
            max={plan.total}
            label="Alltagsbudget gesamt"
            valueText={`${currency(actual)} von ${currency(plan.total)}`}
            tone={budgetTone(actual, plan.total)}
            className="mt-3 h-2.5"
          />
        </FinancialData>
        <FinancialData as="ul" className="mt-6 space-y-4">
          {ranked.map((row, index) => {
            const group = parseBudgetGroup(row.id);
            const href = group ? ledgerHref({ month: currentMonth, group }) : undefined;
            return (
              <li key={row.id}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  {href ? (
                    <Link href={href} title="Buchungen dieses Budgets anzeigen" className="min-w-0 truncate font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      {row.label}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate font-medium">{row.label}</span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    <span className="font-medium text-foreground">{currency(row.actual)}</span> / {currency(row.total)}
                  </span>
                </div>
                <AnimatedProgress
                  value={row.actual}
                  max={row.total}
                  label={`${row.label} Budgetverbrauch`}
                  valueText={`${currency(row.actual)} von ${currency(row.total)}`}
                  tone={budgetTone(row.actual, row.total)}
                  delay={0.06 * (index + 1)}
                  className="mt-2 h-1.5"
                />
                <p className={cn("mt-1 text-2xs", row.remaining < 0 ? "font-medium text-destructive" : "text-muted-foreground")}>
                  {row.remaining < 0 ? `${currency(-row.remaining)} über Budget` : `${currency(row.remaining)} übrig`}
                </p>
              </li>
            );
          })}
        </FinancialData>
      </CardContent>
    </Card>
  );
}
