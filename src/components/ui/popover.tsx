"use client";

import { useState, type ComponentProps } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { useSecurityMode } from "@/components/security-mode-provider";
import { useNativeSelectBoundary } from "@/components/ui/use-native-select-boundary";

export function Popover({
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Root>) {
  const { locked } = useSecurityMode();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  return <PopoverPrimitive.Root
    {...props}
    open={!locked && (open ?? uncontrolledOpen)}
    onOpenChange={(next) => {
      if (locked) return;
      if (open === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    }}
  />;
}
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  useNativeSelectBoundary();
  const { locked } = useSecurityMode();
  if (locked) return null;
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={16}
        className={cn(
          "z-[60] max-h-[min(24rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100dvw-2rem)] overflow-y-auto overscroll-contain rounded-xl border bg-popover p-4 text-popover-foreground shadow-[0_12px_40px_-12px_rgb(0_0_0/0.3)] outline-none duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
