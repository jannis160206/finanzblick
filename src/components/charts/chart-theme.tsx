"use client";

import type { TooltipContentProps } from "recharts";
import { FinancialData } from "@/components/financial-data";
import { currency } from "@/lib/format";

export const chartColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
] as const;

export const chartAxisTick = { fontSize: 11, fill: "var(--muted-foreground)" };

export const chartAxisProps = {
  tick: chartAxisTick,
  axisLine: false,
  tickLine: false,
} as const;

export const chartGridProps = {
  stroke: "var(--border)",
  strokeDasharray: "3 6",
  vertical: false,
} as const;

export const chartCursor = { stroke: "var(--muted-foreground)", strokeOpacity: 0.35, strokeDasharray: "4 4" };

type ChartTooltipProps = Partial<TooltipContentProps<number | string, string>> & {
  formatValue?: (value: number) => string;
};

export function ChartTooltip({ active, payload, label, formatValue = currency }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <FinancialData className="min-w-36 rounded-xl border border-border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-overlay">
      {label !== undefined && label !== "" && <p className="mb-1.5 font-medium">{label}</p>}
      <ul className="space-y-1">
        {payload.map((entry, index) => (
          <li key={`${entry.name ?? index}`} className="flex items-center justify-between gap-4">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ background: entry.color ?? (entry.payload as { color?: string } | undefined)?.color ?? "var(--chart-1)" }}
              />
              <span className="truncate">{entry.name}</span>
            </span>
            <span className="font-medium tabular-nums">{formatValue(Number(entry.value))}</span>
          </li>
        ))}
      </ul>
    </FinancialData>
  );
}
