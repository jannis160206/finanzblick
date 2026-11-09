"use client";

import * as m from "motion/react-m";
import { cn } from "@/lib/utils";

export type ProgressTone = "default" | "success" | "warning" | "destructive" | "muted";

const toneClass: Record<ProgressTone, string> = {
  default: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

export function AnimatedProgress({
  value,
  max = 100,
  label,
  valueText,
  tone = "default",
  delay = 0,
  className,
}: {
  value: number;
  max?: number;
  label: string;
  valueText?: string;
  tone?: ProgressTone;
  delay?: number;
  className?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), safeMax) / safeMax;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={valueText}
      data-slot="progress"
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <m.div
        data-slot="progress-indicator"
        className={cn("absolute inset-0 origin-left rounded-full", toneClass[tone])}
        initial={{ scaleX: 0 }}
        animate={{ scaleX: ratio }}
        transition={{ type: "spring", stiffness: 140, damping: 24, mass: 0.9, delay }}
      />
    </div>
  );
}
