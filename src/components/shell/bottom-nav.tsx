"use client";

import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { Ellipsis } from "lucide-react";
import { SeasonalIcon } from "@/components/seasonal-icons";
import { FinancialData } from "@/components/financial-data";
import { navigation, isActivePath } from "@/components/shell/navigation";
import { cn } from "@/lib/utils";

const itemClass =
  "group flex h-full min-w-0 flex-col items-center justify-center gap-0.5 text-2xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring";

function Pill({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "relative flex h-8 w-14 items-center justify-center rounded-full transition-[background-color,color] duration-200 ease-soft",
        active ? "bg-accent-muted text-primary" : "group-hover:bg-accent",
      )}
    >
      {children}
    </span>
  );
}

export function BottomNav({
  pathname,
  reviewCount,
  menuOpen,
  onMore,
  moreRef,
  disabled,
}: {
  pathname: string;
  reviewCount: number;
  menuOpen: boolean;
  onMore: () => void;
  moreRef: Ref<HTMLButtonElement>;
  disabled: boolean;
}) {
  const secondaryActive = navigation.some((item) => !item.primary && isActivePath(pathname, item.href));
  return (
    <nav
      aria-label="Schnellnavigation"
      className="app-bottom-nav fixed inset-x-0 bottom-0 z-30 border-t border-border/70 bg-background/90 pb-[var(--safe-bottom)] backdrop-blur-xl md:hidden"
    >
      <ul className="mx-auto grid h-[var(--shell-bottom-bar)] max-w-lg grid-cols-5 px-1">
        {navigation.filter((item) => item.primary).map((item) => {
          const active = isActivePath(pathname, item.href);
          return (
            <li key={item.href} className="min-w-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(itemClass, active ? "text-primary" : "text-muted-foreground hover:text-foreground")}
              >
                <Pill active={active}>
                  {item.seasonalSlot
                    ? <SeasonalIcon slot={item.seasonalSlot} className="size-5" fallback={<item.icon aria-hidden="true" className="size-5" />} />
                    : <item.icon aria-hidden="true" className="size-5" />}
                  {item.href === "/umsaetze" && reviewCount > 0 && (
                    <FinancialData as="span" className="absolute top-0 right-2">
                      <span className="sr-only">, {reviewCount} offene Zuordnungen</span>
                      <span aria-hidden="true" className="block size-2.5 rounded-full bg-primary ring-2 ring-background" />
                    </FinancialData>
                  )}
                </Pill>
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="min-w-0">
          <button
            ref={moreRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            disabled={disabled}
            onClick={onMore}
            className={cn(itemClass, "w-full disabled:opacity-50", secondaryActive || menuOpen ? "text-primary" : "text-muted-foreground hover:text-foreground")}
          >
            <Pill active={secondaryActive || menuOpen}>
              <Ellipsis aria-hidden="true" className="size-5" />
            </Pill>
            Mehr
          </button>
        </li>
      </ul>
    </nav>
  );
}
