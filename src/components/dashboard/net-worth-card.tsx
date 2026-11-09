"use client";

import Link from "next/link";
import { ArrowRight, Landmark, TrendingDown, TrendingUp } from "lucide-react";
import dynamic from "next/dynamic";
import { FinancialData } from "@/components/financial-data";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { netWorthPartIcon, netWorthPartLabel, visibleNetWorthParts } from "@/components/net-worth-parts";
import type { NetWorthPoint } from "@/lib/net-worth";
import { currency, monthLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const NetWorthSparkline = dynamic(() => import("@/components/charts/net-worth-sparkline"), {
  ssr: false,
  loading: () => <Skeleton className="size-full" />,
});

export function NetWorthCard({ points, className }: { points: readonly NetWorthPoint[]; className?: string }) {
  const latest = points.at(-1);
  const first = points[0];
  const change = latest && first ? latest.total - first.total : 0;
  const series = points.map((point) => ({ label: monthLabel(point.month, true), total: point.total }));
  const parts = latest ? visibleNetWorthParts(latest.parts) : [];
  return (
    <Card as="section" aria-labelledby="overview-net-worth-title" className={className}>
      <CardHeader>
        <CardTitle id="overview-net-worth-title">Nettovermögen</CardTitle>
        <CardAction>
          <Link href="/sparen" className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium text-primary transition-colors hover:bg-accent-muted focus-visible:outline-2 focus-visible:outline-ring">
            Sparen<ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </CardAction>
      </CardHeader>
      {latest ? (
        <>
          <CardContent className="pt-3 pb-0">
            <FinancialData className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className={cn("amount text-3xl", latest.total < 0 && "text-destructive")}>{currency(latest.total)}</p>
              {points.length > 1 && (
                <Badge variant={change >= 0 ? "success" : "destructive"}>
                  {change >= 0 ? <TrendingUp aria-hidden="true" /> : <TrendingDown aria-hidden="true" />}
                  {change >= 0 ? "+" : ""}{currency(change)} seit {monthLabel(first.month, true)}
                </Badge>
              )}
            </FinancialData>
            {points.length > 1 && (
              <FinancialData
                className="-mx-1 mt-4 h-24"
                role="img"
                aria-label={`Nettovermögen von ${currency(first.total)} (${monthLabel(first.month)}) auf ${currency(latest.total)} (${monthLabel(latest.month)})`}
              >
                <NetWorthSparkline data={series} />
              </FinancialData>
            )}
            {parts.length > 0 && (
              <>
                <h3 className="mt-5 text-xs font-medium text-muted-foreground">Konten</h3>
                <FinancialData as="ul" className="mt-1 divide-y divide-border/60">
                  {parts.map(([key, value]) => {
                    const Icon = netWorthPartIcon(key);
                    return (
                      <li key={key} className="flex min-h-11 items-center gap-3 py-1.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <Icon aria-hidden="true" className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{netWorthPartLabel(key)}</span>
                        <span className={cn("shrink-0 text-sm font-medium tabular-nums", value < 0 && "text-destructive")}>{currency(value)}</span>
                      </li>
                    );
                  })}
                </FinancialData>
              </>
            )}
          </CardContent>
          <CardFooter className="mt-3 text-2xs text-muted-foreground">
            Nur belegte Kontostände; unbekannte Salden zählen nicht als 0.
          </CardFooter>
        </>
      ) : (
        <CardContent className="pt-3">
          <EmptyState icon={Landmark} title="Noch keine Kontostände" className="min-h-40">
            Kontoauszüge importieren oder Stände unter Sparen erfassen.
          </EmptyState>
        </CardContent>
      )}
    </Card>
  );
}
