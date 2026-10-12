"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { useSecurityMode } from "@/components/security-mode-provider";

type FinancialDataProps = HTMLAttributes<HTMLElement> & {
  as?: "div" | "span" | "p" | "section" | "tbody" | "dl" | "ul";
  workspace?: boolean;
};

export function FinancialData({ as: Tag = "div", workspace = false, ...props }: FinancialDataProps) {
  const { locked } = useSecurityMode();
  return (
    <Tag
      {...props}
      data-financial-data=""
      data-financial-workspace={workspace ? "" : undefined}
      aria-hidden={locked || undefined}
      inert={locked || undefined}
    />
  );
}

export function FinancialWorkspace({ title, children }: { title: string; children: ReactNode }) {
  const { locked } = useSecurityMode();
  return <>
    {locked && <h1 className="sr-only">{title}</h1>}
    <FinancialData workspace>{children}</FinancialData>
  </>;
}
