"use client";

import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { BadgePercent } from "lucide-react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { useFinance } from "@/components/finance-provider";
import { payrollWholeMoney } from "@/components/payroll-presentation";
import { currency } from "@/lib/format";
import { successBonusPercent } from "@/lib/payroll-analysis";
import { payrollProfile } from "@/lib/payroll-pattern";
import type { Payslip } from "@/lib/payslip-schema";
import { wageTaxCredits, wageTaxYear } from "@/lib/wage-tax-at";

const percentText = (value: number) => value.toLocaleString("de-AT", { maximumFractionDigits: 2 });
const monthFormat = new Intl.DateTimeFormat("de-AT", { month: "short", timeZone: "UTC" });
const months = (list: number[]) => list.map((month) => monthFormat.format(new Date(Date.UTC(2026, month - 1, 15)))).join(", ");
const order = (entry: Payslip) => entry.year * 12 + entry.month;

function parsePercent(text: string) {
  const trimmed = text.trim().replace(/\s*%$/, "");
  if (!/^\d{1,3}(?:[.,]\d{1,2})?$/.test(trimmed)) return undefined;
  const value = Number(trimmed.replace(",", "."));
  return value <= 500 ? value : undefined;
}

/** A value with a short muted addition, e.g. "300,00 €" and "im Monat". */
function Value({ main, note }: { main: string; note?: string }) {
  return <>{main}{note && <span className="font-normal text-muted-foreground"> {note}</span>}</>;
}

