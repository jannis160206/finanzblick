"use client";

import { usePathname } from "next/navigation";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { CircleAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FinanzblickMark } from "@/components/seasonal-icons";
import { SeasonalScene } from "@/components/seasonal-scene";
import { PageTransition } from "@/components/page-transition";
import { useFinance } from "@/components/finance-provider";
import { useSecurityMode } from "@/components/security-mode-provider";
import { useAccountWorkspace } from "@/components/account-context";
import { AccountSyncTools } from "@/components/account-tools";
import { AccountSidebarProfile } from "@/components/account-profile";
import { PageSkeleton } from "@/components/page-skeleton";
import { AssistantLauncher } from "@/components/assistant-launcher";
import { PwaNotifications } from "@/components/pwa-notifications";
import { AppSidebar, NavLinks } from "@/components/shell/sidebar";
import { AppHeader } from "@/components/shell/app-header";
import { BottomNav } from "@/components/shell/bottom-nav";
import { GlobalSearch } from "@/components/shell/global-search";
import { MotionProvider } from "@/components/motion/motion-provider";
import { PayslipUploadProvider } from "@/components/payslip-upload";
import { DriveInbox } from "@/components/drive-inbox";
import { PayrollBudgetSync } from "@/components/payroll-budget-sync";
import { useSeasonalTheme } from "@/components/seasonal-theme-provider";

export function AppShell({
  children,
  initialWarning,
}: {
  children: ReactNode;
  initialWarning?: string;
}) {
  const pathname = usePathname();
  const { ready, preloaded, storageError, retrySave, openReviewCount } = useFinance();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const security = useSecurityMode();
  const workspace = useAccountWorkspace();
  const reviewCount = ready ? openReviewCount : 0;
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const { motionReduced } = useSeasonalTheme();
  return (
    <MotionProvider reduced={motionReduced === true}>
    <PayslipUploadProvider>
    <DriveInbox />
    <PayrollBudgetSync />
    <div className="app-shell min-h-screen">
      <SeasonalScene />
      <a
        href="#main-content"
        className="sr-only z-50 rounded-xl bg-primary p-3 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Zum Inhalt springen
      </a>
      <AppSidebar pathname={pathname} reviewCount={reviewCount} workspace={!!workspace} onNavigate={closeMenu} />
      <div className="md:pl-[var(--shell-rail)] lg:pl-[var(--shell-sidebar)]">
        <AppHeader onSearch={() => setSearchOpen(true)} />
        <main
          id="main-content"
          className="mx-auto max-w-[1440px] px-4 pt-6 pb-[calc(var(--shell-bottom-bar)+var(--safe-bottom)+2rem)] md:px-6 md:pt-8 md:pb-10 xl:px-10"
        >
          {security.error && <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-warning/30 bg-warning-soft p-4 text-sm">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
            <p className="min-w-0 flex-1">{security.error}</p>
            <Button variant="outline" size="sm" onClick={security.retry}>Erneut speichern</Button>
          </div>}
          <div data-security-notice role="status" className="mb-5 flex-wrap items-center gap-3 rounded-2xl border border-primary/20 bg-accent-muted px-4 py-3 text-sm">
            <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Sicherheitsmodus aktiv</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Nur Finanzdaten sind unscharf.<span className="hidden sm:inline"> Navigation und Einstellungen bleiben verfügbar.</span></p>
            </div>
            <Button size="sm" variant="outline" className="min-h-11 w-full sm:min-h-9 sm:w-auto" disabled={!security.ready} onClick={security.toggle}>Daten anzeigen</Button>
          </div>
          <div data-financial-content>
            <AccountSyncTools visible={!security.locked && ready} />
            {storageError && !workspace && (
              <div
                role="alert"
                className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-destructive/30 bg-destructive-soft p-4 text-sm"
              >
                <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
                <p className="min-w-0 flex-1">{storageError}</p>
                <Button size="sm" variant="outline" onClick={retrySave}>
                  Erneut versuchen
                </Button>
              </div>
            )}
            {initialWarning && (
              <p className="mb-5 flex items-start gap-2.5 rounded-2xl border border-warning/25 bg-warning-soft px-4 py-3 text-xs leading-relaxed text-foreground">
                <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
                {initialWarning}
              </p>
            )}
            {ready || preloaded ? (
              // Server-rendered figures are visible at once but stay read-only until the working state has loaded.
              <div inert={!ready} aria-busy={!ready} className="contents">
                <PageTransition>{children}</PageTransition>
              </div>
            ) : (
              <PageSkeleton label="Finanzdaten werden geladen …" />
            )}
          </div>
          <footer className="mt-12 flex flex-wrap justify-between gap-2 border-t border-border/70 pt-4 text-2xs text-muted-foreground">
            <span>Finanzblick · Persönliche Finanzplanung</span>
            <span>EUR · Planung ist keine Kontobestätigung</span>
          </footer>
        </main>
      </div>
      <BottomNav
        pathname={pathname}
        reviewCount={reviewCount}
        menuOpen={menuOpen}
        onMore={() => setMenuOpen(true)}
        moreRef={menuTrigger}
        disabled={!security.ready}
      />
      {ready && <><AssistantLauncher /><PwaNotifications /></>}
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <Dialog open={menuOpen} onOpenChange={setMenuOpen} allowWhenLocked>
        <DialogContent variant="navigation" onCloseAutoFocus={(event) => {
          event.preventDefault();
          menuTrigger.current?.focus();
        }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3"><FinanzblickMark />Finanzblick</DialogTitle>
            <DialogDescription>Seite wählen</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-6">
            <div className="flex-1">
              <NavLinks pathname={pathname} reviewCount={reviewCount} hideSettings={!!workspace} onNavigate={closeMenu} />
            </div>
            {workspace && <AccountSidebarProfile active={pathname === "/einstellungen"} onNavigate={closeMenu} />}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
    </PayslipUploadProvider>
    </MotionProvider>
  );
}
