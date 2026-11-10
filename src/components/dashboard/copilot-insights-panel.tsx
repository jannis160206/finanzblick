"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  CalendarClock,
  CopyX,
  Gauge,
  ListChecks,
  MessageSquareText,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { useDashboardExtras } from "@/components/dashboard/use-dashboard-extras";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { askAssistant } from "@/lib/assistant-bus";
import { dismissInsight, type CopilotInsight, type CopilotInsightKind } from "@/lib/copilot-insights";
import { currency } from "@/lib/format";
import { cn } from "@/lib/utils";

const kindIcon: Record<CopilotInsightKind, LucideIcon> = {
  forecast: TrendingDown,
  budget: Gauge,
  deadline: CalendarClock,
  goal: Target,
  price: TrendingUp,
  duplicate: CopyX,
  unusual: Activity,
  unclear: ListChecks,
};
const severityChip = {
  high: "bg-destructive-soft text-destructive",
  medium: "bg-warning-soft text-warning",
  low: "bg-info-soft text-info",
} as const;
const COLLAPSED = 3;

export function CopilotInsightsPanel({ className }: { className?: string }) {
  const { update, storageError, ready } = useFinance();
  const insights = useDashboardExtras()?.copilot;
  const [expanded, setExpanded] = useState(false);
  if (!insights?.length) return null;
  const shown = expanded ? insights : insights.slice(0, COLLAPSED);
  const disabled = !ready || !!storageError;

  function dismiss(insight: CopilotInsight) {
    if (disabled) return;
    update((current) => ({ ...current, dismissedInsights: dismissInsight(current.dismissedInsights, insight.id) }));
    toast.success("Hinweis ausgeblendet", {
      action: {
        label: "Rückgängig",
        onClick: () => update((current) => ({ ...current, dismissedInsights: (current.dismissedInsights ?? []).filter((entry) => entry.id !== insight.id) })),
      },
    });
  }

  return (
    <Card as="section" aria-labelledby="overview-insights-title" className={className}>
      <CardHeader>
        <CardTitle id="overview-insights-title" className="flex items-center gap-2">
          <Sparkles aria-hidden="true" className="size-4 text-primary" />Hinweise
        </CardTitle>
        <CardDescription>Aus deinen Zahlen erkannt – wegklicken oder im Chat nachfragen.</CardDescription>
      </CardHeader>
      <CardContent className="pt-3 pb-3 sm:pb-4">
        <ul className="-mx-2 divide-y divide-border/60">
          {shown.map((insight) => {
            const Icon = kindIcon[insight.kind];
            return (
              <li key={insight.id} className="flex items-start gap-3 px-2 py-3">
                <span aria-hidden="true" className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg", severityChip[insight.severity])}>
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={insight.href} className="min-w-0 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                      {insight.title}
                    </Link>
                    {insight.amount !== undefined && <FinancialData as="span" className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">{currency(insight.amount)}</FinancialData>}
                  </div>
                  <FinancialData as="p" className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{insight.text}</FinancialData>
                  <div className="mt-1.5 -ml-2 flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" className="h-8 px-2 text-xs pointer-coarse:h-11"
                      onClick={() => askAssistant({ text: insight.prompt, send: true, insightId: insight.id })}>
                      <MessageSquareText aria-hidden="true" className="size-3.5" />Mehr dazu
                    </Button>
                  </div>
                </div>
                <Button size="icon" variant="ghost" className="size-9 shrink-0 text-muted-foreground pointer-coarse:size-11" disabled={disabled}
                  aria-label={`Hinweis ausblenden: ${insight.title}`} title="Wegklicken" onClick={() => dismiss(insight)}>
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </li>
            );
          })}
        </ul>
        {insights.length > COLLAPSED && (
          <Button variant="ghost" size="sm" className="mt-1 h-9 text-xs" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Weniger anzeigen" : `Alle ${insights.length} Hinweise anzeigen`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
