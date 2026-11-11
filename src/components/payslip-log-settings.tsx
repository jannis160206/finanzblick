"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Download, ScrollText, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleRow } from "@/components/ui/premium-dialog";
import { useFinance } from "@/components/finance-provider";
import { downloadPayslipLog, usePayslipLogStore } from "@/components/payslip-log";
import type { PayslipLogEntry, PayslipLogSource } from "@/lib/payslip-log";
import { cn } from "@/lib/utils";

const SHOWN = 8;
const sourceLabel: Record<PayslipLogSource, string> = {
  upload: "Hochgeladen",
  import: "Import",
  drive: "Google Drive",
  "drive-background": "Google Drive · automatisch",
  recheck: "Erneut geprüft",
  budget: "Budget",
};
type Outcome = NonNullable<PayslipLogEntry["files"]>[number]["outcome"];
const outcomeText: Record<Outcome, [string, string]> = {
  imported: ["übernommen", "übernommen"],
  waiting: ["wartet", "warten"],
  skipped: ["übersprungen", "übersprungen"],
  failed: ["fehlgeschlagen", "fehlgeschlagen"],
};
const outcomeDot: Record<Outcome, string> = {
  imported: "bg-success",
  waiting: "bg-info",
  skipped: "bg-muted-foreground/50",
  failed: "bg-destructive",
};
type Status = { label: string; variant: "success" | "warning" | "destructive" | "info" };
const timeFormat = new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("de-AT", { weekday: "short", day: "numeric", month: "short" });

function dayLabel(at: number, now = new Date()) {
  const day = new Date(at);
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(now) - start(day)) / 86_400_000);
  return days === 0 ? "Heute" : days === 1 ? "Gestern" : dayFormat.format(day);
}

const count = (entry: PayslipLogEntry, outcome: Outcome) => (entry.files ?? []).filter((file) => file.outcome === outcome).length;
const held = (entry: PayslipLogEntry) => entry.budget?.held?.length ?? entry.validation?.filter((item) => item.held).length ?? 0;

/** One clear state per run instead of the raw message. */
function status(entry: PayslipLogEntry): Status {
  if (entry.source === "budget") return { label: "Aktualisiert", variant: "info" };
  const failed = count(entry, "failed");
  if (failed && !count(entry, "imported")) return { label: "Fehler", variant: "destructive" };
  if (failed) return { label: "Teilweise", variant: "warning" };
  if (held(entry)) return { label: "Zur Prüfung", variant: "warning" };
  if (count(entry, "waiting")) return { label: "Wartet", variant: "info" };
  return { label: "Erledigt", variant: "success" };
}

/** "21 übernommen · 1 fehlgeschlagen" instead of the technical message. */
function summary(entry: PayslipLogEntry) {
  if (entry.source === "budget") return entry.message.replace(/^Budget aus Abrechnungen aktualisiert\s*·\s*/, "").replace(/^(\d+) Werte?/, "$1 Werte übernommen");
  if (!entry.files?.length) return entry.message;
  const parts = (["imported", "waiting", "skipped", "failed"] as const).flatMap((outcome) => {
    const amount = count(entry, outcome);
    return amount ? [`${amount} ${outcomeText[outcome][amount === 1 ? 0 : 1]}`] : [];
  });
  const review = held(entry);
  return [...parts, ...(review ? [`${review} zur Prüfung`] : [])].join(" · ");
}

