"use client";

import * as React from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useSeasonalTheme } from "@/components/seasonal-theme-provider";

// Next.js ships React's <ViewTransition>; plain React builds (tests) do not.
const Boundary: typeof React.ViewTransition | undefined = React.ViewTransition;

// Route changes crossfade through the browser's View Transitions API (see .page-fade in globals.css).
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { motionReduced } = useSeasonalTheme();
  if (!Boundary) return <>{children}</>;
  // Keep the boundary mounted either way so toggling motion never remounts the page.
  const animation = motionReduced || pathname.startsWith("/umsaetze") ? "none" : "page-fade";
  return (
    <Boundary key={pathname} enter={animation} exit={animation} default="none">
      {children}
    </Boundary>
  );
}
