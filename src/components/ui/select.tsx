"use client";

import { useState, type ComponentProps } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { useSecurityMode } from "@/components/security-mode-provider";
import { cn } from "@/lib/utils";

/** A select whose options can show more than text (e.g. a status dot); it stays closed while the app is locked. */
export function Select({ open, defaultOpen = false, onOpenChange, ...props }: ComponentProps<typeof SelectPrimitive.Root>) {
  const { locked } = useSecurityMode();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  return (
    <SelectPrimitive.Root
      {...props}
      open={!locked && (open ?? uncontrolledOpen)}
      onOpenChange={(next) => {
        if (locked) return;
        if (open === undefined) setUncontrolledOpen(next);
        onOpenChange?.(next);
      }}
    />
  );
}

export const SelectValue = SelectPrimitive.Value;
export const SelectItemText = SelectPrimitive.ItemText;

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn("select-input inline-flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50", className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  const { locked } = useSecurityMode();
  if (locked) return null;
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={6}
        collisionPadding={16}
        className={cn("z-[60] max-h-[min(32rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-overlay duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0", className)}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1.5">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn("relative flex min-h-10 cursor-pointer select-none items-center gap-2 rounded-lg py-2 pr-8 pl-3 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:cursor-default data-[disabled]:text-muted-foreground", className)}
      {...props}
    >
      {children}
      <SelectPrimitive.ItemIndicator className="absolute right-2.5 inline-flex">
        <Check aria-hidden="true" className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
