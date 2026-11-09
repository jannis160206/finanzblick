"use client";

import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { FinanzblickMark, SeasonalIcon } from "@/components/seasonal-icons";
import { FinancialData } from "@/components/financial-data";
import { ReviewCount } from "@/components/review-count";
import { AccountSidebarProfile } from "@/components/account-profile";
import { navigation, isActivePath } from "@/components/shell/navigation";
import { cn } from "@/lib/utils";

export function NavLinks({
  pathname,
  reviewCount,
  hideSettings,
  rail = false,
  onNavigate,
}: {
  pathname: string;
  reviewCount: number;
  hideSettings: boolean;
  rail?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Hauptnavigation" className="flex h-full flex-col gap-1">
      {navigation.filter((item) => !hideSettings || item.href !== "/einstellungen").map((item) => {
        const active = isActivePath(pathname, item.href);
        const icon = item.seasonalSlot
          ? <SeasonalIcon slot={item.seasonalSlot} className="size-[18px] shrink-0" fallback={<item.icon aria-hidden="true" className="size-[18px] shrink-0" />} />
          : <item.icon aria-hidden="true" className="size-[18px] shrink-0" />;
        return (
          <div key={item.href} className={item.href === "/einstellungen" ? "mt-auto border-t border-sidebar-border pt-3" : undefined}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                rail && "md:max-lg:justify-center md:max-lg:px-0",
                active
                  ? "bg-accent-muted font-medium text-primary"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              )}
            >
              <span className="relative flex">
                {icon}
                {rail && item.href === "/umsaetze" && reviewCount > 0 && (
                  <span aria-hidden="true" className="absolute -top-1 -right-1.5 hidden size-2.5 rounded-full bg-primary ring-2 ring-sidebar md:max-lg:block" />
                )}
              </span>
              <span className={cn("min-w-0 truncate", rail && "md:max-lg:sr-only")}>{item.label}</span>
              {item.href === "/umsaetze" && reviewCount > 0 && (
                <FinancialData as="span" className={cn("ml-auto", rail && "md:max-lg:hidden")}>
                  <ReviewCount count={reviewCount} />
                </FinancialData>
              )}
              {rail && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-full z-50 ml-3 hidden -translate-y-1/2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-popover-foreground opacity-0 shadow-raised transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 md:max-lg:block"
                >
                  {item.label}
                </span>
              )}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}

export function AppSidebar({
  pathname,
  reviewCount,
  workspace,
  onNavigate,
}: {
  pathname: string;
  reviewCount: number;
  workspace: boolean;
  onNavigate: () => void;
}) {
  return (
    <aside className="app-sidebar fixed inset-y-0 left-0 z-30 hidden w-[var(--shell-rail)] flex-col border-r border-sidebar-border bg-sidebar md:flex lg:w-[var(--shell-sidebar)]">
      <Link
        href="/"
        className="flex h-[var(--shell-header)] shrink-0 items-center gap-2.5 px-5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:max-lg:justify-center md:max-lg:px-0"
      >
        <FinanzblickMark flicker />
        <span className="text-base font-semibold tracking-tight md:max-lg:sr-only">
          Finanz<span className="font-normal text-muted-foreground">blick</span>
        </span>
      </Link>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-4 md:max-lg:overflow-visible md:max-lg:px-2">
        <NavLinks pathname={pathname} reviewCount={reviewCount} hideSettings={workspace} rail onNavigate={onNavigate} />
      </div>
      {workspace ? (
        <div className="shrink-0 px-3 pb-4 md:max-lg:px-2">
          <AccountSidebarProfile active={pathname === "/einstellungen"} onNavigate={onNavigate} rail />
        </div>
      ) : (
        <div className="mx-3 mb-4 rounded-2xl border border-sidebar-border bg-background/60 p-3 md:max-lg:mx-auto md:max-lg:border-0 md:max-lg:bg-transparent md:max-lg:p-0">
          <div className="flex items-center gap-2 text-xs font-medium">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted" title="Privater Workspace: Daten bleiben in diesem Browser.">
              <LockKeyhole aria-hidden="true" className="size-4 text-muted-foreground" />
            </span>
            <span className="md:max-lg:sr-only">Privater Workspace</span>
          </div>
          <p className="mt-2 px-1 text-2xs leading-relaxed text-muted-foreground md:max-lg:sr-only">
            Daten bleiben in diesem Browser.
          </p>
        </div>
      )}
    </aside>
  );
}