function LogEntry({ entry }: { entry: PayslipLogEntry }) {
  const state = status(entry);
  const files = [...(entry.files ?? [])].sort((a, b) =>
    (["failed", "waiting", "skipped", "imported"] as const).indexOf(a.outcome) - (["failed", "waiting", "skipped", "imported"] as const).indexOf(b.outcome));
  return (
    <li className="py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{sourceLabel[entry.source]}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <time dateTime={new Date(entry.at).toISOString()} className="tabular-nums">{timeFormat.format(entry.at)}</time>
            {" · "}{summary(entry)}
          </p>
        </div>
        <Badge variant={state.variant} className="shrink-0">{state.label}</Badge>
      </div>
      {files.length > 0 && (
        <details className="group mt-1.5">
          <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-fine:min-h-6 [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className="size-3.5 transition-transform duration-150 group-open:rotate-90" />
            {files.length === 1 ? "1 Datei" : `${files.length} Dateien`}
          </summary>
          <ul className="mt-1 space-y-1.5 border-l border-border/70 pl-3">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="flex min-w-0 items-baseline gap-2 text-xs">
                <span aria-hidden="true" className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", outcomeDot[file.outcome])} />
                <span className="min-w-0">
                  <span className="block truncate" title={file.name}>{file.name}</span>
                  <span className="block text-muted-foreground">
                    <span className="sr-only">{outcomeText[file.outcome][0]}: </span>{file.note ?? outcomeText[file.outcome][0]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** Off by default: unclear terms are explained by the local glossary; only with consent the term goes to Wikipedia. */
function TermLookupToggle() {
  const { state, update, storageError } = useFinance();
  return (
    <ToggleRow
      className="rounded-none border-0 bg-transparent px-0 py-0"
      checked={state.settings.payslipTermLookup === true}
      disabled={!!storageError}
      onCheckedChange={(checked) => update((current) => ({ ...current, settings: { ...current.settings, payslipTermLookup: checked } }))}
      label="Unbekannte Begriffe online nachschlagen"
      description="Nur der Begriff geht an Wikipedia."
    />
  );
}

/** What happened when payslips were read, grouped by day; every detail stays in the JSON download. */
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

  const recent = (entries ?? []).slice(-SHOWN).reverse();
  const days = recent.reduce<{ label: string; entries: PayslipLogEntry[] }[]>((groups, entry) => {
    const label = dayLabel(entry.at);
    const group = groups.at(-1);
    if (group?.label === label) group.entries.push(entry);
    else groups.push({ label, entries: [entry] });
    return groups;
  }, []);
  const where = store.scope === "account" ? "auf deinem Server" : "nur in diesem Browser";
  return (
    <SettingsSection id="import-protokoll" title="Import-Protokoll" icon={ScrollText}
      description={`Was beim Einlesen von Abrechnungen passiert ist. Hinweise und gelesene Werte stehen vollständig im JSON (gespeichert ${where}).`}>
      <div className="space-y-5">
        {failed ? (
          <p className="text-sm text-muted-foreground">Protokoll nicht erreichbar.</p>
        ) : !entries ? (
          <div role="status" className="h-12 rounded-2xl bg-muted/60 motion-safe:animate-pulse"><span className="sr-only">Wird geladen …</span></div>
        ) : recent.length ? (
          <div className="space-y-4">
            {days.map((day) => (
              <section key={day.label} aria-label={day.label}>
                <h3 className="text-xs font-medium text-muted-foreground">{day.label}</h3>
                <ul className="divide-y divide-border/60">
                  {day.entries.map((entry) => <LogEntry key={`${entry.at}-${entry.source}`} entry={entry} />)}
                </ul>
              </section>
            ))}
            {entries.length > SHOWN && <p className="text-xs text-muted-foreground">Ältere Einträge im JSON.</p>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Noch keine Importe.</p>
        )}
        {entries && !failed && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!entries.length} onClick={() => downloadPayslipLog(entries)}>
              <Download aria-hidden="true" />JSON herunterladen
            </Button>
            <Button variant="ghost" size="sm" disabled={!entries.length || busy} onClick={() => { void clear(); }}>
              <Trash2 aria-hidden="true" />Leeren
            </Button>
          </div>
        )}
        <div className="border-t border-border/60 pt-4">
          <TermLookupToggle />
        </div>
      </div>
    </SettingsSection>
  );
}
