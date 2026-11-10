"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Pockets } from "@/components/pockets";
import { SavingsGoals } from "@/components/savings-goals";
import { TradeRepublicCard } from "@/components/trade-republic-card";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { MonthlyFunding } from "@/components/monthly-funding";
import { SectionHeading } from "@/components/finance-ui";
import { netWorthHistory } from "@/lib/net-worth";
import { currency, monthLabel } from "@/lib/format";
import { netWorthPartIcon, netWorthPartLabel as partLabel, visibleNetWorthParts } from "@/components/net-worth-parts";

const NetWorthHistoryChart = dynamic(() => import("@/components/charts/net-worth-history-chart"), {
  ssr: false,
  loading: () => <Skeleton className="size-full" />,
});

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
        <NetWorthHistoryChart data={points} />
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
        <TradeRepublicCard />
      </div>
    </>
  );
}
