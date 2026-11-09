import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { cn } from "@/lib/utils";

export function Stat({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  size = "default",
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "positive" | "negative" | "muted";
  size?: "default" | "lg";
  className?: string;
}) {
  return (
    <div data-slot="stat" className={cn("flex min-w-0 items-start gap-3", className)}>
      {Icon && (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon aria-hidden="true" className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <FinancialData
          as="p"
          className={cn(
            "amount mt-0.5 break-words",
            size === "lg" ? "text-display" : "text-xl",
            tone === "positive" && "text-money-in",
            tone === "negative" && "text-destructive",
            tone === "muted" && "text-muted-foreground",
          )}
        >
          {value}
        </FinancialData>
        {hint && <FinancialData as="p" className="mt-0.5 text-2xs text-muted-foreground">{hint}</FinancialData>}
      </div>
    </div>
  );
}
