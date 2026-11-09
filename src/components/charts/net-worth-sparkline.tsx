"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartTooltip, chartCursor } from "@/components/charts/chart-theme";

export default function NetWorthSparkline({ data }: { data: readonly { label: string; total: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={[...data]} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
        <defs>
          <linearGradient id="overview-net-worth-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <Tooltip content={<ChartTooltip />} cursor={chartCursor} />
        <Area type="monotone" dataKey="total" name="Nettovermögen" stroke="var(--chart-1)" strokeWidth={2} fill="url(#overview-net-worth-fill)" isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
