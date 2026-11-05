"use client";

import { useMemo, useState } from "react";
import { CopyX, Repeat, Sparkles, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { SectionHeading } from "@/components/finance-ui";
import { fallbackSummary, type SummaryFacts } from "@/lib/ai/summary";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { financeInsights, type FinanceInsights as Insights } from "@/lib/insights";
import { cn } from "@/lib/utils";

export function summaryFacts(insights: Insights): SummaryFacts {
  const month = insights.previousSummary ?? insights.summary;
  return {
    monthLabel: monthLabel(month.month),
    income: month.income,
    spending: month.spending,
    balance: month.balance,
    ...(month.previousSpending !== undefined ? { previousSpending: month.previousSpending } : {}),
    topCategories: month.topCategories,
    largest: month.largest.map(({ merchant, amount, category }) => ({ merchant: merchant.slice(0, 60), amount, category })),
    subscriptions: insights.subscriptions.slice(0, 20).map(({ merchant, monthlyCost }) => ({ merchant: merchant.slice(0, 60), monthlyCost })),
    priceIncreases: insights.priceIncreases.slice(0, 10).flatMap(({ merchant, priceChange }) =>
      priceChange ? [{ merchant: merchant.slice(0, 60), from: priceChange.from, to: priceChange.to }] : []),
    duplicates: Math.min(insights.duplicates.length, 100),
    forecast: {
      projectedSpending: insights.forecast.projectedSpending,
      ...(insights.forecast.averageSpending !== undefined ? { averageSpending: insights.forecast.averageSpending } : {}),
      monthLabel: monthLabel(insights.forecast.month),
    },
  };
}

export function FinanceInsightsPanel() {
  const { state } = useFinance();
  const insights = useMemo(() => financeInsights(state), [state]);
  const facts = useMemo(() => summaryFacts(insights), [insights]);
  const [written, setWritten] = useState<{ key: string; text: string; source: "KI" | "Regel" }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const key = JSON.stringify(facts);
  const text = written?.key === key ? written.text : fallbackSummary(facts);
  const monthlySubscriptions = insights.subscriptions.reduce((sum, item) => sum + item.monthlyCost, 0);
  const { forecast } = insights;

  const write = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/ai/summary", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: key, cache: "no-store",
      });
      const body = await response.json() as { text?: string; source?: "KI" | "Regel"; error?: string };
      if (!response.ok || !body.text) throw new Error(body.error ?? "Die lokale KI ist nicht erreichbar.");
      setWritten({ key, text: body.text, source: body.source ?? "Regel" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Die lokale KI ist nicht erreichbar.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="panel mb-5 p-5 sm:p-6" aria-label="KI-Einblicke">
    <SectionHeading title="KI-Einblicke" subtitle="Abos, Auffälligkeiten und Prognose aus deinen Buchungen">
      <Sparkles aria-hidden="true" className="size-4 text-primary" />
    </SectionHeading>
    <FinancialData className="grid gap-3 lg:grid-cols-2">
      <article className="min-w-0 rounded-2xl border border-border/70 bg-background/40 p-4 lg:col-span-2" aria-label="Monatszusammenfassung">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Monatszusammenfassung</h3>
          <Button type="button" size="sm" variant="outline" onClick={write} disabled={busy}>
            <Sparkles aria-hidden="true" className="size-3.5" />{busy ? "KI schreibt …" : "Von KI formulieren"}
          </Button>
        </div>
        <p className="mt-3 text-sm leading-relaxed" aria-live="polite">{text}</p>
        {written?.key === key && <p className="mt-2 text-2xs text-muted-foreground">
          {written.source === "KI" ? "Von der lokalen KI formuliert, Zahlen geprüft." : "KI-Text enthielt ungeprüfte Zahlen – sichere Zusammenfassung angezeigt."}
        </p>}
        {error && <p className="mt-2 text-2xs text-destructive">{error}</p>}
      </article>
      <article className="min-w-0 rounded-2xl border border-border/70 bg-background/40 p-4" aria-label="Budgetprognose">
        <h3 className="flex items-center gap-2 text-sm font-medium"><TrendingUp aria-hidden="true" className="size-4 text-primary" />Budgetprognose {monthLabel(forecast.month)}</h3>
        <p className={cn("mt-3 text-2xl font-semibold tabular-nums", forecast.averageSpending !== undefined && forecast.projectedSpending > forecast.averageSpending * 1.1 ? "text-destructive" : "text-primary")}>
          {currency(forecast.projectedSpending)}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Bisher ausgegeben</dt><dd className="text-right tabular-nums">{currency(forecast.spentSoFar)}</dd>
          <dt className="text-muted-foreground">Erwartete Abos</dt><dd className="text-right tabular-nums">{currency(forecast.expectedSubscriptions)}</dd>
          <dt className="text-muted-foreground">Erwartet variabel ({forecast.daysLeft} Tage)</dt><dd className="text-right tabular-nums">{currency(forecast.expectedVariable)}</dd>
          {forecast.averageSpending !== undefined && <><dt className="text-muted-foreground">Ø letzte 3 Monate</dt><dd className="text-right tabular-nums">{currency(forecast.averageSpending)}</dd></>}
        </dl>
      </article>
      <article className="min-w-0 rounded-2xl border border-border/70 bg-background/40 p-4" aria-label="Erkannte Abos">
        <h3 className="flex items-center gap-2 text-sm font-medium"><Repeat aria-hidden="true" className="size-4 text-primary" />Erkannte Abos
          <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">{currency(monthlySubscriptions)} / Monat</span></h3>
        {insights.subscriptions.length ? <ul className="mt-3 grid gap-2">
          {insights.subscriptions.map((item) => <li key={`${item.merchant}-${item.interval}`} className="flex min-w-0 items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate">{item.merchant} <span className="text-muted-foreground">· {item.interval} · nächste ca. {dateLabel(item.nextDate)}</span></span>
            <span className={cn("shrink-0 tabular-nums", item.priceChange && "text-destructive")}>{currency(-item.amount)}</span>
          </li>)}
        </ul> : <p className="mt-3 text-xs text-muted-foreground">Keine laufenden Abos erkannt.</p>}
      </article>
      {(insights.priceIncreases.length > 0 || insights.duplicates.length > 0) && <article className="min-w-0 rounded-2xl border border-destructive/40 bg-destructive/5 p-4 lg:col-span-2" aria-label="Auffälligkeiten">
        <h3 className="flex items-center gap-2 text-sm font-medium"><CopyX aria-hidden="true" className="size-4 text-destructive" />Auffälligkeiten</h3>
        <ul className="mt-3 grid gap-2 text-xs">
          {insights.priceIncreases.map((item) => item.priceChange && <li key={`price-${item.merchant}`}>
            Preiserhöhung bei <strong>{item.merchant}</strong>: {currency(item.priceChange.from)} → {currency(item.priceChange.to)} (+{item.priceChange.percent.toLocaleString("de-AT")} %) seit {dateLabel(item.priceChange.date)}
          </li>)}
          {insights.duplicates.map((item) => <li key={item.ids.join("-")}>
            Mögliche Doppelabbuchung: <strong>{item.merchant}</strong> {currency(item.amount)} am {dateLabel(item.dates[0])} und {dateLabel(item.dates[1])} – bitte prüfen.
          </li>)}
        </ul>
      </article>}
    </FinancialData>
  </section>;
}
