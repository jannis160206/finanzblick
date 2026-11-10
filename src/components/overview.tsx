"use client";

import { useDeferredValue, useMemo } from "react";
import Link from "next/link";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  PiggyBank,
  ReceiptText,
  Wallet,
} from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import { SeasonalIcon } from "@/components/seasonal-icons";
import { ledgerHref } from "@/lib/ledger-link";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { pocketNames } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PlannedOneOffLines, PlannedOneOffs } from "@/components/planned-one-offs";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FinanceInsightsPanel } from "@/components/finance-insights";
import { bankPocketBalance, physicalPocketBalances } from "@/lib/goals";
import { round, sum } from "@/lib/calc";
import { netWorthHistory } from "@/lib/net-worth";
import { StackedBar } from "@/components/stacked-bar";
import { BudgetProgressCard } from "@/components/dashboard/budget-progress-card";
import { NetWorthCard } from "@/components/dashboard/net-worth-card";
import { GoalsCard } from "@/components/dashboard/goals-card";
import { ContractsCard } from "@/components/dashboard/contracts-card";
import { FreeToSpendCard } from "@/components/dashboard/free-to-spend-card";

const CategoryDonut = dynamic(() => import("@/components/category-donut").then((module) => module.CategoryDonut), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
});

export function Overview() {
  const { state, dashboard: d } = useFinance();
  const incompleteAssets = Object.values(physicalPocketBalances(state, d.actual)).some((balance) => balance.amount === null);
  const reserves = sum(pocketNames.map((pocket) => bankPocketBalance(state, pocket, d.actual) ?? 0));
  // Net worth history is CPU-heavy; computing it after the first paint keeps the key figures fast.
  const deferredState = useDeferredValue<typeof state | null>(state, null);
  const deferredDashboard = useDeferredValue<typeof d | null>(d, null);
  const netWorth = useMemo(
    () => (deferredState && deferredDashboard ? netWorthHistory(deferredState, deferredDashboard) : null),
    [deferredState, deferredDashboard],
  );
  const positive = d.current.surplus >= 0;
  const surplusKpi = {
    label: "Überschuss · Plan",
    value: d.current.surplus,
    color: positive ? "text-money-in" : "text-destructive",
    hint: "Frei nach allen geplanten Ausgaben.",
  };
  const statKpis: { label: string; value: number; icon: typeof Wallet; color: string; note?: string; hint?: string; href?: string }[] = [
    {
      label: "Einnahmen · Plan",
      value: d.current.income,
      note: `Erhalten: ${currency(d.current.received)}`,
      icon: ArrowDownLeft,
      color: "text-money-in",
    },
    {
      label: "Ausgaben · Ist",
      value: d.current.actualSpending,
      icon: ArrowUpRight,
      color: "text-chart-4",
      href: ledgerHref({ month: d.currentMonth }),
    },
    {
      label: "Guthaben gesamt",
      value: d.totalAssets,
      note: incompleteAssets ? "Unvollständig · nicht alle Konten bekannt" : `davon Reserven ${currency(reserves)}`,
      icon: PiggyBank,
      color: "text-primary",
      href: "/sparen",
    },
  ];
  return (
    <>
      <div className="overview-heading mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 sm:mb-8">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-title">Übersicht</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <SeasonalIcon slot="overview" className="seasonal-detail size-4" fallback={<CalendarDays aria-hidden="true" className="size-4" />} />
            {monthLabel(d.currentMonth)}
            <FinancialData as="span" className="border-l border-border pl-2 text-xs">Stand {dateLabel(state.settings.asOf)}</FinancialData>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PlannedOneOffs className="min-h-11 rounded-xl" />
        </div>
      </div>
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section
          aria-label={surplusKpi.label}
          aria-describedby="overview-metric-0-hint"
          className={cn(
            "flex min-w-0 flex-col overflow-hidden rounded-3xl border shadow-card",
            positive ? "border-success/20 bg-success-soft" : "border-destructive/25 bg-destructive-soft",
          )}
        >
          <div className="flex flex-1 items-start justify-between gap-3 px-5 pt-5 pb-4 sm:px-7 sm:pt-7">
            <div className="min-w-0">
              <p className="text-sm font-medium text-muted-foreground">{surplusKpi.label}</p>
              <FinancialData as="p" className={cn("amount mt-1 break-words text-4xl sm:text-5xl", surplusKpi.color)}>
                {currency(surplusKpi.value)}
              </FinancialData>
              <p id="overview-metric-0-hint" className="mt-2 text-xs text-muted-foreground">{surplusKpi.hint}</p>
            </div>
            <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-2xl bg-card/80 shadow-xs", surplusKpi.color)}>
              <Wallet aria-hidden="true" className="size-5" />
            </span>
          </div>
          <StackedBar label="Aufteilung der Einnahmen" base={d.current.income} parts={[
            { key: "Fixkosten", value: d.current.fixed, tone: "bg-chart-4" },
            { key: "Alltag", value: round(d.current.variablePlan - d.current.amexOpen), tone: "bg-chart-2" },
            { key: "Kreditkarte", value: d.current.amexOpen, tone: "bg-violet-500" },
            { key: "Einmalig", value: d.current.plannedOneOffs, tone: "bg-rose-400" },
            { key: "Frei", value: Math.max(0, d.current.surplus), tone: "bg-success" },
          ]} />
        </section>
        <div className="grid min-w-0 divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/80 bg-card shadow-card sm:grid-cols-3 sm:divide-x sm:divide-y-0 lg:grid-cols-1 lg:divide-x-0 lg:divide-y">
          {statKpis.map((kpi, index) => {
            const describedBy = kpi.hint ? `overview-metric-${index + 1}-hint` : undefined;
            const body = <>
              <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full bg-muted sm:max-lg:hidden", kpi.color)}>
                {kpi.label === "Ausgaben · Ist" ? <SeasonalIcon slot="expense" className="seasonal-detail size-4" fallback={<kpi.icon aria-hidden="true" className="size-4" />} /> : <kpi.icon aria-hidden="true" className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-muted-foreground">{kpi.label}</span>
                <FinancialData as="span" className="amount block break-words text-xl sm:max-lg:text-lg">{currency(kpi.value)}</FinancialData>
                {kpi.note && <FinancialData as="span" className="block text-2xs text-muted-foreground">{kpi.note}</FinancialData>}
                {kpi.hint && <FinancialData as="span" id={describedBy} className="block text-2xs text-muted-foreground">{kpi.hint}</FinancialData>}
              </span>
              {kpi.href && <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-[color,translate] duration-150 group-hover:translate-x-0.5 group-hover:text-primary motion-reduce:group-hover:translate-x-0" />}
            </>;
            return (
              <section key={kpi.label} aria-label={kpi.label} aria-describedby={describedBy} className="min-w-0">
                {kpi.href
                  ? <Link href={kpi.href} className="group flex h-full min-h-18 items-center gap-3 px-5 py-4 transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">{body}</Link>
                  : <div className="flex h-full min-h-18 items-center gap-3 px-5 py-4">{body}</div>}
              </section>
            );
          })}
        </div>
      </div>
      <FreeToSpendCard className="mb-4" />
      <div className="mb-4 empty:hidden"><PlannedOneOffLines /></div>
      <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-12">
        <BudgetProgressCard className="xl:col-span-7" />
        {netWorth
          ? <NetWorthCard points={netWorth} className="xl:col-span-5" />
          : <Skeleton className="min-h-80 rounded-2xl border border-border/60 xl:col-span-5" />}
        <GoalsCard compact className="xl:col-span-7" />
        <ContractsCard className="xl:col-span-5" />
      </div>
      <FinanceInsightsPanel />
      <Card as="section" aria-labelledby="overview-spending-title" className="min-w-0">
        <CardHeader>
          <CardTitle id="overview-spending-title">Ausgaben nach Kategorie</CardTitle>
        </CardHeader>
        <CardContent>
          {d.spending.length ? (
            <CategoryDonut spending={d.spending} />
          ) : (
            <EmptyState icon={ReceiptText} title="Noch keine Ausgaben" className="min-h-48" />
          )}
        </CardContent>
      </Card>
    </>
  );
}
