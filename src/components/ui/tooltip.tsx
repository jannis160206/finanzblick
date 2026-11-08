"use client";

import type { ReactElement, ReactNode } from "react";
import { Tooltip as Primitive } from "radix-ui";

export function Tooltip({
  label,
  children,
  className = "max-w-64",
}: {
  label: ReactNode;
  children: ReactElement;
  className?: string;
}) {
  return (
    <Primitive.Provider delayDuration={350}>
      <Primitive.Root>
        <Primitive.Trigger asChild>{children}</Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content
            sideOffset={6}
            collisionPadding={12}
            className={`z-[70] ${className} rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm`}
          >
            {label}
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  );
}
