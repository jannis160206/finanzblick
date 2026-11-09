import * as React from "react";
import { cn } from "@/lib/utils";

type CardProps = React.ComponentProps<"div"> & {
  as?: "div" | "section" | "article";
  interactive?: boolean;
};

function Card({ as: Tag = "div", interactive = false, className, ...props }: CardProps) {
  return (
    <Tag
      data-slot="card"
      className={cn(
        "flex min-w-0 flex-col rounded-2xl border border-border/80 bg-card text-card-foreground shadow-card",
        interactive && "transition-[box-shadow,border-color,translate] duration-200 ease-soft hover:-translate-y-0.5 hover:border-border hover:shadow-raised motion-reduce:hover:translate-none",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "grid auto-rows-min items-start gap-1 px-5 pt-5 has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto] sm:px-6 sm:pt-6",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="card-title"
      className={cn("text-sm leading-snug font-semibold tracking-tight", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-xs leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-5 py-5 sm:px-6", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("mt-auto flex items-center gap-2 border-t border-border/70 px-5 py-3.5 sm:px-6", className)}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
