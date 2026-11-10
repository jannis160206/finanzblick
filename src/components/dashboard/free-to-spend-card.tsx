"use client";

import dynamic from "next/dynamic";
import { ChevronDown, MessageSquareText, WalletCards } from "lucide-react";
import { useDashboardExtras } from "@/components/dashboard/use-dashboard-extras";
import { FinancialData } from "@/components/financial-data";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { askAssistant } from "@/lib/assistant-bus";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import type { MonthEndForecast } from "@/lib/month-forecast";
import { cn } from "@/lib/utils";

const MonthForecastChart = dynamic(() => import("@/components/charts/month-forecast-chart"), {
  ssr: false,
  loading: () => <Skeleton className="size-full" />,
});

type Forecast = Extract<MonthEndForecast, { status: "ok" }>;

const dayMonth = (date: string) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}.`;
const monthName = (month: string) => monthLabel(month).replace(/\s\d{4}$/, "");

export function FreeToSpendCard({ className }: { className?: string }) {
  // The projection walks every remaining day; it runs off the main thread after the first paint.
  const forecast = useDashboardExtras()?.forecast;
  if (!forecast) return <Skeleton className={cn("min-h-64 rounded-3xl border border-border/60", className)} />;
  if (forecast.status === "unknown") return <UnknownBalance month={forecast.month} className={className} />;
  return <FreeToSpend forecast={forecast} className={className} />;
}

function UnknownBalance({ month, className }: { month: string; className?: string }) {
  return (
    <section aria-labelledby="overview-free-title" className={cn("flex flex-col gap-4 rounded-3xl border border-dashed border-border bg-card p-5 sm:flex-row sm:items-center sm:p-7", className)}>
      <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><WalletCards className="size-5" /></span>
      <div className="min-w-0 flex-1">
        <h2 id="overview-free-title" className="text-sm font-semibold">Frei verfügbar bis Ende {monthName(month)}</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Dafür fehlt ein aktueller Girokonto-Stand. Importiere einen Kontoauszug oder sag dem Assistenten z. B. „Merk dir: Girokonto 1.500 €“.
        </p>
      </div>
      <Button variant="outline" size="sm" className="min-h-11 self-start sm:self-center" onClick={() => askAssistant()}>
        <MessageSquareText aria-hidden="true" />Assistent öffnen
      </Button>
    </section>
  );
}

function FreeToSpend({ forecast: f, className }: { forecast: Forecast; className?: string }) {
  const end = `${Number(f.monthEnd.slice(8))}. ${monthName(f.month)}`;
  const floor = f.buffer;
  const points = f.points.map((point) => ({ label: dayMonth(point.date), balance: point.balance }));
  const upcoming = f.events.filter((event) => event.amount < 0).slice(0, 3);
  const source = f.source.kind === "note" ? "Kontostand laut deiner Notiz"
    : `Kontostand vom ${dateLabel(f.source.date)}${f.source.kind === "mixed" ? " plus Notiz" : ""}`;
  const steps: { label: string; value: number; hint?: string; total?: boolean }[] = [
    { label: "Kontostand heute", value: f.start, total: true },
    { label: "Erwartete Eingänge", value: f.income, hint: "z. B. Gehalt, sofern noch nicht eingegangen" },
    { label: "Offene Fixkosten", value: -f.fixed },
    { label: "Verträge & Abos", value: -f.contracts },
    { label: "Kreditkarten-Abbuchung", value: -f.amex },
    { label: "Sparraten", value: -f.transfers },
    { label: "Geplante Ausgaben", value: -f.planned },
  ].filter((step, index) => index === 0 || Math.abs(step.value) >= 0.005);
  const tail: { label: string; value: number; hint?: string }[] = [
    ...(f.reserve >= 0.005 ? [{ label: "Reserve bis zum Geldeingang", value: -f.reserve, hint: `tiefster Stand am ${dateLabel(f.lowestCommitted.date)}` }] : []),
    ...(f.buffer >= 0.005 ? [{ label: "Dein Puffer", value: -f.buffer }] : []),
  ];
  const toneText = f.tone === "negative"
    ? `Bis Monatsende fehlen voraussichtlich ${currency(-f.free)}. Prüfe geplante Ausgaben oder verschiebe eine Sparrate.`
    : f.tone === "tight"
      ? `Dein Budget plant noch ${currency(f.spending)} für den Alltag – mehr, als frei ist. Plane eher mit ${currency(f.perDay)} pro Tag.`
      : null;
  return (
    <section aria-labelledby="overview-free-title" className={cn("overflow-hidden rounded-3xl border border-border/80 bg-card shadow-card", className)}>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="flex min-w-0 flex-col p-5 sm:p-7">
          <h2 id="overview-free-title" className="text-sm font-medium text-muted-foreground">Frei verfügbar bis {end}</h2>
          <FinancialData as="p" className={cn("amount mt-1 break-words text-4xl sm:text-5xl", f.tone === "negative" ? "text-destructive" : f.tone === "tight" ? "text-warning" : "text-foreground")}>
            {currency(f.free)}
          </FinancialData>
          <FinancialData as="p" className="mt-2 text-sm text-muted-foreground">
            ≈ <span className="font-semibold text-foreground tabular-nums">{currency(f.perDay)}</span> pro Tag · {f.daysLeft === 1 ? "heute letzter Tag" : `noch ${f.daysLeft} Tage`}
          </FinancialData>
          <FinancialData as="dl" className="mt-6 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border/60 pt-4">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Kontostand heute</dt>
              <dd className="amount mt-0.5 text-lg">{currency(f.start)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Am Monatsende</dt>
              <dd className={cn("amount mt-0.5 text-lg", f.endBalance < 0 && "text-destructive")}>{currency(f.endBalance)}</dd>
            </div>
          </FinancialData>
          <p className="mt-auto pt-4 text-2xs text-muted-foreground">{source} · Monatsende inkl. {currency(f.spending)} geplanter Alltagsausgaben</p>
        </div>
        <div className="flex min-w-0 flex-col gap-4 border-t border-border/60 p-5 sm:p-6 lg:border-t-0 lg:border-l">
          <FinancialData className="h-36 sm:h-40" role="img" aria-label={`Voraussichtlicher Kontostand bis ${end}, tiefster Stand ${currency(f.lowest.balance)} am ${dateLabel(f.lowest.date)}`}>
            <MonthForecastChart data={points} floor={floor} />
          </FinancialData>
          {upcoming.length > 0 && (
            <div>
              <p className="mb-1 text-2xs font-medium text-muted-foreground">Nächste Abbuchungen</p>
              <FinancialData as="ul" className="divide-y divide-border/60">
                {upcoming.map((event) => (
                  <li key={`${event.date}:${event.label}`} className="flex items-center gap-3 py-1.5 text-sm">
                    <span className="w-11 shrink-0 text-xs tabular-nums text-muted-foreground">{dayMonth(event.date)}</span>
                    <span className="min-w-0 flex-1 truncate">{event.label}</span>
                    <span className="shrink-0 font-medium tabular-nums">{currency(event.amount)}</span>
                  </li>
                ))}
              </FinancialData>
            </div>
          )}
        </div>
      </div>
      {toneText && (
        <FinancialData as="p" role="status" className={cn("border-t px-5 py-3 text-xs sm:px-7",
          f.tone === "negative" ? "border-destructive/20 bg-destructive-soft text-destructive" : "border-warning/20 bg-warning-soft text-foreground")}>
          {toneText}
        </FinancialData>
      )}
      <details className="group border-t border-border/60">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-7 [&::-webkit-details-marker]:hidden">
          So wird gerechnet
          <ChevronDown aria-hidden="true" className="size-4 transition-transform duration-200 ease-soft group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <FinancialData as="dl" className="grid gap-y-1.5 px-5 pb-5 text-sm sm:px-7">
          {steps.map(({ total, ...step }) => <BreakdownRow key={step.label} {...step} plain={total} />)}
          <BreakdownRow label="Am Monatsende ohne Alltagsausgaben" value={f.endCommitted} total />
          {tail.map((step) => <BreakdownRow key={step.label} {...step} />)}
          <BreakdownRow label="Frei verfügbar" value={f.free} total strong />
        </FinancialData>
      </details>
    </section>
  );
}

function BreakdownRow({ label, value, hint, total = false, strong = false, plain = false }: { label: string; value: number; hint?: string; total?: boolean; strong?: boolean; plain?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4", total && "mt-1 border-t border-border/60 pt-2")}>
      <dt className={cn("min-w-0", total ? "font-medium" : "text-muted-foreground")}>
        {label}{hint && <span className="block text-2xs text-muted-foreground">{hint}</span>}
      </dt>
      <dd className={cn("shrink-0 tabular-nums", strong ? "text-base font-semibold" : "font-medium", value < 0 && !total && "text-muted-foreground")}>
        {value > 0 && !total && !plain ? "+" : ""}{currency(value)}
      </dd>
    </div>
  );
}
