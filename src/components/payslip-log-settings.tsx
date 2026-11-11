"use client";

import { useEffect, useState } from "react";
import { Download, ScrollText, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { downloadPayslipLog, usePayslipLogStore } from "@/components/payslip-log";
import type { PayslipLogEntry, PayslipLogSource } from "@/lib/payslip-log";

const sourceLabel: Record<PayslipLogSource, string> = {
  upload: "Hochgeladen",
  import: "Import",
  drive: "Google Drive",
  "drive-background": "Drive · Hintergrund",
  recheck: "Erneut geprüft",
};
const timeFormat = new Intl.DateTimeFormat("de-AT", { dateStyle: "medium", timeStyle: "short" });

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
    </SettingsSection>
  );
}
