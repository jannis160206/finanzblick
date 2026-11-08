"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bell, Building2, DatabaseBackup, Landmark, Mail, Palette, Save, Search, Shield, ShieldCheck, TriangleAlert, UserRound, Volume2, X, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFinance } from "@/components/finance-provider";
import { PageHeading } from "@/components/finance-ui";
import { useSeasonalTheme } from "@/components/seasonal-theme-provider";
import { AppearanceControls } from "@/components/appearance-controls";
import { ThemePicker, type ThemeChoice } from "@/components/theme-picker";
import { InteractionSoundsSetting } from "@/components/interaction-sounds";
import { NotificationSettings } from "@/components/pwa-notifications";
import { ExcelActions } from "@/components/excel-actions";
import { BackupAge } from "@/components/backup-age";
import { ClearBookings } from "@/components/clear-bookings";
import { AccountProfileSettings } from "@/components/account-profile";
import { AccountSyncTools } from "@/components/account-tools";
import { useAccountWorkspace } from "@/components/account-context";
import { SettingsSection } from "@/components/settings-section";
import { SecurityModeSettings } from "@/components/security-mode-settings";
import { FinancialData } from "@/components/financial-data";
import { BankConnections } from "@/components/bank-connections";
import { MailConnection } from "@/components/mail-connection";
import { latestTRBalance } from "@/lib/calc";
import { currency, dateLabel, percent } from "@/lib/format";
import { seasonalPreferenceSchema, trBalanceSchema } from "@/lib/types";
import { cn } from "@/lib/utils";
import { defaultSeasonalPreference, type SeasonalPreference } from "@/lib/seasonal-theme";

