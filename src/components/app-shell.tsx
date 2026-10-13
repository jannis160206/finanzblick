"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import {
  ArrowLeftRight,
  CalendarRange,
  Calculator,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  CircleAlert,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  Moon,
  Settings2,
  Shield,
  ShieldCheck,
  Sun,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FinanzblickMark, SeasonalIcon } from "@/components/seasonal-icons";
import { useFinance } from "@/components/finance-provider";
import { ReviewCount } from "@/components/review-count";
import { cn } from "@/lib/utils";
import { useSecurityMode } from "@/components/security-mode-provider";
import { useAccountWorkspace } from "@/components/account-context";
import { AccountSyncTools } from "@/components/account-tools";
import { AccountSidebarProfile } from "@/components/account-profile";
import { FinancialData } from "@/components/financial-data";

const navigation = [
  { href: "/", label: "Übersicht", icon: LayoutDashboard },
  { href: "/umsaetze", label: "Umsätze", icon: ArrowLeftRight },
  { href: "/monate", label: "Monate", icon: CalendarRange },
  { href: "/pockets", label: "Pockets", icon: Wallet },
  { href: "/plan", label: "Budgetdetails", icon: ChartNoAxesCombined },
  { href: "/gehalt-steuern", label: "Gehalt & Steuern", icon: Calculator },
  { href: "/einstellungen", label: "Einstellungen", icon: Settings2 },
];
export function AppShell({
  children,
  initialWarning,
}: {
  children: ReactNode;
  initialWarning?: string;
}) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const { ready, saved, storageError, retrySave, openReviewCount, synchronizing, syncNeedsAttention } = useFinance();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const security = useSecurityMode();
  const workspace = useAccountWorkspace();
  const current = navigation.find((item) => item.href === pathname);
  const links = (
    <nav aria-label="Hauptnavigation" className="flex h-full flex-col gap-1.5">
      {navigation.filter((item) => !workspace || item.href !== "/einstellungen").map((item) => (
        <div key={item.href} className={item.href === "/einstellungen" ? "mt-auto border-t pt-4" : undefined}>
        <Link
          href={item.href}
          onClick={() => setMenuOpen(false)}
          aria-current={pathname === item.href ? "page" : undefined}
          className={cn(
            "flex min-h-11 items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors duration-150",
            pathname === item.href
              ? "bg-primary/10 font-medium text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {item.href === "/" || item.href === "/pockets" ? (
            <SeasonalIcon
              slot={item.href === "/" ? "navigation" : "pockets"}
              className="size-[18px]"
              fallback={<item.icon className="size-[18px]" />}
            />
          ) : (
            <item.icon className="size-[18px]" />
          )}
          {item.label}
          {item.href === "/umsaetze" && ready && openReviewCount > 0 && <FinancialData as="span" className="ml-auto"><ReviewCount count={openReviewCount} /></FinancialData>}
        </Link>
        </div>
      ))}
    </nav>
  );
  return (
    <div className="app-shell min-h-screen">
      <a
        href="#main-content"
        className="sr-only z-50 rounded bg-primary p-3 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Zum Inhalt springen
      </a>
      <aside className="app-sidebar fixed inset-y-0 left-0 z-30 hidden w-[224px] flex-col border-r bg-sidebar lg:flex">
        <Link href="/" className="flex h-[76px] items-center gap-2.5 px-6">
          <FinanzblickMark />
          <span className="text-[16px] font-semibold tracking-tight">
            Finanz
            <span className="font-normal text-muted-foreground">blick</span>
          </span>
        </Link>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-5">
          {links}
        </div>
        {workspace ? <div className="shrink-0 px-4 pb-4">
          <AccountSidebarProfile active={pathname === "/einstellungen"} onNavigate={() => setMenuOpen(false)} />
        </div> : <div className="mx-4 mb-5 rounded-xl bg-background/70 p-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            <span className="flex size-8 items-center justify-center rounded-lg bg-muted">
              <LockKeyhole className="size-4 text-muted-foreground" />
            </span>
            Privater Workspace
          </div>
          <p className="mt-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
            Daten bleiben in diesem Browser.
          </p>
        </div>}
      </aside>
      <div className="lg:pl-[224px]">
        <header className="app-header sticky top-0 z-20 flex h-[76px] items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur-sm sm:px-7 xl:px-9">
          <div className="relative z-10 flex items-center gap-3">
            <Button
              ref={menuTrigger}
              size="icon"
              variant="ghost"
              className="lg:hidden"
              aria-label="Navigation öffnen"
              aria-expanded={menuOpen}
              aria-haspopup="dialog"
              disabled={!security.ready}
              onClick={() => setMenuOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
            <div className="hidden items-center gap-2.5 text-xs sm:flex">
              <span className="text-muted-foreground">Finanzen</span>
              <ChevronRight className="size-3 text-muted-foreground" />
              <span>{current?.label ?? "Seite"}</span>
            </div>
          </div>
          <div className="relative z-10 flex items-center gap-1 sm:gap-2">
            {ready && (
              <>
                <span
                  className={cn(
                    "mr-2 hidden items-center gap-1.5 text-[10px] xl:flex",
                    storageError ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {storageError ? (
                    <CircleAlert className="size-3" />
                  ) : (
                    <Check className="size-3 text-primary" />
                  )}
                  {synchronizing ? "Gleicht ab …" : storageError
                    ? workspace ? syncNeedsAttention ? "Prüfung nötig" : "Lokal gesichert" : "Nicht gespeichert"
                    : saved
                      ? workspace ? "Synchronisiert" : "Lokal gespeichert"
                      : "Speichert …"}
                </span>
              </>
            )}
            <div className="mx-1 h-5 border-l" />
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-9", security.locked && "bg-primary/10 text-primary")}
              disabled={!security.ready || security.preference === "off"}
              aria-label={security.locked ? "Sicherheitsmodus deaktivieren" : "Sicherheitsmodus aktivieren"}
              aria-pressed={security.locked}
              title={security.preference === "off" ? "Sicherheitsmodus in den Einstellungen deaktiviert" : security.locked ? "Sichtschutz aktiv – Finanzdaten anzeigen" : "Finanzdaten weichzeichnen"}
              onClick={security.toggle}
            >
              {security.locked ? <ShieldCheck className="size-4" /> : <Shield className="size-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Farbschema wechseln"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              <Sun className="hidden size-4 dark:block" />
              <Moon className="size-4 dark:hidden" />
            </Button>
          </div>
        </header>
        <main
          id="main-content"
          className="mx-auto max-w-[1600px] px-4 py-6 sm:px-7 sm:py-8 xl:px-9"
        >
          {security.error && <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            <CircleAlert className="size-4 shrink-0" />
            <p className="min-w-0 flex-1">{security.error}</p>
            <Button variant="outline" size="sm" onClick={security.retry}>Erneut speichern</Button>
          </div>}
          <div data-security-notice role="status" className="mb-5 flex-wrap items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
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
              className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
            >
              <CircleAlert className="size-4 shrink-0 text-destructive" />
              <p className="min-w-0 flex-1">{storageError}</p>
              <Button size="sm" variant="outline" onClick={retrySave}>
                Erneut versuchen
              </Button>
            </div>
          )}
          {initialWarning && (
            <p className="mb-5 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-muted-foreground">
              {initialWarning}
            </p>
          )}
          {ready ? (
            children
          ) : (
            <div role="status" aria-live="polite" className="space-y-6">
              <p className="text-sm text-muted-foreground">
                Finanzdaten werden geladen …
              </p>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[0, 1, 2, 3].map((index) => (
                  <div
                    key={index}
                    className="panel h-36 animate-pulse bg-muted/20"
                  />
                ))}
              </div>
              <div className="panel h-80 animate-pulse bg-muted/20" />
            </div>
          )}
          </div>
          <footer className="mt-10 flex flex-wrap justify-between gap-2 border-t pt-4 text-[10px] text-muted-foreground">
            <span>Finanzblick · Persönliche Finanzplanung</span>
            <span>EUR · Planung ist keine Kontobestätigung</span>
          </footer>
        </main>
      </div>
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
            <div className="flex-1">{links}</div>
            {workspace && <AccountSidebarProfile active={pathname === "/einstellungen"} onNavigate={() => setMenuOpen(false)} />}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