/** Label/value rows separated by hairlines: scannable without boxes or long sentences. */
function FactList({ title, tip, rows }: { title: string; tip: ReactNode; rows: [string, ReactNode][] }) {
  return (
    <section aria-label={title}>
      <div className="flex items-center gap-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <InfoTip label={title}>{tip}</InfoTip>
      </div>
      <dl className="mt-1 divide-y divide-border/60">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-right font-medium [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SuccessBonus({ base }: { base?: number }) {
  const { state, update, storageError } = useFinance();
  const id = useId();
  const current = successBonusPercent(state.settings);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const value = draft ?? percentText(current);
  const parsed = parsePercent(value);
  const dirty = draft !== null && parsed !== current;
  const shown = parsed ?? current;

  function save(event: FormEvent) {
    event.preventDefault();
    if (parsed === undefined) {
      setError("Bitte 0 bis 500 % eingeben, z. B. 138,5.");
      return;
    }
    update((latest) => ({ ...latest, settings: { ...latest.settings, successBonusPercent: parsed } }));
    setDraft(null);
    setError("");
    toast.success(parsed === 0 ? "Successbonus ausgeschaltet" : `Successbonus: ${percentText(parsed)} % des Grundgehalts`);
  }

  return (
    <form className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3" onSubmit={save} noValidate>
      <div className="min-w-0 flex-1 basis-52">
        <label htmlFor={`${id}-bonus`} className="block text-sm font-medium">Successbonus</label>
        <p id={`${id}-hint`} className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          Kommt mit dem Dezember-Lohn, ausgezahlt im Jänner.
          {base && shown > 0 ? <span className="block tabular-nums">≈ {payrollWholeMoney(base * shown / 100)} brutto bei aktuellem Grundgehalt</span> : null}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative w-28">
          <Input id={`${id}-bonus`} inputMode="decimal" autoComplete="off" value={value} disabled={!!storageError}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} aria-invalid={error ? true : undefined}
            className="pr-8 text-right tabular-nums"
            onChange={(event) => { setDraft(event.target.value); setError(""); }}
            onKeyDown={(event) => { if (event.key === "Escape") { setDraft(null); setError(""); } }} />
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">%</span>
        </div>
        {dirty && <Button type="submit" disabled={!!storageError}>Speichern</Button>}
      </div>
      {error && <p id={`${id}-error`} role="alert" className="w-full text-sm text-destructive">{error}</p>}
    </form>
  );
}

/** Assumptions of the salary forecast: the Successbonus, what Finanzblick learned from the payslips, and the tax logic. */
export function PayrollModelSettings() {
  const { state } = useFinance();
  const payslips = state.payslips;
  const year = Number(state.settings.asOf.slice(0, 4));
  const latest = useMemo(() => (payslips ?? []).reduce<Payslip | undefined>((last, entry) =>
    !last || order(entry) > order(last) ? entry : last, undefined), [payslips]);
  const profile = useMemo(() => latest ? payrollProfile(payslips ?? [], latest.employer) : undefined, [payslips, latest]);
  const credits = useMemo(() => wageTaxCredits(payslips ?? [], year), [payslips, year]);
  const base = useMemo(() => [...(payslips ?? [])].sort((a, b) => order(b) - order(a)).find((entry) => entry.baseSalary)?.baseSalary, [payslips]);

  const rates = Object.entries(profile?.onCallByYear ?? {}).sort(([a], [b]) => Number(b) - Number(a));
  const ratio = profile?.specialRatio;
  const learned: [string, ReactNode][] = profile?.payslips ? [
    ["Rufbereitschaft", rates.length ? <Value main={currency(rates[0][1])} note={`im Monat · ${rates[0][0]}`} /> : <Value main="keine Pauschale" />],
    ["Feiertagsdienste", profile.holidayMonths.length ? months(profile.holidayMonths) : <Value main="keine" />],
    ["Sonderzahlungen", profile.specialMonths.length
      ? <Value main={months(profile.specialMonths)} note={ratio ? `· ${ratio === 1 ? "je 1 Grundgehalt" : `je ${Math.round(ratio * 100)} % Grundgehalt`}` : undefined} />
      : <Value main="noch keine" />],
    ...(profile.bonusMonths.length ? [["Prämien", months(profile.bonusMonths)] as [string, ReactNode]] : []),
    ["Auszahlung", profile.advance ? "Akonto + Rest" : "eine Überweisung"],
  ] : [];
  const span = profile?.years.length ? profile.years.length > 1 ? `${profile.years[0]}–${profile.years.at(-1)}` : String(profile.years[0]) : "";

  return (
    <SettingsSection id="gehaltsmodell" title="Gehaltsmodell" icon={BadgePercent}
      description="Annahmen für Gehaltsprognose und Budget. Sobald eine Abrechnung vorliegt, gelten ihre Werte. 0 % schaltet den Successbonus ab.">
      <div className="space-y-6">
        <SuccessBonus base={base} />
        {learned.length > 0 && (
          <FactList title={`Gelernt aus ${profile!.payslips} Abrechnungen`} rows={learned}
            tip={`Aus ${span}. Finanzblick nutzt diese Muster für Prüfung und Prognose; neue Abrechnungen aktualisieren sie automatisch.`} />
        )}
        <FactList title="Steuer" rows={[
          ["Lohnsteuer", <Value key="tax" main={`Tarif AT ${wageTaxYear(year)}`} note="progressiv" />],
          ["Absetzbeträge", <Value key="credits" main={`${payrollWholeMoney(credits.annual)} im Jahr`} note={credits.label.startsWith("Absetzbeträge") ? undefined : credits.label} />],
          ["Sonderzahlungen", <Value key="special" main="6 %" note="im Jahressechstel · 620 € frei" />],
        ]} tip={<>
          Österreich kennt keine Steuerklassen. Die Lohnsteuer folgt dem progressiven Tarif (0–55 %) auf das hochgerechnete
          Monatsgehalt, abzüglich der Absetzbeträge {credits.source === "payslip" ? "aus deinen Abrechnungen" : "laut Gesetz"}.
          Sonderzahlungen: 620 € im Jahr frei, dann 6 % im Jahressechstel; was darüber liegt, wird wie laufendes Gehalt versteuert.
        </>} />
      </div>
    </SettingsSection>
  );
}
