"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { FinancialData } from "@/components/financial-data";
import { currency } from "@/lib/format";
import { groupSpending, shareLabel } from "@/lib/spending-groups";
import { ChartTooltip } from "@/components/charts/chart-theme";

const sliceColors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const restColor = "var(--muted-foreground)";

export function CategoryDonut({
  spending,
  limit = 5,
}: {
  spending: readonly { name: string; value: number }[];
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupSpending(spending, Math.min(limit, sliceColors.length));
  const slices = [
    ...groups.top.map((slice, index) => ({ ...slice, color: sliceColors[index] })),
    ...(groups.rest.length ? [{ name: "Sonstige", value: groups.restValue, share: groups.restShare, color: restColor }] : []),
  ];
  return (
    <>
      <FinancialData className="flex min-h-64 flex-col items-center gap-6 sm:flex-row">
        <div className="relative h-56 w-full sm:w-1/2" role="img" aria-label={`Aktuelle Ausgaben nach Kategorie: ${slices.map((slice) => `${slice.name} ${shareLabel(slice.share)}`).join(", ")}`}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={slices} dataKey="value" nameKey="name" innerRadius="68%" outerRadius="92%" paddingAngle={2} cornerRadius={6} stroke="none" isAnimationActive={false}>
                {slices.map((slice) => <Cell key={slice.name} fill={slice.color} />)}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xs text-muted-foreground">Gesamt</span>
            <span className="amount text-lg">{currency(groups.total)}</span>
          </div>
        </div>
        <ul className="w-full space-y-3 sm:w-1/2" aria-label="Kategorien mit Anteil">
          {slices.map((slice) => (
            <li key={slice.name} className="text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: slice.color }} aria-hidden="true" />
                  <span className="break-words text-foreground">{slice.name}</span>
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="font-medium">{currency(slice.value)}</span>
                  <span className="ml-2 inline-block w-10 text-muted-foreground">{shareLabel(slice.share)}</span>
                </span>
              </div>
              <span aria-hidden="true" className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full" style={{ width: `${Math.max(slice.share * 100, 1)}%`, background: slice.color }} />
              </span>
            </li>
          ))}
        </ul>
      </FinancialData>
      {groups.rest.length > 0 && (
        <FinancialData className="mt-2">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls="spending-rest"
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-xs text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {expanded ? "Sonstige ausblenden" : `Sonstige anzeigen (${groups.rest.length})`}
            <ChevronDown aria-hidden="true" className={`size-3.5 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
          </button>
          <ul id="spending-rest" hidden={!expanded} className="mt-1 space-y-2 border-l border-border/70 pl-3">
            {groups.rest.map((slice) => (
              <li key={slice.name} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 break-words text-muted-foreground">{slice.name}</span>
                <span className="shrink-0 tabular-nums"><span className="font-medium">{currency(slice.value)}</span><span className="ml-2 text-muted-foreground">{shareLabel(slice.share)}</span></span>
              </li>
            ))}
          </ul>
        </FinancialData>
      )}
    </>
  );
}
