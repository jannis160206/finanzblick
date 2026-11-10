import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { cn } from "@/lib/utils";

export function PayrollFigures({
  figures,
  className,
}: {
  figures: { label: string; value: string }[];
  className?: string;
}) {
  return (
    <FinancialData as="dl" className={cn("divide-y divide-border/60", className)}>
      {figures.map(({ label, value }, index) => {
        const open = value === "Noch offen";
        return (
          <div key={label} className="flex min-h-11 min-w-0 items-center justify-between gap-4 py-2">
            <dt className="min-w-0 text-sm leading-snug text-muted-foreground">
              {label}
            </dt>
            <dd className={cn("max-w-[55%] shrink-0 break-words text-right tabular-nums",
              open ? "text-xs text-muted-foreground"
                : index === 0 ? "amount text-lg" : "text-sm font-semibold")}>
              {value}
            </dd>
          </div>
        );
      })}
    </FinancialData>
  );
}

export function PayrollDisclosure({
  title,
  label,
  children,
  inset = false,
}: {
  title: string;
  label: string;
  children: ReactNode;
  inset?: boolean;
}) {
  return (
    <details
      aria-label={label}
      className={cn(
        "min-w-0",
        inset ? "mt-4 border-t" : "panel",
      )}
    >
      <summary
        className={cn(
          "flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-xl text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden",
          !inset && "p-5",
        )}
      >
        {title}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground [details[open]>summary>&]:rotate-180"
        />
      </summary>
      <div className={cn("min-w-0", inset ? "pb-1 pt-2" : "border-t p-5")}>
        {children}
      </div>
    </details>
  );
}