export function TradeRepublicSettings() {
  const { state, update } = useFinance();
  const latest = latestTRBalance(state);
  const savedDate = latest?.date ?? state.settings.asOf;
  const savedBalance = latest?.balance ?? state.settings.balances.Notgroschen;
  const savedRate = state.settings.interestRates?.filter((entry) => entry.date <= state.settings.asOf).sort((a, b) => b.date.localeCompare(a.date))[0]?.rate
    ?? (state.settings.asOf < state.settings.rateChangeDate ? state.settings.oldRate : state.settings.newRate);
  const [draft, setDraft] = useState<{ balance: string; date: string; rate: string } | null>(null);
  const initial = { balance: String(savedBalance), date: savedDate, rate: String(Number((savedRate * 100).toFixed(6))) };
  const value = draft ?? initial;
  const valid = value.balance !== "" && value.rate !== "" && trBalanceSchema.safeParse({ balance: Number(value.balance), date: value.date }).success &&
    value.date <= state.settings.asOf && Number.isFinite(Number(value.rate)) && Number(value.rate) >= 0 && Number(value.rate) <= 100;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(initial);
  return <SettingsSection id="tr-zinsen" title="Trade Republic" description="Dein Notgroschen und der dazugehörige Jahreszins." icon={Landmark}>
    <FinancialData as="dl" className="mb-6 grid gap-4 rounded-2xl border border-border/70 bg-muted/15 p-4 sm:grid-cols-3 sm:p-5">
      <div><dt className="text-xs text-muted-foreground">Gespeicherter Kontostand</dt><dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{currency(savedBalance)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Zinssatz p.a.</dt><dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{percent(savedRate)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Stand vom</dt><dd className="mt-2 text-lg font-medium tabular-nums">{dateLabel(savedDate)}</dd></div>
    </FinancialData>
    <FinancialData>
    <form className="space-y-4" onSubmit={(event) => {
      event.preventDefault(); if (!valid) return;
      update((current) => {
        const history = current.settings.interestRates ?? [
          { date: "2026-01-01", rate: current.settings.oldRate },
          { date: current.settings.rateChangeDate, rate: current.settings.newRate },
        ];
        return { ...current,
          trBalances: [...(current.trBalances ?? []).filter((entry) => entry.date !== value.date), { date: value.date, balance: Number(value.balance) }],
          settings: { ...current.settings, interestRates: [...new Map([...history, { date: value.date, rate: Number(value.rate) / 100 }].map((entry) => [entry.date, entry])).values()].sort((a, b) => a.date.localeCompare(b.date)) },
        };
      });
      setDraft(null); toast.success("Trade Republic gespeichert");
    }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs font-medium">Kontostand (€)<Input aria-label="TR Kontostand" className="mt-2 h-11 bg-background/50" type="number" min="0" max="1000000000" step="0.01" value={value.balance} onChange={(event) => setDraft({ ...value, balance: event.target.value })} required /></label>
        <label className="min-w-0 text-xs font-medium">Datum<Input aria-label="TR Standdatum" className="mt-2 h-11 min-w-0 bg-background/50" type="date" max={state.settings.asOf} value={value.date} onChange={(event) => setDraft({ ...value, date: event.target.value })} required /></label>
        <label className="text-xs font-medium">Zinssatz p.a.<Input aria-label="Zinssatz p.a." className="mt-2 h-11 bg-background/50" type="number" min="0" max="100" step="0.01" value={value.rate} onChange={(event) => setDraft({ ...value, rate: event.target.value })} required /></label>
      </div>
      {dirty && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/5 p-3">
        <p className="text-xs text-muted-foreground">Noch nicht gespeichert.</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" type="button" size="sm" onClick={() => setDraft(null)}>Abbrechen</Button><Button type="submit" size="sm" disabled={!valid}><Save aria-hidden="true" className="size-4" />Trade Republic speichern</Button></div>
      </div>}
    </form>
    </FinancialData>
  </SettingsSection>;
}

export function Settings() {
  const workspace = useAccountWorkspace();
  const { state, update } = useFinance();
  const { setPreview, suggestedTheme } = useSeasonalTheme();
  const [draft, setDraft] = useState<SeasonalPreference | null>(null);
  const saved = state.seasonalTheme ?? defaultSeasonalPreference;
  const value = draft ?? saved;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => () => setPreview(null), [setPreview]);
  const chooseTheme = (choice: ThemeChoice) => {
    update((current) => ({ ...current, seasonalTheme: { ...(current.seasonalTheme ?? defaultSeasonalPreference), ...choice } }));
    if (draft) { const next = { ...draft, ...choice }; setDraft(next); setPreview(next); }
  };
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Set<string> | null>(null);
  const [active, setActive] = useState("");
  const groups = useMemo(() => settingsGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.account || workspace) }))
    .filter((group) => group.items.length), [workspace]);
  const ids = useMemo(() => groups.flatMap((group) => group.items.map((item) => item.id)), [groups]);

  // Search covers labels, keywords and everything a section actually shows (e.g. bank names, "Klarna", "Backup").
  useEffect(() => {
    const needle = query.trim().toLowerCase();
    const timer = window.setTimeout(() => {
      if (!needle) { setMatches(null); return; }
      const terms = needle.split(/\s+/);
      setMatches(new Set(groups.flatMap((group) => group.items.filter((item) => {
        const haystack = `${group.label} ${item.label} ${item.keywords} ${document.getElementById(item.id)?.textContent ?? ""}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      }).map((item) => item.id))));
    }, 80);
    return () => window.clearTimeout(timer);
  }, [query, groups]);

  // Highlight the section currently in view.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id);
    }, { rootMargin: "-20% 0px -65% 0px" });
    for (const id of ids) { const element = document.getElementById(id); if (element) observer.observe(element); }
    return () => observer.disconnect();
  }, [ids]);

  // Deep links like /einstellungen#email land on the section even though it renders after hydration.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const timer = window.setTimeout(() => document.getElementById(id)?.scrollIntoView?.({ block: "start" }), 150);
    return () => window.clearTimeout(timer);
  }, []);

  const shown = (id: string) => !matches || matches.has(id);
  const jump = (id: string) => { setQuery(""); setActive(id); };
  const sections: Record<string, ReactNode> = {
    profil: <AccountProfileSettings />,
    bankverbindung: <BankConnections />,
    email: <MailConnection />,
    jahreszeit: <SettingsSection id="jahreszeit" title="Erscheinungsbild" description="Thema, Akzentfarbe und Bewegung. So fühlt sich Finanzblick nach dir an." icon={Palette}>
      <ThemePicker preference={saved} suggested={suggestedTheme} onChoose={chooseTheme} />
      <form className="mt-6 border-t border-border/70 pt-6" onSubmit={(event) => {
        event.preventDefault(); const parsed = seasonalPreferenceSchema.safeParse(value); if (!parsed.success) return;
        update((current) => ({ ...current, seasonalTheme: { ...parsed.data, mode: current.seasonalTheme?.mode ?? "auto", theme: current.seasonalTheme?.theme ?? "default" } }));
        setDraft(null); setPreview(null); toast.success("Einstellungen gespeichert");
      }}>
        <AppearanceControls value={value} inputRef={null} onBlur={() => {}} onChange={(next) => { setDraft(next); setPreview(next); }} />
        {dirty && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/5 p-3">
          <p className="text-xs text-muted-foreground">Vorschau aktiv · noch nicht gespeichert.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(null); setPreview(null); }}>Verwerfen</Button>
            <Button type="submit" size="sm"><Save aria-hidden="true" className="size-4" />Einstellungen speichern</Button>
          </div>
        </div>}
      </form>
    </SettingsSection>,
    klaenge: <SettingsSection id="klaenge" title="Klänge" description="Dezentes Feedback beim Klicken und Speichern." icon={Volume2}>
      <InteractionSoundsSetting />
    </SettingsSection>,
    benachrichtigungen: <NotificationSettings />,
    sichtschutz: <SecurityModeSettings />,
    sicherung: <SettingsSection id="sicherung" title="Sicherung" description="Eine Kopie deiner Daten. Jederzeit in deiner Hand." icon={DatabaseBackup}>
      <div className="flex flex-wrap items-center justify-between gap-5 rounded-2xl border border-border/70 bg-muted/15 p-4 sm:p-5">
        <div className="flex max-w-md items-start gap-3">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
          <div><h3 className="text-sm font-medium">Dein Excel-Backup</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Umsätze, Planung und Einstellungen in einer Datei. Vor dem Wiederherstellen prüfst du die Vorschau.</p><BackupAge /></div>
        </div>
        <FinancialData><ExcelActions compact /></FinancialData>
      </div>
      <AccountSyncTools manual />
    </SettingsSection>,
    gefahrenzone: <SettingsSection id="gefahrenzone" title="Gefahrenzone" description="Endgültige Aktionen. Vorher am besten ein Excel-Backup erstellen." icon={TriangleAlert}>
      <FinancialData className="[&>*:first-child]:mt-0"><ClearBookings /></FinancialData>
    </SettingsSection>,
  };
  const nothing = matches !== null && matches.size === 0;

  return <>
    <PageHeading eyebrow={workspace ? "DEIN WORKSPACE" : "KONFIGURATION"} title={workspace ? "Profil & Einstellungen" : "Einstellungen"} />
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start">
      <aside className="min-w-0 space-y-3 lg:sticky lg:top-6">
        <label className="relative block">
          <span className="sr-only">Einstellungen durchsuchen</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Einstellung suchen …"
            className="h-10 bg-background/50 pl-9 pr-9" onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
          {query && <button type="button" aria-label="Suche leeren" onClick={() => setQuery("")}
            className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X aria-hidden="true" className="size-3.5" /></button>}
        </label>
        <nav aria-label="Einstellungsbereiche" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] lg:mx-0 lg:block lg:space-y-4 lg:overflow-visible lg:px-0 lg:pb-0">
          {groups.map((group) => <div key={group.id} className="contents lg:block">
            <p className="hidden px-2.5 pb-1 text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground lg:block">{group.label}</p>
            {group.items.filter((item) => shown(item.id)).map((item) => <a key={item.id} href={`#${item.id}`} onClick={() => jump(item.id)}
              aria-current={active === item.id ? "location" : undefined}
              className={cn("flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-full",
                active === item.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                item.id === "gefahrenzone" && active !== item.id && "hover:text-destructive")}>
              <item.icon aria-hidden="true" className="size-4 shrink-0" />{item.label}
            </a>)}
          </div>)}
        </nav>
      </aside>
      <div className="min-w-0 space-y-8">
        {nothing && <p role="status" className="rounded-2xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
          Keine Einstellung zu „{query.trim()}“ gefunden.</p>}
        {groups.map((group) => {
          const items = group.items.filter((item) => shown(item.id));
          return <div key={group.id} hidden={!items.length} className="space-y-4">
            <p className="px-1 text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{group.label}</p>
            {group.items.map((item) => <div key={item.id} hidden={!shown(item.id)}>{sections[item.id]}</div>)}
          </div>;
        })}
      </div>
    </div>
  </>;
}

type SettingsItem = { id: string; label: string; icon: LucideIcon; keywords: string; account?: boolean };
const settingsGroups: Array<{ id: string; label: string; items: SettingsItem[] }> = [
  { id: "konto", label: "Konto", items: [
    { id: "profil", label: "Profil", icon: UserRound, keywords: "konto benutzer anmelden abmelden", account: true },
  ] },
  { id: "verbindungen", label: "Verbindungen", items: [
    { id: "bankverbindung", label: "Bankkonten", icon: Building2, keywords: "bank psd2 enable banking abruf freigabe erneuern konto verbinden", account: true },
    { id: "email", label: "E-Mail-Bestellungen", icon: Mail, keywords: "gmail mail bestellung klarna paypal amazon rechnung app-passwort", account: true },
  ] },
  { id: "app", label: "App", items: [
    { id: "jahreszeit", label: "Erscheinungsbild", icon: Palette, keywords: "thema theme farbe akzent saison dunkel bewegung animation design" },
    { id: "klaenge", label: "Klänge", icon: Volume2, keywords: "ton sound lautstärke audio" },
    { id: "benachrichtigungen", label: "Benachrichtigungen", icon: Bell, keywords: "hinweise push mitteilung budget gehalt" },
    { id: "sichtschutz", label: "Sichtschutz", icon: Shield, keywords: "sicherheitsmodus privatsphäre unscharf verbergen" },
  ] },
  { id: "daten", label: "Daten", items: [
    { id: "sicherung", label: "Sicherung", icon: DatabaseBackup, keywords: "backup excel export import wiederherstellen abgleich server konflikt" },
    { id: "gefahrenzone", label: "Gefahrenzone", icon: TriangleAlert, keywords: "löschen entfernen zurücksetzen buchungen" },
  ] },
];

