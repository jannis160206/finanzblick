"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartTooltip, chartAxisProps, chartCursor, chartGridProps } from "@/components/charts/chart-theme";
import { shortCurrency } from "@/lib/format";

export default function NetWorthHistoryChart({ data }: { data: readonly { label: string; total: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={[...data]} margin={{ left: -15, right: 8, top: 10 }}>
        <defs>
          <linearGradient id="net-worth-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...chartGridProps} />
        <XAxis dataKey="label" {...chartAxisProps} minTickGap={25} />
        <YAxis tickFormatter={shortCurrency} {...chartAxisProps} width={64} />
        <Tooltip content={<ChartTooltip />} cursor={chartCursor} />
        <Area type="monotone" dataKey="total" name="Nettovermögen" stroke="var(--chart-1)" fill="url(#net-worth-fill)" strokeWidth={2} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
