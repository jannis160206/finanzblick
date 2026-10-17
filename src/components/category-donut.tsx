"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartDataTable } from "@/components/chart-data-table";
import { FinancialData } from "@/components/financial-data";
import { currency } from "@/lib/format";
import { groupSpending, shareLabel } from "@/lib/spending-groups";

const sliceColors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const restColor = "var(--muted-foreground)";
const tooltipCurrency = (value: unknown) => currency(Number(value));

export function CategoryDonut({
  spending,
  tooltipStyle,
  limit = 5,
}: {
  spending: readonly { name: string; value: number }[];
  tooltipStyle: React.CSSProperties;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = groupSpending(spending, Math.min(limit, sliceColors.length));
  const slices = [
    ...groups.top.map((slice, index) => ({ ...slice, color: sliceColors[index] })),
    ...(groups.rest.length ? [{ name: "Sonstige", value: groups.restValue, share: groups.restShare, color: restColor }] : []),
  ];
  const tableRows = [...groups.top, ...groups.rest].map((slice) => ({
    key: slice.name,
    cells: [slice.name, currency(slice.value), shareLabel(slice.share)],
  }));
  return (
    <>
      <FinancialData className="flex min-h-64 flex-col items-center gap-3 sm:flex-row">
        <div className="h-52 w-full sm:w-1/2" role="img" aria-label={`Aktuelle Ausgaben nach Kategorie: ${slices.map((slice) => `${slice.name} ${shareLabel(slice.share)}`).join(", ")}`}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={slices} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="88%" paddingAngle={3} stroke="none" isAnimationActive={false}>
                {slices.map((slice) => <Cell key={slice.name} fill={slice.color} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={tooltipCurrency} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="w-full space-y-3 sm:w-1/2" aria-label="Kategorien mit Anteil">
          {slices.map((slice) => (
            <li key={slice.name} className="flex items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span className="size-2 shrink-0 rounded-full" style={{ background: slice.color }} aria-hidden="true" />
                <span className="break-words">{slice.name}</span>
              </span>
              <span className="shrink-0 text-right tabular-nums">
                <span className="font-medium">{currency(slice.value)}</span>
                <span className="ml-2 text-muted-foreground">{shareLabel(slice.share)}</span>
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
      <ChartDataTable caption="Ausgaben nach Kategorie" columns={["Kategorie", "Betrag", "Anteil"]} rows={tableRows} />
    </>
  );
}
