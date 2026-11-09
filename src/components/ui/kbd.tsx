import * as React from "react";
import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-card px-1.5 font-sans text-2xs font-medium text-muted-foreground shadow-[0_1px_0_0_var(--border)] select-none",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
