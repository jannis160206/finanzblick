"use client";

import {
  Bell,
  Gift,
  Ghost,
  Landmark,
  Skull,
  Snowflake,
  Star,
  TreePine,
} from "lucide-react";
import type { ReactNode } from "react";
import { useSeasonalTheme } from "@/components/seasonal-theme-provider";

type Slot = "logo" | "navigation" | "pockets" | "overview" | "expense";

export function SeasonalIcon({
  slot,
  fallback,
  className = "size-4",
}: {
  slot: Slot;
  fallback?: ReactNode;
  className?: string;
}) {
  const { theme } = useSeasonalTheme();
  if (theme === "default") return fallback ?? null;
  const shared = {
    className,
    "aria-hidden": true as const,
    "data-seasonal-icon": `${theme}-${slot}`,
    strokeWidth: 1.75,
  };
  if (theme === "christmas") {
    const Icon = {
      logo: Star,
      navigation: TreePine,
      pockets: Gift,
      overview: Bell,
      expense: Snowflake,
    }[slot];
    return <Icon {...shared} />;
  }
  if (theme === "newyear") return <Star {...shared} />;
  if (slot === "navigation") return <Ghost {...shared} />;
  if (slot === "expense") return <Skull {...shared} />;
  return (
    <svg
      {...shared}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      {slot === "logo" ? (
        <>
          <path d="M12 7c-7-5-12 2-9 9 2 5 6 5 9 4 3 1 7 1 9-4 3-7-2-14-9-9ZM12 7V4l3-2M12 7c-4 3-4 10 0 13M12 7c4 3 4 10 0 13" />
        </>
      ) : slot === "pockets" ? (
        <path d="m9 7 2 2h2l2-2 1 4 6-6c0 7-2 9-5 9l-2 4-3-2-3 2-2-4c-3 0-5-2-5-9l6 6 1-4Z" />
      ) : (
        <>
          <path d="M12 2v5M8 12 4 9l-2-4M8 14H3l-2 3M8 16l-3 3v3M16 12l4-3 2-4M16 14h5l2 3M16 16l3 3v3" />
          <ellipse cx="12" cy="15" rx="4" ry="5" />
          <circle cx="12" cy="9" r="2" />
        </>
      )}
    </svg>
  );
}

export function FinanzblickMark() {
  const { theme } = useSeasonalTheme();
  return (
    <span
      className="brand-mark relative rounded-lg bg-primary p-2 text-primary-foreground"
      data-logo-mark="finanzblick"
    >
      <Landmark className="size-4" aria-hidden="true" />
      {theme !== "default" && (
        <span className="logo-season-detail" aria-hidden="true">
          <SeasonalIcon slot="logo" className="size-3" />
        </span>
      )}
    </span>
  );
}
