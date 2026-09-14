"use client";

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFinance } from "@/components/finance-provider";
import { PageHeading, SectionHeading } from "@/components/finance-ui";
import { useSeasonalTheme } from "@/components/seasonal-theme-provider";
import { AppearanceControls } from "@/components/appearance-controls";
import { SavingsGoals } from "@/components/savings-goals";
import { ExcelActions } from "@/components/excel-actions";
import { latestTRBalance } from "@/lib/calc";
import { seasonalPreferenceSchema, trBalanceSchema } from "@/lib/types";
import { defaultSeasonalPreference, seasonalThemes, seasonalLabels, type SeasonalPreference, type SeasonalTheme } from "@/lib/seasonal-theme";

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
  return <section id="tr-zinsen" className="panel p-4" aria-label="Trade Republic">
    <SectionHeading title="Trade Republic" subtitle="Kontostand und jährlicher Zinssatz ab dem angegebenen Datum." />
    <form className="space-y-3" onSubmit={(event) => {
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
        <label className="text-xs">Kontostand (€)<Input aria-label="TR Kontostand" className="editable mt-1" type="number" min="0" max="1000000000" step="0.01" value={value.balance} onChange={(event) => setDraft({ ...value, balance: event.target.value })} required /></label>
        <label className="text-xs">Datum<Input aria-label="TR Standdatum" className="editable mt-1" type="date" max={state.settings.asOf} value={value.date} onChange={(event) => setDraft({ ...value, date: event.target.value })} required /></label>
        <label className="text-xs">Zinssatz p.a.<Input aria-label="Zinssatz p.a." className="editable mt-1" type="number" min="0" max="100" step="0.01" value={value.rate} onChange={(event) => setDraft({ ...value, rate: event.target.value })} required /></label>
      </div>
      {dirty && <div className="flex justify-end gap-2"><Button variant="outline" type="button" size="sm" onClick={() => setDraft(null)}>Abbrechen</Button><Button type="submit" size="sm" disabled={!valid}>Trade Republic speichern</Button></div>}
    </form>
  </section>;
}

export function Settings() {
  const { state, update } = useFinance();
  const { setPreview, testTheme, setTestTheme } = useSeasonalTheme();
  const [draft, setDraft] = useState<SeasonalPreference | null>(null);
  const saved = state.seasonalTheme ?? defaultSeasonalPreference;
  const value = draft ?? saved;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => () => { setPreview(null); setTestTheme(null); }, [setPreview, setTestTheme]);
  return <>
    <PageHeading eyebrow="KONFIGURATION" title="Einstellungen" description="Erscheinungsbild, Sparziele und Trade Republic." />
    <div className="space-y-4">
      <section id="jahreszeit" className="panel p-4" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading" className="mb-4 text-sm font-semibold">Erscheinungsbild</h2>
        <form onSubmit={(event) => {
          event.preventDefault(); const parsed = seasonalPreferenceSchema.safeParse(value); if (!parsed.success) return;
          update((current) => ({ ...current, seasonalTheme: parsed.data }));
          setDraft(null); setPreview(null); toast.success("Einstellungen gespeichert");
        }}>
          <AppearanceControls value={value} inputRef={null} onBlur={() => {}} onChange={(next) => { setDraft(next); setPreview(next); }} />
          {dirty && <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(null); setPreview(null); }}>Verwerfen</Button>
            <Button type="submit" size="sm"><Save className="size-4" />Einstellungen speichern</Button>
          </div>}
        </form>
        <details className="mt-4 border-t pt-3 text-xs" onToggle={(event) => { if (!event.currentTarget.open) setTestTheme(null); }}>
          <summary className="cursor-pointer text-muted-foreground">Saisonvorschau</summary>
          <label className="mt-3 flex flex-wrap items-center gap-3">Vorschau
            <select aria-label="Saisonvorschau" className="rounded border bg-card p-2" value={testTheme ?? ""} onChange={(event) => setTestTheme((event.target.value || null) as SeasonalTheme | null)}>
              <option value="">Aktueller Kalender</option>
              {seasonalThemes.map((theme) => <option key={theme} value={theme}>{seasonalLabels[theme]}</option>)}
            </select>
          </label>
          <p className="mt-2 text-muted-foreground">Nur ansehen – wird nicht gespeichert.</p>
        </details>
      </section>
      <SavingsGoals />
      <TradeRepublicSettings />
      <section className="panel flex flex-wrap items-center justify-between gap-3 p-4" aria-label="Sicherung">
        <h2 className="text-sm font-semibold">Sicherung</h2>
        <ExcelActions compact />
      </section>
    </div>
  </>;
}
