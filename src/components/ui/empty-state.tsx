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
        "flex min-h-32 flex-col items-center justify-center rounded-2xl border border-dashed bg-muted/10 p-5 text-center",
        className,
      )}
    >
      {Icon && <Icon aria-hidden="true" className="mb-3 size-7 text-muted-foreground" />}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

export { EmptyState };
