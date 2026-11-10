"use client";

import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip, chartAxisProps, chartCursor, chartGridProps } from "@/components/charts/chart-theme";
import { shortCurrency } from "@/lib/format";

export default function MonthForecastChart({ data, floor }: { data: readonly { label: string; balance: number }[]; floor: number }) {
  const negative = data.some((point) => point.balance < floor);
  const tone = negative ? "var(--destructive)" : "var(--chart-1)";
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={[...data]} margin={{ left: -4, right: 8, top: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="month-forecast-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity={0.24} />
            <stop offset="100%" stopColor={tone} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...chartGridProps} />
        <XAxis dataKey="label" {...chartAxisProps} minTickGap={28} />
        <YAxis tickFormatter={shortCurrency} {...chartAxisProps} width={72} domain={[(min: number) => Math.min(min, floor), "auto"]} />
        <Tooltip content={<ChartTooltip />} cursor={chartCursor} />
        <ReferenceLine y={floor} stroke="var(--muted-foreground)" strokeOpacity={0.6} strokeDasharray="4 4" />
        <Area type="stepAfter" dataKey="balance" name="Kontostand" stroke={tone} fill="url(#month-forecast-fill)" strokeWidth={2} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
