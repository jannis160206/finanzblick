"use client";

import { useEffect, useState } from "react";
import { CalendarDays, ChevronDown, DatabaseBackup, Landmark, Palette, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFinance } from "@/components/finance-provider";
import { PageHeading } from "@/components/finance-ui";
import { useSeasonalTheme } from "@/components/seasonal-theme-provider";
import { AppearanceControls } from "@/components/appearance-controls";
import { InteractionSoundsSetting } from "@/components/interaction-sounds";
import { SavingsGoals } from "@/components/savings-goals";
import { ExcelActions } from "@/components/excel-actions";
import { AccountProfileSettings } from "@/components/account-profile";
import { AccountSyncTools } from "@/components/account-tools";
import { useAccountWorkspace } from "@/components/account-context";
import { SettingsSection } from "@/components/settings-section";
import { SecurityModeSettings } from "@/components/security-mode-settings";
import { FinancialData } from "@/components/financial-data";
import { latestTRBalance } from "@/lib/calc";
import { currency, dateLabel, percent } from "@/lib/format";
import { seasonalPreferenceSchema, trBalanceSchema } from "@/lib/types";
import { defaultSeasonalPreference, seasonalThemes, seasonalLabels, type SeasonalPreference } from "@/lib/seasonal-theme";

function TradeRepublicSettings() {
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
  const { setPreview, testTheme, setTestTheme } = useSeasonalTheme();
  const [draft, setDraft] = useState<SeasonalPreference | null>(null);
  const saved = state.seasonalTheme ?? defaultSeasonalPreference;
  const value = draft ?? saved;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => () => { setPreview(null); setTestTheme(null); }, [setPreview, setTestTheme]);
  return <>
    <PageHeading eyebrow={workspace ? "DEIN WORKSPACE" : "KONFIGURATION"} title={workspace ? "Profil & Einstellungen" : "Einstellungen"} />
    <div className="space-y-4">
      <AccountProfileSettings />
      <SecurityModeSettings />
      <SettingsSection id="jahreszeit" title="Erscheinungsbild" description="Deine Farben, dein Komfort. So fühlt sich Finanzblick nach dir an." icon={Palette}>
        <form onSubmit={(event) => {
          event.preventDefault(); const parsed = seasonalPreferenceSchema.safeParse(value); if (!parsed.success) return;
          update((current) => ({ ...current, seasonalTheme: parsed.data }));
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
        <div className="mt-6 grid items-start gap-4 border-t border-border/70 pt-6 xl:grid-cols-2">
        <InteractionSoundsSetting />
        <details className="group rounded-2xl border border-border/70 bg-muted/15 p-4 text-xs" onToggle={(event) => { if (!event.currentTarget.open) setTestTheme(null); }}>
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background/70"><CalendarDays aria-hidden="true" className="size-4 text-muted-foreground" /></span>
            <span className="flex-1"><span className="block text-sm font-medium">Saisonvorschau</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">Ein Blick auf die nächsten Jahreszeiten.</span></span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <label className="mt-4 block border-t border-border/60 pt-4">Vorschau
            <select aria-label="Saisonvorschau" className="select-input mt-2 w-full bg-background/50" value={testTheme ?? ""} onChange={(event) => {
              const theme = seasonalThemes.find((theme) => theme === event.target.value);
              setTestTheme(theme ?? null);
            }}>
              <option value="">Aktueller Kalender</option>
              {seasonalThemes.map((theme) => <option key={theme} value={theme}>{seasonalLabels[theme]}</option>)}
            </select>
          </label>
          <p className="mt-2 text-muted-foreground">Nur ansehen – wird nicht gespeichert.</p>
        </details>
        </div>
      </SettingsSection>
      <SavingsGoals />
      <TradeRepublicSettings />
      <SettingsSection id="sicherung" title="Sicherung" description="Eine Kopie deiner Daten. Jederzeit in deiner Hand." icon={DatabaseBackup}>
        <div className="flex flex-wrap items-center justify-between gap-5 rounded-2xl border border-border/70 bg-muted/15 p-4 sm:p-5">
          <div className="flex max-w-md items-start gap-3">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
            <div><h3 className="text-sm font-medium">Dein Excel-Backup</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Umsätze, Planung und Einstellungen in einer Datei. Vor dem Wiederherstellen prüfst du die Vorschau.</p></div>
          </div>
          <FinancialData><ExcelActions compact /></FinancialData>
        </div>
        <AccountSyncTools manual />
      </SettingsSection>
    </div>
  </>;
}
