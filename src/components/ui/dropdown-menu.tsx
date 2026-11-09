"use client";

import { useState, type ComponentProps } from "react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { useSecurityMode } from "@/components/security-mode-provider";
import { useNativeSelectBoundary } from "@/components/ui/use-native-select-boundary";

export function DropdownMenu({
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: ComponentProps<typeof MenuPrimitive.Root>) {
  const { locked } = useSecurityMode();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  return <MenuPrimitive.Root
    {...props}
    open={!locked && (open ?? uncontrolledOpen)}
    onOpenChange={(next) => {
      if (locked) return;
      if (open === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    }}
  />;
}
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export function DropdownMenuContent({ className, ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  useNativeSelectBoundary();
  const { locked } = useSecurityMode();
  if (locked) return null;
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        data-slot="dropdown-menu"
        sideOffset={6}
        collisionPadding={16}
        align="end"
        className={cn("z-[60] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] min-w-48 max-w-[calc(100dvw-2rem)] overflow-y-auto overscroll-contain rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-overlay outline-none duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0", className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof MenuPrimitive.Item>) {
  return <MenuPrimitive.Item className={cn("flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4", className)} {...props} />;
}

export function DropdownMenuSeparator() {
  return <MenuPrimitive.Separator className="my-1.5 border-t" />;
}
