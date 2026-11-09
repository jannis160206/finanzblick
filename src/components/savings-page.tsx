"use client";

import { useMemo } from "react";
import { TrendingUp } from "lucide-react";
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

const partNames: Record<string, string> = { girokonto: "Girokonto", amex: "Amex offen", tr: "Trade Republic", "trade republic": "Trade Republic", pro: "Pro" };
const partLabel = (key: string) =>
  partNames[key] ?? key.replace(/(^|[\s&/-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toLocaleUpperCase("de"));

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
      <FinancialData className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-3xl font-semibold tracking-tight tabular-nums">{currency(latest.total)}</p>
        {points.length > 1 && <p className={change >= 0 ? "text-sm text-primary" : "text-sm text-destructive"}>
          {change >= 0 ? "+" : ""}{currency(change)} seit {monthLabel(first.month, true)}
        </p>}
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
      {Object.values(latest.parts).some((value) => Math.abs(value) >= 0.005) && <FinancialData as="dl" className="mt-4 grid gap-x-6 gap-y-2 border-t border-border/60 pt-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(latest.parts).filter(([, value]) => Math.abs(value) >= 0.005).sort(([, a], [, b]) => b - a).map(([name, value]) => <div key={name} className="flex justify-between gap-2">
          <dt className="text-muted-foreground">{partLabel(name)}</dt><dd className={value < 0 ? "tabular-nums text-destructive" : "tabular-nums"}>{currency(value)}</dd>
        </div>)}
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
