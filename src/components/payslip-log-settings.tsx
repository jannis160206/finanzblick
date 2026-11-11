"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, ScrollText, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { ToggleRow } from "@/components/ui/premium-dialog";
import { useFinance } from "@/components/finance-provider";
import { downloadPayslipLog, usePayslipLogStore } from "@/components/payslip-log";
import { currency } from "@/lib/format";
import { payrollProfile } from "@/lib/payroll-pattern";
import type { PayslipLogEntry, PayslipLogSource } from "@/lib/payslip-log";

const sourceLabel: Record<PayslipLogSource, string> = {
  upload: "Hochgeladen",
  import: "Import",
  drive: "Google Drive",
  "drive-background": "Drive · Hintergrund",
  recheck: "Erneut geprüft",
  budget: "Budget automatisch",
};
const timeFormat = new Intl.DateTimeFormat("de-AT", { dateStyle: "medium", timeStyle: "short" });
const monthFormat = new Intl.DateTimeFormat("de-AT", { month: "short", timeZone: "UTC" });
const months = (list: number[]) => list.map((month) => monthFormat.format(new Date(Date.UTC(2026, month - 1, 15)))).join(", ");

/** What Finanzblick learned from the own payslips and uses for checks and the forecast. */
function LearnedProfile() {
  const { state } = useFinance();
  const payslips = state.payslips;
  const profile = useMemo(() => {
    const latest = (payslips ?? []).reduce<(NonNullable<typeof payslips>)[number] | undefined>((last, entry) =>
      !last || entry.year * 12 + entry.month > last.year * 12 + last.month ? entry : last, undefined);
    return latest ? payrollProfile(payslips ?? [], latest.employer) : undefined;
  }, [payslips]);
  if (!profile?.payslips) return null;
  const rates = Object.entries(profile.onCallByYear).sort(([a], [b]) => Number(b) - Number(a));
  const facts: [string, string][] = [
    ["Rufbereitschaft", rates.length ? rates.map(([year, rate]) => `${currency(rate)} (${year})`).join(" · ") : "keine feste Pauschale erkannt"],
    ["Feiertagsdienste", profile.holidayMonths.length ? months(profile.holidayMonths) : "keine erkannt"],
    ["Sonderzahlungen", profile.specialMonths.length
      ? `${months(profile.specialMonths)}${profile.specialRatio ? ` · ${Math.round(profile.specialRatio * 100)} % des Grundgehalts` : ""}` : "noch keine"],
    ...(profile.bonusMonths.length ? [["Prämien", months(profile.bonusMonths)] as [string, string]] : []),
    ["Auszahlung", profile.advance ? "Akonto + Restzahlung" : "eine Überweisung"],
  ];
  return (
    <section aria-label="Gelernt aus deinen Abrechnungen" className="rounded-2xl border border-border/70 bg-background/40 px-4 py-3">
      <h3 className="text-xs font-medium text-muted-foreground">
        Gelernt aus {profile.payslips} Abrechnungen ({profile.years.length > 1 ? `${profile.years[0]}–${profile.years.at(-1)}` : profile.years[0]})
      </h3>
      <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere] max-sm:mb-1">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Off by default: unclear terms are explained by the local glossary; only with consent the term goes to Wikipedia. */
function TermLookupToggle() {
  const { state, update, storageError } = useFinance();
  return (
    <ToggleRow
      checked={state.settings.payslipTermLookup === true}
      disabled={!!storageError}
      onCheckedChange={(checked) => update((current) => ({ ...current, settings: { ...current.settings, payslipTermLookup: checked } }))}
      label="Unklare Begriffe online nachschlagen"
      description="Nur wenn das lokale Glossar nicht reicht (z. B. „VEB-Prämie“): der Begriff allein – nie Beträge oder Namen – geht an die deutschsprachige Wikipedia. Ergebnis im Protokoll."
    />
  );
}

/** Every payslip import as structured JSON for troubleshooting; the payroll page only shows a short summary. */
export function PayslipLogSettings() {
  const store = usePayslipLogStore();
  const [entries, setEntries] = useState<PayslipLogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    store.read().then(
      (log) => { if (active) { setEntries(log); setFailed(false); } },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [store]);

  async function clear() {
    setBusy(true);
    try {
      await store.clear();
      setEntries([]);
      toast.success("Import-Protokoll geleert");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Protokoll konnte nicht geleert werden.");
    } finally {
      setBusy(false);
    }
  }

  const recent = (entries ?? []).slice(-3).reverse();
  return (
    <SettingsSection id="import-protokoll" title="Import-Protokoll" icon={ScrollText}
      description={store.scope === "account" ? "Ergebnisse jedes Abrechnungs-Imports als JSON – gespeichert auf deinem Server." : "Ergebnisse jedes Abrechnungs-Imports als JSON – nur in diesem Browser."}>
      <div className="space-y-4">
      <LearnedProfile />
      <TermLookupToggle />
      {failed ? (
        <p className="text-sm text-muted-foreground">Protokoll nicht erreichbar.</p>
      ) : !entries ? (
        <div role="status" className="h-12 rounded-2xl bg-muted/60 motion-safe:animate-pulse"><span className="sr-only">Wird geladen …</span></div>
      ) : (
        <div className="space-y-4">
          {recent.length ? (
            <ol aria-label="Letzte Importe" className="divide-y divide-border/70 rounded-2xl border border-border/70 bg-background/40">
              {recent.map((entry) => (
                <li key={`${entry.at}-${entry.source}`} className="min-w-0 px-4 py-2.5">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{sourceLabel[entry.source]}</span>
                    <time dateTime={new Date(entry.at).toISOString()}>{timeFormat.format(entry.at)}</time>
                  </p>
                  <p className="mt-0.5 truncate text-sm" title={entry.message}>{entry.message}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">Noch keine Importe protokolliert.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!entries.length} onClick={() => downloadPayslipLog(entries)}>
              <Download aria-hidden="true" />JSON herunterladen{entries.length ? ` (${entries.length})` : ""}
            </Button>
            <Button variant="ghost" size="sm" disabled={!entries.length || busy} onClick={() => { void clear(); }}>
              <Trash2 aria-hidden="true" />Leeren
            </Button>
          </div>
        </div>
      )}
      </div>
    </SettingsSection>
  );
}
