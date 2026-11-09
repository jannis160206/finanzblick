"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

const DialogFooterButtonContext = React.createContext(false);

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform,translate,scale] duration-150 ease-out hover:-translate-y-px hover:shadow-raised active:scale-[0.98] active:translate-y-0 motion-reduce:translate-none! motion-reduce:scale-100! motion-reduce:transition-none outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:max-h-[1lh] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "rounded-full bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-border bg-card shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        soft: "bg-accent-muted text-primary hover:bg-primary/15",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 px-2 text-xs has-[>svg]:px-1.5",
        sm: "h-9 px-3 has-[>svg]:px-2.5",
        lg: "h-11 px-6 has-[>svg]:px-4",
        icon: "size-10",
        "icon-xs": "size-6",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const inFooter = React.useContext(DialogFooterButtonContext);
  const footerAction = inFooter && !size?.startsWith("icon");
  const effectiveVariant = footerAction && variant === "outline" ? "ghost" : variant;
  const primary = effectiveVariant === "default" || effectiveVariant === "destructive";
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={effectiveVariant}
      data-size={size}
      className={cn(buttonVariants({ variant: effectiveVariant, size, className }),
        footerAction && "w-full sm:w-auto",
        footerAction && (primary ? "order-2 rounded-full" : "order-1"))}
      {...props}
    />
  );
}

export { Button, buttonVariants, DialogFooterButtonContext };
