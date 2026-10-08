import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function PayrollFigures({
  figures,
  className,
}: {
  figures: { label: string; value: string }[];
  className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", className)}>
      {figures.map(({ label, value }) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs leading-relaxed text-muted-foreground">
            {label}
          </dt>
          <dd className="mt-1 break-words text-xl font-semibold tracking-tight tabular-nums">
            {value}
          </dd>
        </div>
      ))}
    </dl>
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
        "group min-w-0",
        inset ? "mt-4 border-t" : "panel rounded-2xl shadow-sm",
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
          className="size-4 shrink-0 text-muted-foreground group-open:rotate-180"
        />
      </summary>
      <div className={cn("min-w-0", inset ? "pb-1 pt-2" : "border-t p-5")}>
        {children}
      </div>
    </details>
  );
}
