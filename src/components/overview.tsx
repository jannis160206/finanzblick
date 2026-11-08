"use client";

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
import { CategoryDonut } from "@/components/category-donut";
import { SeasonalIcon } from "@/components/seasonal-icons";
import { SectionHeading } from "@/components/finance-ui";
import { ledgerHref } from "@/lib/ledger-link";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { pocketNames } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PlannedOneOffLines, PlannedOneOffs } from "@/components/planned-one-offs";
import { EmptyState } from "@/components/ui/empty-state";
import { FinanceInsightsPanel } from "@/components/finance-insights";
import { bankPocketBalance, physicalPocketBalances } from "@/lib/goals";
import { round, sum } from "@/lib/calc";
import { StackedBar } from "@/components/stacked-bar";

const chartTooltip = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  color: "var(--foreground)",
  fontSize: 12,
};

export function Overview() {
  const { state, dashboard: d } = useFinance();
  const incompleteAssets = Object.values(physicalPocketBalances(state, d.actual)).some((balance) => balance.amount === null);
  const reserves = sum(pocketNames.map((pocket) => bankPocketBalance(state, pocket, d.actual) ?? 0));
  const surplusKpi = {
    label: "Überschuss · Plan",
    value: d.current.surplus,
    color: d.current.surplus >= 0 ? "text-primary" : "text-destructive",
    hint: "Frei nach allen geplanten Ausgaben.",
  };
  const statKpis: { label: string; value: number; icon: typeof Wallet; color: string; note?: string; hint?: string; href?: string }[] = [
    {
      label: "Einnahmen · Plan",
      value: d.current.income,
      note: `Erhalten: ${currency(d.current.received)}`,
      icon: ArrowDownLeft,
      color: "text-primary",
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
      <div className="overview-heading mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <SeasonalIcon slot="overview" className="seasonal-detail size-4" fallback={<CalendarDays aria-hidden="true" className="size-4" />} />
            {monthLabel(d.currentMonth)}
            <FinancialData as="span" className="border-l border-border/70 pl-2 text-2xs">Stand {dateLabel(state.settings.asOf)}</FinancialData>
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-[34px]">Übersicht</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PlannedOneOffs className="min-h-11 rounded-xl" />
        </div>
      </div>
      <div className="mb-5 grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section aria-label={surplusKpi.label} aria-describedby="overview-metric-0-hint" className={cn("min-w-0 overflow-hidden rounded-3xl border bg-gradient-to-br to-card shadow-sm",
          d.current.surplus >= 0 ? "border-primary/25 from-primary/10" : "border-destructive/25 from-destructive/10")}>
          <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4 sm:px-6">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">{surplusKpi.label}</p>
              <FinancialData as="p" className={cn("mt-1 break-words text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl", surplusKpi.color)}>
                {currency(surplusKpi.value)}
              </FinancialData>
              <p id="overview-metric-0-hint" className="mt-1.5 text-xs text-muted-foreground">{surplusKpi.hint}</p>
            </div>
            <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-2xl bg-background/70", surplusKpi.color)}>
              <Wallet aria-hidden="true" className="size-5" />
            </span>
          </div>
          <StackedBar label="Aufteilung der Einnahmen" base={d.current.income} parts={[
            { key: "Fixkosten", value: d.current.fixed, tone: "bg-chart-4" },
            { key: "Alltag", value: round(d.current.variablePlan - d.current.amexOpen), tone: "bg-sky-500" },
            { key: "Kreditkarte", value: d.current.amexOpen, tone: "bg-violet-500" },
            { key: "Einmalig", value: d.current.plannedOneOffs, tone: "bg-rose-400" },
            { key: "Frei", value: Math.max(0, d.current.surplus), tone: "bg-primary" },
          ]} />
        </section>
        <div className="grid min-w-0 divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm sm:grid-cols-3 sm:divide-x sm:divide-y-0 lg:grid-cols-1 lg:divide-x-0 lg:divide-y">
          {statKpis.map((kpi, index) => {
            const describedBy = kpi.hint ? `overview-metric-${index + 1}-hint` : undefined;
            const body = <>
              <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full bg-muted/70", kpi.color)}>
                {kpi.label === "Ausgaben · Ist" ? <SeasonalIcon slot="expense" className="seasonal-detail size-4" fallback={<kpi.icon aria-hidden="true" className="size-4" />} /> : <kpi.icon aria-hidden="true" className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-muted-foreground">{kpi.label}</span>
                <FinancialData as="span" className="block break-words text-xl font-semibold tracking-tight tabular-nums">{currency(kpi.value)}</FinancialData>
                {kpi.note && <FinancialData as="span" className="block text-2xs text-muted-foreground">{kpi.note}</FinancialData>}
                {kpi.hint && <FinancialData as="span" id={describedBy} className="block text-2xs text-muted-foreground">{kpi.hint}</FinancialData>}
              </span>
              {kpi.href && <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />}
            </>;
            return (
              <section key={kpi.label} aria-label={kpi.label} aria-describedby={describedBy} className="min-w-0">
                {kpi.href
                  ? <Link href={kpi.href} className="group flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">{body}</Link>
                  : <div className="flex min-h-16 items-center gap-3 px-4 py-3">{body}</div>}
              </section>
            );
          })}
        </div>
      </div>
      <div className="mb-5 empty:hidden"><PlannedOneOffLines /></div>
      <FinanceInsightsPanel />
      <section className="panel min-w-0 p-5 sm:p-6">
        <SectionHeading title="Ausgaben nach Kategorie" />
        {d.spending.length ? (
          <CategoryDonut spending={d.spending} tooltipStyle={chartTooltip} />
        ) : (
          <EmptyState icon={ReceiptText} title="Noch keine Ausgaben" className="min-h-48" />
        )}
      </section>
    </>
  );
}
