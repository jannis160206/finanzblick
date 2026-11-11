"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { BadgePercent } from "lucide-react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFinance } from "@/components/finance-provider";
import { payrollWholeMoney } from "@/components/payroll-presentation";
import { successBonusPercent } from "@/lib/payroll-analysis";
import { wageTaxCaption, wageTaxCredits } from "@/lib/wage-tax-at";

const percentText = (value: number) => value.toLocaleString("de-AT", { maximumFractionDigits: 2 });
function parsePercent(text: string) {
  const trimmed = text.trim();
  if (!/^\d{1,3}(?:[.,]\d{1,2})?$/.test(trimmed)) return undefined;
  const value = Number(trimmed.replace(",", "."));
  return value <= 500 ? value : undefined;
}

/** Assumptions of the salary forecast: the Successbonus and the Austrian wage tax it is taxed with. */
export function PayrollModelSettings() {
  const { state, update, storageError } = useFinance();
  const id = useId();
  const current = successBonusPercent(state.settings);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const year = Number(state.settings.asOf.slice(0, 4));
  const credits = useMemo(() => wageTaxCredits(state.payslips ?? [], year), [state.payslips, year]);
  const value = draft ?? percentText(current);
  const parsed = parsePercent(value);
  const changed = draft !== null && parsed !== undefined && parsed !== current;

  function save(event: FormEvent) {
    event.preventDefault();
    if (parsed === undefined) {
      setError("Bitte einen Wert zwischen 0 und 500 % eingeben, z. B. 138,5.");
      return;
    }
    update((latest) => ({ ...latest, settings: { ...latest.settings, successBonusPercent: parsed } }));
    setDraft(null);
    setError("");
    toast.success(parsed === 0 ? "Successbonus ausgeschaltet" : `Successbonus: ${percentText(parsed)} % des Grundgehalts`);
  }

  const facts: [string, string][] = [
    ["Lohnsteuer", wageTaxCaption(year)],
    ["Absetzbeträge", `${credits.label} · ${payrollWholeMoney(credits.annual)} pro Jahr${credits.source === "payslip" ? " lt. Abrechnung" : ""}`],
    ["Sonderzahlungen", "620 € steuerfrei, 6 % im Jahressechstel, darüber nach Tarif"],
  ];
  return (
    <SettingsSection id="gehaltsmodell" title="Gehaltsmodell" icon={BadgePercent}
      description="Annahmen für Gehaltsprognose und Budget. Sobald die Abrechnung vorliegt, gelten ihre Werte.">
      <div className="space-y-4">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={save} noValidate>
          <div className="min-w-0 flex-1 space-y-1.5">
            <label htmlFor={`${id}-bonus`} className="block text-sm font-medium">Successbonus</label>
            <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
              Kommt mit dem Dezember-Lohn und wird im Jänner ausgezahlt – in % des Brutto-Grundgehalts. 0 schaltet ihn ab.
            </p>
            <div className="relative mt-2 w-36">
              <Input id={`${id}-bonus`} inputMode="decimal" autoComplete="off" value={value} disabled={!!storageError}
                aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} aria-invalid={error ? true : undefined}
                className="pr-8 text-right tabular-nums"
                onChange={(event) => { setDraft(event.target.value); setError(""); }} />
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <div className="flex gap-2">
            {draft !== null && (
              <Button type="button" variant="ghost" onClick={() => { setDraft(null); setError(""); }}>Abbrechen</Button>
            )}
            <Button type="submit" disabled={!changed || !!storageError}>Speichern</Button>
          </div>
        </form>
        {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
        <dl aria-label="Steuerlogik der Prognose"
          className="grid gap-x-4 gap-y-1.5 rounded-2xl border border-border/70 bg-background/40 px-4 py-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
          {facts.map(([label, text]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere] max-sm:mb-1">{text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </SettingsSection>
  );
}
