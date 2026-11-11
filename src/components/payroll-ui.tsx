import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { payrollStatusLabel, type PayrollMonthStatus } from "@/components/payroll-presentation";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";

// Status is never color alone: every state has its own shape and a text label next to it (or for screen readers).
const statusDot: Record<PayrollMonthStatus, string> = {
  actual: "rounded-full bg-success",
  review: "rounded-full bg-warning ring-2 ring-warning/30",
  forecast: "rounded-full border-[1.5px] border-info",
  missing: "rotate-45 rounded-[1px] bg-warning",
  open: "rounded-full border border-dashed border-muted-foreground",
};
const statusBadge = {
  actual: "success",
  review: "warning",
  forecast: "info",
  missing: "warning",
  open: "secondary",
} as const;

export function PayrollStatusDot({ status, className }: { status: PayrollMonthStatus; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0", statusDot[status], className)} />;
}

export function PayrollStatusBadge({ status, className }: { status: PayrollMonthStatus; className?: string }) {
  return (
    <Badge variant={statusBadge[status]} className={cn("gap-1.5", className)}>
      <PayrollStatusDot status={status} className="size-1.5" />
      {payrollStatusLabel[status]}
    </Badge>
  );
}

/** Short visible label with the full wording for screen readers (and stable test hooks). */
export function PayrollLabel({ short, full }: { short: ReactNode; full: string }) {
  return (
    <>
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{full}</span>
    </>
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

// Compact ⓘ that keeps the row height but still offers a 44 px hit area.
export const payrollInfoTip = "relative -my-1.5 size-6 after:absolute after:-inset-2.5 after:content-['']";

export function PayrollCardHeading({
  id,
  title,
  info,
  subtitle,
  action,
}: {
  id?: string;
  title: string;
  info: ReactNode;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-0.5">
          <h3 id={id} className="text-sm leading-snug font-semibold tracking-tight">
            {title}
          </h3>
          <InfoTip label={title} className={payrollInfoTip}>
            {info}
          </InfoTip>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
