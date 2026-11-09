"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type SegmentOption<T extends string> = {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
};

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "default",
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  label: string;
  size?: "default" | "sm";
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="segmented-control"
      className={cn("inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl bg-muted p-1", className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-150 ease-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11",
              size === "sm" ? "min-h-8 px-2.5 text-xs" : "min-h-9 px-3 text-sm",
              active
                ? "bg-card text-foreground shadow-card"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon && <option.icon aria-hidden="true" className="size-4" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
