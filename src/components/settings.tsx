"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, DatabaseBackup, Landmark, Palette, Save, Search, TriangleAlert, Volume2, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFinance } from "@/components/finance-provider";
import { PageHeading } from "@/components/finance-ui";
import { settingsCategoryOf, settingsGroups } from "@/components/settings-sections";
import { useSettingsSummaries } from "@/components/settings-summaries";
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
import { SettingsSection, SettingsSectionStyleProvider } from "@/components/settings-section";
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
  return <SettingsSection id="tr-zinsen" title="Trade Republic" description="Notgroschen und Jahreszins." icon={Landmark}>
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
  const [category, setCategory] = useState<string | null>(null);
  const pushed = useRef(false);
  const wide = useSyncExternalStore(subscribeWide, readWide, () => true);
  const summaries = useSettingsSummaries();
  const groups = useMemo(() => settingsGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.account || workspace) }))
    .filter((group) => group.items.length), [workspace]);
  const opened = category && groups.some((group) => group.id === category) ? category : null;
  const current = opened ?? groups[0]?.id ?? "";
  const searching = matches !== null;

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

  // ?bereich=daten opens a category, #sicherung (global search, older links) the category of that section.
  const params = useSearchParams();
  useEffect(() => {
    const sync = (scroll: boolean) => {
      const hash = decodeURIComponent(window.location.hash.slice(1));
      const next = settingsCategoryOf(new URLSearchParams(window.location.search).get("bereich") ?? "") ?? (hash ? settingsCategoryOf(hash) : undefined) ?? null;
      setCategory(next);
      if (scroll && hash && next) window.setTimeout(() => document.getElementById(hash)?.scrollIntoView?.({ block: "start" }), 150);
    };
    sync(true);
    const onHash = () => { setQuery(""); sync(true); };
    const onPop = () => { pushed.current = false; sync(false); };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onPop);
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("popstate", onPop); };
  }, [params]);

  const open = (id: string) => {
    setQuery("");
    setCategory(id);
    const url = `${window.location.pathname}?bereich=${id}`;
    // On phones a category is a page of its own, so the back button returns to the overview.
    if (!readWide() && !pushed.current) { window.history.pushState(null, "", url); pushed.current = true; window.scrollTo({ top: 0 }); }
    else window.history.replaceState(null, "", url);
  };
  const back = () => {
    if (pushed.current) { window.history.back(); return; }
    window.history.replaceState(null, "", window.location.pathname);
    setCategory(null);
  };

  const shown = (id: string) => !matches || matches.has(id);
  const nothing = matches !== null && matches.size === 0;
  const sections: Record<string, ReactNode> = {
    profil: <AccountProfileSettings />,
    bankverbindung: <BankConnections />,
    email: <MailConnection />,
    jahreszeit: <SettingsSection id="jahreszeit" title="Erscheinungsbild" icon={Palette}>
      <ThemePicker preference={saved} suggested={suggestedTheme} onChoose={chooseTheme} />
      <form className="mt-6 border-t border-border/60 pt-6" onSubmit={(event) => {
        event.preventDefault(); const parsed = seasonalPreferenceSchema.safeParse(value); if (!parsed.success) return;
        update((current) => ({ ...current, seasonalTheme: { ...parsed.data, mode: current.seasonalTheme?.mode ?? "auto", theme: current.seasonalTheme?.theme ?? "default" } }));
        setDraft(null); setPreview(null); toast.success("Einstellungen gespeichert");
      }}>
        <AppearanceControls value={value} inputRef={null} onBlur={() => {}} onChange={(next) => { setDraft(next); setPreview(next); }} />
        {dirty && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/5 p-3">
          <p className="text-xs text-muted-foreground">Noch nicht gespeichert.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(null); setPreview(null); }}>Verwerfen</Button>
            <Button type="submit" size="sm"><Save aria-hidden="true" className="size-4" />Einstellungen speichern</Button>
          </div>
        </div>}
      </form>
    </SettingsSection>,
    klaenge: <SettingsSection id="klaenge" title="Klänge" icon={Volume2}>
      <InteractionSoundsSetting />
    </SettingsSection>,
    benachrichtigungen: <NotificationSettings />,
    sichtschutz: <SecurityModeSettings />,
    sicherung: <SettingsSection id="sicherung" title="Sicherung" icon={DatabaseBackup}
      description="Das Excel-Backup enthält alle Buchungen, Pläne und Einstellungen. Mit „Wiederherstellen“ spielst du es wieder ein.">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h4 className="text-sm font-medium">Excel-Backup</h4>
          <BackupAge />
        </div>
        <FinancialData><ExcelActions compact /></FinancialData>
      </div>
      <AccountSyncTools manual />
    </SettingsSection>,
    gefahrenzone: <SettingsSection id="gefahrenzone" title="Gefahrenzone" icon={TriangleAlert} tone="danger"
      description="Entfernte Buchungen lassen sich nur aus einem Backup zurückholen.">
      <FinancialData className="[&>*:first-child]:mt-0"><ClearBookings /></FinancialData>
    </SettingsSection>,
  };

  return <>
    <PageHeading title={workspace ? "Profil & Einstellungen" : "Einstellungen"} />
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start lg:gap-10">
      <aside className={cn("min-w-0 space-y-4 lg:sticky lg:top-6", opened !== null && "max-lg:hidden")}>
        <label className="relative block">
          <span className="sr-only">Einstellungen durchsuchen</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Einstellung suchen …"
            className="h-11 bg-background/50 pl-9 pr-9" onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
          {query && <button type="button" aria-label="Suche leeren" onClick={() => setQuery("")}
            className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X aria-hidden="true" className="size-3.5" /></button>}
        </label>
        <nav aria-label="Einstellungsbereiche" className={cn(searching && "max-lg:hidden")}>
          <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-card lg:space-y-1 lg:divide-y-0 lg:overflow-visible lg:rounded-none lg:border-0 lg:bg-transparent lg:shadow-none">
            {groups.map((group) => {
              const active = !searching && current === group.id && (opened !== null || wide);
              const summary = summaries[group.id];
              return <li key={group.id}>
                <a href={`?bereich=${group.id}`} aria-current={active ? "page" : undefined} data-active={active || undefined}
                  onClick={(event) => { event.preventDefault(); open(group.id); }}
                  className="group flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:min-h-14 lg:rounded-xl lg:px-3 lg:py-2 lg:data-[active]:bg-muted">
                  <span aria-hidden="true" className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-primary transition-colors",
                    "lg:group-data-[active]:bg-primary/20")}>
                    <group.icon className="size-[1.125rem]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{group.label}</span>
                    {summary && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>}
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground lg:hidden" />
                </a>
              </li>;
            })}
          </ul>
        </nav>
      </aside>
      <div className={cn("min-w-0 lg:max-w-3xl", opened === null && !searching && "max-lg:hidden")}>
        {opened !== null && !searching && <button type="button" onClick={back}
          className="-ml-2 mb-3 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden">
          <ChevronLeft aria-hidden="true" className="size-4" />Alle Einstellungen
        </button>}
        {nothing && <p role="status" className="rounded-2xl border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
          Keine Einstellung zu „{query.trim()}“ gefunden.</p>}
        <SettingsSectionStyleProvider value={{ level: 3, descriptions: "tip" }}>
          <div className="flex flex-col gap-10">
            {groups.map((group) => {
              const visible = searching ? group.items.some((item) => shown(item.id)) : group.id === current;
              return <div key={group.id} hidden={!visible} className="space-y-4">
                <h2 className="px-1 text-xl font-semibold tracking-tight">{group.label}</h2>
                {group.items.map((item) => <div key={item.id} hidden={!shown(item.id)}>{sections[item.id]}</div>)}
              </div>;
            })}
          </div>
        </SettingsSectionStyleProvider>
      </div>
    </div>
  </>;
}

const WIDE_QUERY = "(min-width: 1024px)";
function subscribeWide(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const readWide = () => typeof window.matchMedia !== "function" || window.matchMedia(WIDE_QUERY).matches;
