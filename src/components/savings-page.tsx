"use client";

import { useMemo } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Pockets } from "@/components/pockets";
import { SavingsGoals } from "@/components/savings-goals";
import { TradeRepublicSettings } from "@/components/settings";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { MonthlyFunding } from "@/components/monthly-funding";
import { SectionHeading } from "@/components/finance-ui";
import { netWorthHistory } from "@/lib/net-worth";
import { currency, monthLabel, shortCurrency } from "@/lib/format";
import { ChartTooltip, chartAxisProps, chartCursor, chartGridProps } from "@/components/charts/chart-theme";
import { netWorthPartIcon, netWorthPartLabel as partLabel, visibleNetWorthParts } from "@/components/net-worth-parts";

export function NetWorthPanel() {
  const { state, dashboard } = useFinance();
  const points = useMemo(() => netWorthHistory(state, dashboard)
    .map((point) => ({ ...point, label: monthLabel(point.month, true) })), [state, dashboard]);
  const latest = points.at(-1);
  if (!latest) return null;
  const first = points[0];
  const change = latest.total - first.total;
  return (
    <section className="panel mt-5 min-w-0 p-5 sm:p-6" aria-label="Nettovermögen">
      <SectionHeading title="Nettovermögen">
        <TrendingUp aria-hidden="true" className="size-4 text-primary" />
      </SectionHeading>
      <FinancialData className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="amount text-3xl">{currency(latest.total)}</p>
        {points.length > 1 && <Badge variant={change >= 0 ? "success" : "destructive"}>
          {change >= 0 ? <TrendingUp aria-hidden="true" /> : <TrendingDown aria-hidden="true" />}
          {change >= 0 ? "+" : ""}{currency(change)} seit {monthLabel(first.month, true)}
        </Badge>}
      </FinancialData>
      {points.length > 1 && <FinancialData className="h-56" role="img" aria-label="Verlauf des Nettovermögens">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ left: -15, right: 8, top: 10 }}>
            <defs>
              <linearGradient id="net-worth-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...chartGridProps} />
            <XAxis dataKey="label" {...chartAxisProps} minTickGap={25} />
            <YAxis tickFormatter={shortCurrency} {...chartAxisProps} width={64} />
            <Tooltip content={<ChartTooltip />} cursor={chartCursor} />
            <Area type="monotone" dataKey="total" name="Nettovermögen" stroke="var(--chart-1)" fill="url(#net-worth-fill)" strokeWidth={2} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </FinancialData>}
      {visibleNetWorthParts(latest.parts).length > 0 && <FinancialData as="dl" className="mt-5 grid gap-2 border-t border-border/60 pt-5 sm:grid-cols-2 lg:grid-cols-3">
        {visibleNetWorthParts(latest.parts).map(([name, value]) => {
          const Icon = netWorthPartIcon(name);
          return <div key={name} className="flex min-w-0 items-center gap-3 rounded-xl bg-surface-sunken px-3 py-2.5">
            <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground shadow-xs"><Icon className="size-4" /></span>
            <dt className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{partLabel(name)}</dt>
            <dd className={value < 0 ? "shrink-0 text-sm font-medium tabular-nums text-destructive" : "shrink-0 text-sm font-medium tabular-nums"}>{currency(value)}</dd>
          </div>;
        })}
      </FinancialData>}
    </section>
  );
}

// Sparen = Pockets, Nettovermögen, Sparziele and Trade Republic on one page.
export function SavingsPage() {
  return (
    <>
      <Pockets />
      <MonthlyFunding />
      <NetWorthPanel />
      <div className="mt-5 space-y-5">
        <SavingsGoals />
        <TradeRepublicSettings />
      </div>
    </>
  );
}
