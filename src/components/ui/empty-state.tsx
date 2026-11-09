import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

function EmptyState({
  icon: Icon,
  title,
  className,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex min-h-32 flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-sunken/60 p-6 text-center",
        className,
      )}
    >
      {Icon && (
        <span className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-card text-muted-foreground shadow-xs">
          <Icon aria-hidden="true" className="size-5" />
        </span>
      )}
      <p className="text-sm font-semibold">{title}</p>
      {children && <div className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}

export { EmptyState };
