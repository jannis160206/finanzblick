"use client";

import type { ReactElement } from "react";
import { Tooltip as Primitive } from "radix-ui";

export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}) {
  return (
    <Primitive.Provider delayDuration={350}>
      <Primitive.Root>
        <Primitive.Trigger asChild>{children}</Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content
            sideOffset={6}
            collisionPadding={12}
            className="z-[70] max-w-64 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm"
          >
            {label}
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  );
}
