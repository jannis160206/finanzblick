"use client";

import Link from "next/link";
import { ChevronRight, Palette, Settings2, ShieldCheck } from "lucide-react";
import { useAccountWorkspace } from "@/components/account-context";
import { AccountLogout } from "@/components/account-tools";
import { cn } from "@/lib/utils";

function ProfileAvatar({ username, large = false }: { username: string; large?: boolean }) {
  return <span aria-hidden="true" className={cn(
    "flex shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 font-semibold text-primary",
    large ? "size-14 text-xl" : "size-10 text-sm",
  )}>{username.slice(0, 2).toUpperCase()}</span>;
}

export function AccountSidebarProfile({ active, onNavigate, rail = false }: { active: boolean; onNavigate: () => void; rail?: boolean }) {
  const workspace = useAccountWorkspace();
  if (!workspace) return null;
  const { username, role } = workspace.user;
  return <section aria-label="Benutzerprofil" className={cn("shrink-0 rounded-2xl border border-border/70 bg-background/50 p-2",
    rail && "md:max-lg:border-0 md:max-lg:bg-transparent md:max-lg:p-0")}>
    <Link href="/einstellungen#profil" onClick={onNavigate} aria-label={`Profil von ${username} öffnen`}
      className={cn("group flex min-h-16 items-center gap-3 rounded-xl p-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        rail && "md:max-lg:min-h-0 md:max-lg:justify-center md:max-lg:p-1")}>
      <ProfileAvatar username={username} />
      <span className={cn("min-w-0 flex-1", rail && "md:max-lg:hidden")}>
        <span className="block truncate text-sm font-semibold">{username}</span>
        <span className="mt-0.5 block text-2xs text-muted-foreground">{role === "admin" ? "Administrator" : "Persönliches Konto"}</span>
      </span>
      <ChevronRight aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground", rail && "md:max-lg:hidden")} />
    </Link>
    <div className={cn("mt-1 grid grid-cols-[1fr_auto] items-start gap-1 border-t border-border/70 pt-2",
      rail && "md:max-lg:grid-cols-1 md:max-lg:justify-items-center md:max-lg:border-0 md:max-lg:[&_p]:sr-only")}>
      <Link href="/einstellungen" onClick={onNavigate} aria-current={active ? "page" : undefined}
        className={cn("flex min-h-11 items-center gap-2 rounded-xl px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          rail && "md:max-lg:size-11 md:max-lg:justify-center md:max-lg:px-0",
          active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
        <Settings2 aria-hidden="true" className="size-4 shrink-0" /><span className={cn(rail && "md:max-lg:sr-only")}>Einstellungen</span>
      </Link>
      <AccountLogout compact />
    </div>
  </section>;
}

export function AccountProfileSettings() {
  const workspace = useAccountWorkspace();
  if (!workspace) return null;
  const { username, role } = workspace.user;
  return <section id="profil" aria-labelledby="profile-heading" className="panel scroll-mt-24 overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 bg-primary/[0.03] p-5 sm:p-6">
      <div className="flex min-w-0 items-center gap-4">
        <ProfileAvatar username={username} large />
        <div className="min-w-0">
          <p className="mb-1 text-2xs font-medium tracking-[0.16em] text-muted-foreground">DEIN PROFIL</p>
          <h2 id="profile-heading" className="truncate text-xl font-semibold tracking-tight">{username}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{role === "admin" ? "Administrator" : "Persönliches Konto"}</p>
        </div>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/15 bg-primary/5 px-3 py-1.5 text-2xs font-medium text-primary">
        <ShieldCheck aria-hidden="true" className="size-3.5" />Angemeldet
      </span>
    </div>
    <div className="flex flex-wrap gap-2 border-t border-border/70 px-5 py-3 sm:px-6">
      <Link href="#jahreszeit" className="inline-flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Palette aria-hidden="true" className="size-3.5" />Erscheinungsbild
      </Link>
      <Link href="#sicherung" className="inline-flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ShieldCheck aria-hidden="true" className="size-3.5" />Datensicherung
      </Link>
    </div>
  </section>;
}
