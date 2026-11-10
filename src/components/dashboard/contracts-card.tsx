"use client";

import { useDeferredValue, useMemo } from "react";
import Link from "next/link";
import { ArrowRight, CalendarClock, FileText, Sparkles, TrendingUp } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { addDays, contractChargesBetween, contractReminders, contractSummary, detectContracts } from "@/lib/contracts";
import { currency } from "@/lib/format";
import { cn } from "@/lib/utils";

const dayMonth = (date: string) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}.`;

export function ContractsCard({ className }: { className?: string }) {
  const { state } = useFinance();
  // Detection scans the whole ledger; running it after the first paint keeps the key figures fast.
  const deferred = useDeferredValue<typeof state | null>(state, null);
  const data = useMemo(() => {
    if (!deferred) return null;
    const today = deferred.settings.asOf;
    const contracts = detectContracts(deferred, today);
    return {
      summary: contractSummary(contracts, today),
      upcoming: contractChargesBetween(contracts, today, addDays(today, 30), today).slice(0, 3),
      reminder: contractReminders(contracts, today).find((item) => item.kind !== "missed"),
      empty: !contracts.some((contract) => contract.status !== "ignored"),
    };
  }, [deferred]);
  if (!data) return <Skeleton className={cn("min-h-72 rounded-2xl border border-border/60", className)} />;
  const { summary, upcoming, reminder, empty } = data;
  return (
    <Card as="section" aria-labelledby="overview-contracts-title" className={className}>
      <CardHeader>
        <CardTitle id="overview-contracts-title">Verträge & Abos</CardTitle>
        <CardAction>
          <Link href="/vertraege" className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-primary transition-colors hover:bg-accent-muted focus-visible:outline-2 focus-visible:outline-ring">
            Alle<ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4 pt-3">
        {empty ? (
          <EmptyState icon={FileText} title="Noch keine Verträge erkannt" className="min-h-40 flex-1">
            <p>Wiederkehrende Abbuchungen erscheinen hier automatisch.</p>
          </EmptyState>
        ) : (
          <>
            <FinancialData className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <p className="amount text-2xl">{currency(summary.monthly)}</p>
              <p className="text-xs text-muted-foreground">im Monat · {summary.active} laufend</p>
            </FinancialData>
            {(summary.review > 0 || reminder) && (
              <div className="space-y-1.5">
                {reminder && (
                  <Link href="/vertraege" className={cn("flex items-start gap-2 rounded-xl px-3 py-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                    reminder.tone === "bad" ? "bg-destructive-soft hover:bg-destructive-soft/70" : "bg-warning-soft hover:bg-warning-soft/70")}>
                    {reminder.kind === "deadline"
                      ? <CalendarClock aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0", reminder.tone === "bad" ? "text-destructive" : "text-warning")} />
                      : <TrendingUp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />}
                    <FinancialData as="span" className="min-w-0"><span className="font-medium">{reminder.title}</span> · {reminder.body}</FinancialData>
                  </Link>
                )}
                {summary.review > 0 && (
                  <Link href="/vertraege" className="flex items-center gap-2 rounded-xl bg-info-soft px-3 py-2 text-xs transition-colors hover:bg-info-soft/70 focus-visible:outline-2 focus-visible:outline-ring">
                    <Sparkles aria-hidden="true" className="size-3.5 shrink-0 text-info" />
                    <span><span className="font-medium">{summary.review} neu erkannt</span> – kurz prüfen</span>
                  </Link>
                )}
              </div>
            )}
            {upcoming.length > 0 && (
              <div>
                <p className="mb-1 text-2xs font-medium text-muted-foreground">Nächste Abbuchungen</p>
                <FinancialData as="ul" className="divide-y divide-border/60">
                  {upcoming.map(({ contract, date, amount }) => (
                    <li key={`${contract.id}:${date}`} className="flex items-center gap-3 py-2 text-sm">
                      <span className="w-11 shrink-0 text-xs tabular-nums text-muted-foreground">{dayMonth(date)}</span>
                      <span className="min-w-0 flex-1 truncate">{contract.name}</span>
                      <span className="shrink-0 font-medium tabular-nums">{currency(-amount)}</span>
                    </li>
                  ))}
                </FinancialData>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
