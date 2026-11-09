import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const indicatorVariants = cva(
  "h-full rounded-full transition-[width] duration-700 ease-soft motion-reduce:transition-none",
  {
    variants: {
      tone: {
        default: "bg-primary",
        success: "bg-success",
        warning: "bg-warning",
        destructive: "bg-destructive",
        info: "bg-info",
        muted: "bg-muted-foreground/50",
      },
    },
    defaultVariants: { tone: "default" },
  },
);

type ProgressProps = Omit<React.ComponentProps<"div">, "children"> &
  VariantProps<typeof indicatorVariants> & {
    value: number;
    max?: number;
    label: string;
    valueText?: string;
  };

function Progress({ value, max = 100, label, valueText, tone, className, ...props }: ProgressProps) {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), safeMax);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={Math.round(clamped * 100) / 100}
      aria-valuetext={valueText}
      data-slot="progress"
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={indicatorVariants({ tone })}
        style={{ width: `${(clamped / safeMax) * 100}%` }}
      />
    </div>
  );
}

export { Progress };
