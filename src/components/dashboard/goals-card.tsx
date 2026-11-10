"use client";

import Link from "next/link";
import { ArrowRight, CalendarDays, Check, Plus, Target } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { AnimatedProgress } from "@/components/motion/animated-progress";
import { goalBalanceStatus, savingsGoals } from "@/lib/goals";
import { currency, dateLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

export function GoalsCard({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { state, dashboard } = useFinance();
  const goals = [...savingsGoals(state)]
    .sort((a, b) => Number(!!a.completedAt) - Number(!!b.completedAt) || a.date.localeCompare(b.date))
    .slice(0, 4);
  return (
    <Card as="section" aria-labelledby="overview-goals-title" className={className}>
      <CardHeader>
        <CardTitle id="overview-goals-title">Sparziele</CardTitle>
        <CardAction>
          <Link href="/sparen" className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-primary transition-colors hover:bg-accent-muted focus-visible:outline-2 focus-visible:outline-ring">
            Alle<ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="pt-3">
        {goals.length ? (
          <FinancialData as="ul" className={cn("grid gap-x-8 gap-y-6 sm:grid-cols-2", !compact && "xl:grid-cols-4")}>
            {goals.map((goal, index) => {
              const basis = goalBalanceStatus(state, goal, dashboard.actual);
              const balance = basis.amount;
              const done = !!goal.completedAt || (balance !== null && balance >= goal.target);
              return (
                <li key={goal.id} className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", done ? "bg-success-soft text-success" : "bg-accent-muted text-primary")}>
                      {done ? <Check aria-hidden="true" className="size-4" /> : <Target aria-hidden="true" className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{goal.name}</span>
                      <span className="flex items-center gap-1 text-2xs text-muted-foreground">
                        <CalendarDays aria-hidden="true" className="size-3" />bis {dateLabel(goal.date)}
                      </span>
                    </span>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {balance === null
                      ? basis.status === "conflict" ? "Zuordnung offen" : "Kontostand unbekannt"
                      : <><span className="amount text-base text-foreground">{currency(balance)}</span> von {currency(goal.target)}</>}
                  </p>
                  <AnimatedProgress
                    value={balance ?? 0}
                    max={goal.target}
                    label={`${goal.name} Fortschritt`}
                    valueText={balance === null ? "unbekannt" : `${currency(balance)} von ${currency(goal.target)}`}
                    tone={balance === null ? "muted" : done ? "success" : "default"}
                    delay={0.08 * (index + 1)}
                    className="mt-2 h-1.5"
                  />
                </li>
              );
            })}
          </FinancialData>
        ) : (
          <EmptyState icon={Target} title="Noch keine Sparziele" className="min-h-40">
            <p>Lege fest, wofür du bis wann sparen willst.</p>
            <Button asChild size="sm" variant="soft" className="mt-3">
              <Link href="/sparen#sparziele"><Plus aria-hidden="true" />Sparziel anlegen</Link>
            </Button>
          </EmptyState>
        )}
      </CardContent>
    </Card>
  );
}
