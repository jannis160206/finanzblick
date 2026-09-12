"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import {
  ArrowLeftRight,
  CalendarRange,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  CircleAlert,
  Landmark,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  Moon,
  Settings2,
  Sun,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExcelActions } from "@/components/excel-actions";
import { SeasonalAtmosphere } from "@/components/seasonal-atmosphere";
import { useFinance } from "@/components/finance-provider";
import { cn } from "@/lib/utils";

const navigation = [
  { href: "/", label: "Übersicht", icon: LayoutDashboard },
  { href: "/umsaetze", label: "Umsätze", icon: ArrowLeftRight },
  { href: "/monate", label: "Monate", icon: CalendarRange },
  { href: "/pockets", label: "Pockets", icon: Wallet },
  { href: "/plan", label: "Budgetdetails", icon: ChartNoAxesCombined },
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
  const { ready, saved, storageError, retrySave } = useFinance();
  const [menuOpen, setMenuOpen] = useState(false);
  const current = navigation.find((item) => item.href === pathname);
  const links = (
    <nav aria-label="Hauptnavigation" className="space-y-1">
      {navigation.map((item, index) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={() => setMenuOpen(false)}
          aria-current={pathname === item.href ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-colors",
            pathname === item.href
              ? "bg-primary/10 font-medium text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
            index === 5 && "mt-8",
          )}
        >
          <item.icon className="size-[18px]" />
          {item.label}
          {pathname === item.href && (
            <span className="ml-auto size-1.5 rounded-full bg-primary" />
          )}
        </Link>
      ))}
    </nav>
  );
  return (
    <div
      className="app-shell relative isolate min-h-screen"
      data-seasonal-atmosphere={pathname === "/" ? "overview" : "none"}
    >
      {pathname === "/" && <SeasonalAtmosphere placement="shell" />}
      <a
        href="#main-content"
        className="sr-only z-50 rounded bg-primary p-3 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Zum Inhalt springen
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[224px] flex-col border-r bg-sidebar lg:flex">
        <Link href="/" className="flex h-[76px] items-center gap-2.5 px-6">
          <span className="rounded-lg bg-primary p-2 text-primary-foreground">
            <Landmark className="size-4" />
          </span>
          <span className="text-[16px] font-semibold tracking-tight">
            Finanz
            <span className="font-normal text-muted-foreground">blick</span>
          </span>
        </Link>
        <div className="flex-1 px-4 pt-6">
          <p className="eyebrow mb-4 px-3">WORKSPACE</p>
          {links}
        </div>
        <div className="mx-4 mb-5 rounded-xl border bg-background/50 p-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            <span className="flex size-8 items-center justify-center rounded-lg bg-muted">
              <LockKeyhole className="size-4 text-muted-foreground" />
            </span>
            Privater Workspace
          </div>
          <p className="mt-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
            Daten bleiben in diesem Browser.
            <br />
            Excel als lokale Sicherung.
          </p>
        </div>
      </aside>
      <div className="lg:pl-[224px]">
        <header className="isolate sticky top-0 z-20 flex h-[76px] items-center justify-between gap-2 border-b bg-background/95 px-4 backdrop-blur-sm sm:px-7 xl:px-9">
          {pathname === "/" && <SeasonalAtmosphere placement="header" />}
          <div className="relative z-10 flex items-center gap-3">
            <Button
              size="icon"
              variant="ghost"
              className="lg:hidden"
              aria-label="Navigation öffnen"
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
                  {storageError
                    ? "Nicht gespeichert"
                    : saved
                      ? "Lokal gespeichert"
                      : "Speichert …"}
                </span>
                <ExcelActions />
              </>
            )}
            <div className="mx-1 h-5 border-l" />
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
          {storageError && (
            <div
              role="alert"
              className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
            >
              <CircleAlert className="size-4 shrink-0 text-destructive" />
              <p className="min-w-0 flex-1">{storageError}</p>
              <Button size="sm" variant="outline" onClick={retrySave}>
                Speichern erneut aktivieren
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
          <footer className="mt-10 flex flex-wrap justify-between gap-2 border-t pt-4 text-[10px] text-muted-foreground">
            <span>Finanzblick · Persönliche Finanzplanung</span>
            <span>EUR · Planung ist keine Kontobestätigung</span>
          </footer>
        </main>
      </div>
      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Finanzblick</DialogTitle>
            <DialogDescription>Persönlicher Workspace</DialogDescription>
          </DialogHeader>
          {links}
        </DialogContent>
      </Dialog>
    </div>
  );
}
