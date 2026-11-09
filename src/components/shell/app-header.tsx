"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { Check, CircleAlert, LoaderCircle, Moon, Shield, ShieldCheck, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FinanzblickMark } from "@/components/seasonal-icons";
import { GlobalImport } from "@/components/global-import";
import { useFinance } from "@/components/finance-provider";
import { useSecurityMode } from "@/components/security-mode-provider";
import { useAccountWorkspace } from "@/components/account-context";
import { SearchTrigger } from "@/components/shell/global-search";
import { cn } from "@/lib/utils";

function SaveStatus() {
  const { ready, saved, storageError, synchronizing, syncNeedsAttention } = useFinance();
  const workspace = useAccountWorkspace();
  if (!ready) return null;
  const label = synchronizing
    ? "Gleicht ab …"
    : storageError
      ? workspace ? syncNeedsAttention ? "Prüfung nötig" : "Lokal gesichert" : "Nicht gespeichert"
      : saved
        ? workspace ? "Synchronisiert" : "Lokal gespeichert"
        : "Speichert …";
  return (
    <span
      className={cn(
        "mr-1 hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium xl:inline-flex",
        storageError ? "bg-destructive-soft text-destructive" : "text-muted-foreground",
      )}
    >
      {storageError
        ? <CircleAlert aria-hidden="true" className="size-3" />
        : synchronizing || !saved
          ? <LoaderCircle aria-hidden="true" className="size-3 motion-safe:animate-spin" />
          : <Check aria-hidden="true" className="size-3 text-success" />}
      {label}
    </span>
  );
}

export function AppHeader({ onSearch }: { onSearch: () => void }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const security = useSecurityMode();
  const current = resolvedTheme ?? theme;
  return (
    <header className="app-header sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-[var(--shell-header)] max-w-[1440px] items-center gap-1.5 px-4 md:gap-3 md:px-6 xl:px-10">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:hidden"
        >
          <FinanzblickMark />
          <span className="text-[0.9375rem] font-semibold tracking-tight">
            Finanz<span className="font-normal text-muted-foreground">blick</span>
          </span>
        </Link>
        <div className="ml-auto flex min-w-0 md:ml-0 md:flex-1">
          <SearchTrigger onOpen={onSearch} disabled={!security.ready} />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 md:gap-1">
          <SaveStatus />
          {!security.locked && <GlobalImport />}
          <span aria-hidden="true" className="mx-1 hidden h-5 border-l border-border md:block" />
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-9", security.locked && "bg-accent-muted text-primary")}
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
            className="size-9"
            aria-label="Farbschema wechseln"
            onClick={() => setTheme(current === "dark" ? "light" : "dark")}
          >
            <Sun className="hidden size-4 dark:block" />
            <Moon className="size-4 dark:hidden" />
          </Button>
        </div>
      </div>
    </header>
  );
}
