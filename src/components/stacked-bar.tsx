"use client";

import { FinancialData } from "@/components/financial-data";
import { currency } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Stacked horizontal bar with a legend. */
export function StackedBar({ parts, label, base }: {
  parts: { key: string; value: number; tone: string }[];
  label: string;
  base?: number;
}) {
  const visible = parts.filter((part) => part.value > 0);
  if (!visible.length) return null;
  const total = Math.max(base ?? 0, visible.reduce((sum, part) => sum + part.value, 0), 1);
  return (
    <FinancialData role="group" className="space-y-2.5 border-t border-border/60 px-5 py-4 sm:px-6" aria-label={label}>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {visible.map((part) => (
          <div key={part.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", part.tone)} style={{ width: `${(part.value / total) * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {visible.map((part) => (
          <li key={part.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-2 rounded-full", part.tone)} />
            {part.key} <span className="font-medium text-foreground tabular-nums">{currency(part.value)}</span>
          </li>
        ))}
      </ul>
    </FinancialData>
  );
}
