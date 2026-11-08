"use client";

import { useMemo, useState } from "react";
import { CopyX, Repeat, Sparkles, TrendingUp, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { SectionHeading } from "@/components/finance-ui";
import { type SummaryFacts } from "@/lib/ai/summary";
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

function shortSummary(facts: SummaryFacts) {
  const month = facts.monthLabel.split(" ")[0];
  const change = facts.previousSpending === undefined ? "" : ` – ${currency(Math.abs(facts.spending - facts.previousSpending))} ${facts.spending > facts.previousSpending ? "mehr" : "weniger"} als im Vormonat`;
  const top = facts.topCategories[0];
  return `${month}: ${currency(facts.spending)} ausgegeben, ${currency(facts.income)} eingenommen${change}.${top ? ` Meiste Ausgaben: ${top.category}.` : ""}`;
}

export function FinanceInsightsPanel() {
  const { state } = useFinance();
  const insights = useMemo(() => financeInsights(state), [state]);
  const facts = useMemo(() => summaryFacts(insights), [insights]);
  const [written, setWritten] = useState<{ key: string; text: string; source: "KI" | "Regel" }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const key = JSON.stringify(facts);
  const text = written?.key === key ? written.text : shortSummary(facts);
  const monthlySubscriptions = insights.subscriptions.reduce((sum, item) => sum + item.monthlyCost, 0);
  const { forecast, learning } = insights;

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

  const hints = [
    ...insights.duplicateFixedCosts.map((item) => ({
      key: `fixed-${item.ids.join("-")}`, merchant: item.label,
      text: `${item.count}× ${currency(item.amount)} in den Fixkosten – vermutlich doppelt`,
    })),
    ...insights.duplicates.map((item) => ({
      key: item.ids.join("-"), merchant: item.merchant,
      text: `${currency(Math.abs(item.amount))} zweimal abgebucht (${dateLabel(item.dates[0])}, ${dateLabel(item.dates[1])})`,
    })),
    ...insights.priceIncreases.flatMap((item) => item.priceChange ? [{
      key: `price-${item.merchant}`, merchant: item.merchant,
      text: `teurer geworden: ${currency(item.priceChange.from)} → ${currency(item.priceChange.to)}`,
    }] : []),
  ];
  const high = forecast.averageSpending !== undefined && forecast.projectedSpending > forecast.averageSpending * 1.1;

  return <section className="panel mb-5 p-5 sm:p-6" aria-label="Einblicke">
    <SectionHeading title="Einblicke" subtitle="Dein Monat auf einen Blick">
      <Sparkles aria-hidden="true" className="size-4 text-primary" />
    </SectionHeading>
    <FinancialData className="grid gap-3">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-sm leading-relaxed" aria-live="polite">{text}</p>
        <Button type="button" size="icon-sm" variant="ghost" onClick={write} disabled={busy}
          aria-label="Von der KI neu formulieren" title="Von der KI neu formulieren">
          <Sparkles aria-hidden="true" className={cn("size-4", busy && "animate-pulse")} />
        </Button>
      </div>
      {error && <p className="text-2xs text-destructive">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile icon={TrendingUp} label={`Prognose ${monthLabel(forecast.month)}`} value={currency(forecast.projectedSpending)}
          tone={high ? "text-destructive" : "text-primary"}
          note={forecast.averageSpending !== undefined ? `sonst ca. ${currency(forecast.averageSpending)}` : `bisher ${currency(forecast.spentSoFar)}`} />
        <Tile icon={Repeat} label="Abos" value={`${currency(monthlySubscriptions)} / Monat`}
          note={insights.subscriptions.length ? insights.subscriptions.slice(0, 3).map((item) => item.merchant).join(", ") : "keine erkannt"} />
        <Tile icon={Wand2} label="Automatisch sortiert" value={learning.share !== undefined ? `${learning.share} %` : "–"}
          note="deiner importierten Buchungen" />
      </div>
      {hints.length > 0 && <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4" aria-label="Bitte prüfen">
        <h3 className="flex items-center gap-2 text-sm font-medium"><CopyX aria-hidden="true" className="size-4 text-destructive" />Bitte prüfen</h3>
        <ul className="mt-2 grid gap-1.5 text-xs">
          {hints.slice(0, 3).map((hint) => <li key={hint.key} className="min-w-0 truncate">
            <strong className="font-medium">{hint.merchant}</strong> <span className="text-muted-foreground">· {hint.text}</span>
          </li>)}
        </ul>
        {hints.length > 3 && <p className="mt-2 text-2xs text-muted-foreground">und {hints.length - 3} weitere</p>}
      </div>}
    </FinancialData>
  </section>;
}

function Tile({ icon: Icon, label, value, note, tone }: {
  icon: typeof Repeat; label: string; value: string; note: string; tone?: string;
}) {
  return <article className="min-w-0 rounded-2xl border border-border/70 bg-background/40 p-4" aria-label={label}>
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon aria-hidden="true" className="size-3.5" />{label}</p>
    <p className={cn("mt-1.5 text-xl font-semibold tabular-nums", tone)}>{value}</p>
    <p className="mt-1 truncate text-xs text-muted-foreground">{note}</p>
  </article>;
}