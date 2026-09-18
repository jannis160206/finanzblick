"use client";

import { useState } from "react";
import { Calculator } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { SectionHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogForm, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { calculateAnnualSixth, annualSixthSources } from "@/lib/annual-sixth";
import { currency, monthLabel } from "@/lib/format";
import { annualSixthSchema, type AnnualSixth } from "@/lib/types";
import { cn } from "@/lib/utils";

function AnnualSixthForm({ year, saved, onClose }: {
  year: AnnualSixth["year"];
  saved?: AnnualSixth;
  onClose: () => void;
}) {
  const { state, update, storageError } = useFinance();
  const currentYear = Number(state.settings.asOf.slice(0, 4));
  const [value, setValue] = useState(() => ({
    month: String(saved?.month ?? (year === currentYear ? Number(state.settings.asOf.slice(5, 7)) : year < currentYear ? 12 : 1)),
    employer: saved?.employer ?? "",
    regularGross: saved ? String(saved.regularGross) : "",
    specialGross: saved ? String(saved.specialGross) : "",
    plannedSpecialGross: String(saved?.plannedSpecialGross ?? 0),
    reportedSixth: saved?.reportedSixth === undefined ? "" : String(saved.reportedSixth),
    monthlyPayroll: saved?.monthlyPayroll ?? false,
  }));
  const amount = (text: string) => text.trim() === "" ? NaN : Number(text);
  const parsed = annualSixthSchema.safeParse({
    year, month: Number(value.month), employer: value.employer,
    regularGross: amount(value.regularGross), specialGross: amount(value.specialGross),
    plannedSpecialGross: amount(value.plannedSpecialGross),
    ...(value.reportedSixth.trim() ? { reportedSixth: amount(value.reportedSixth) } : {}),
    monthlyPayroll: value.monthlyPayroll,
  });
  const change = (key: Exclude<keyof typeof value, "monthlyPayroll">, next: string) => setValue({ ...value, [key]: next });
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Jahressechstel {year}: Bruttowerte</DialogTitle>
        <DialogDescription>Werte aus der Lohnabrechnung für ein Dienstverhältnis, nicht aus den Netto-Kontoeingängen. Alle kumulierten Werte bis einschließlich des gewählten Monats.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={(event) => {
        event.preventDefault();
        if (!parsed.success) {
          toast.error("Bitte die Bruttowerte und Berechnungsgrundlage vollständig prüfen.");
          return;
        }
        if (storageError) { toast.error(storageError); return; }
        const entry = parsed.data;
        update((current) => ({ ...current,
          annualSixth: [...(current.annualSixth ?? []).filter((item) => item.year !== year), entry].sort((a, b) => a.year - b.year),
        }));
        onClose();
        toast.success("Jahressechstel-Grundlage gespeichert");
      }}>
        <DialogBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm">Arbeitgeber (optional)
              <Input aria-label="Arbeitgeber" maxLength={120} value={value.employer} onChange={(event) => change("employer", event.target.value)} />
            </label>
            <label className="space-y-2 text-sm">Abrechnungsmonat
              <select className="select-input w-full" aria-label="Abrechnungsmonat" value={value.month} onChange={(event) => change("month", event.target.value)}>
                {Array.from({ length: 12 }, (_, index) => <option key={index} value={index + 1}>{monthLabel(`${year}-${String(index + 1).padStart(2, "0")}`)}</option>)}
              </select>
            </label>
            <label className="space-y-2 text-sm">Laufendes Brutto seit Jänner (€)
              <Input aria-label="Laufendes Brutto seit Jänner" type="number" min="0" max="1000000000" step="0.01" required
                value={value.regularGross} onChange={(event) => change("regularGross", event.target.value)} />
            </label>
            <label className="space-y-2 text-sm">Sechstelrelevante Sonderzahlungen bisher (€)
              <Input aria-label="Sonderzahlungen brutto bisher" type="number" min="0" max="1000000000" step="0.01" required
                value={value.specialGross} onChange={(event) => change("specialGross", event.target.value)} />
            </label>
            <label className="space-y-2 text-sm">Geplante zusätzliche Sonderzahlung (€)
              <Input aria-label="Geplante Sonderzahlung brutto" type="number" min="0" max="1000000000" step="0.01" required
                value={value.plannedSpecialGross} onChange={(event) => change("plannedSpecialGross", event.target.value)} />
            </label>
            <label className="space-y-2 text-sm">Jahressechstel laut Abrechnung (€; optional)
              <Input aria-label="Jahressechstel laut Abrechnung" type="number" min="0" max="1000000000" step="0.01"
                value={value.reportedSixth} onChange={(event) => change("reportedSixth", event.target.value)} />
            </label>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">Brutto vor Abzug der Sozialversicherung. Nur sechstelrelevante laufende Bezüge laut Lohnverrechnung, ohne Sonderzahlungen oder steuerfreie Reisekosten; steuerpflichtiges Brutto allein kann ebenfalls abweichen. Bei den Sonderzahlungen nur Bezüge nach § 67 Abs. 1/2 EStG (z. B. Urlaubs-/Weihnachtsgeld), auch bereits tarifversteuerte Überhänge, keine Abfertigungen oder anders geregelten Zahlungen. Bei keiner bisherigen oder geplanten Sonderzahlung jeweils 0 eintragen.</p>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-1 size-4 accent-primary" checked={value.monthlyPayroll}
              onChange={(event) => setValue({ ...value, monthlyPayroll: event.target.checked })} />
            <span>Monatliche Standardabrechnung bestätigt, keine ungeklärten Sonderfälle.</span>
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">Es zählen immer die Kalendermonate seit Jänner, auch bei späterem Eintritt. Den bestätigten Abrechnungsmonat passend zum kumulierten Brutto wählen, nicht automatisch den heutigen Monat. Bei untermonatigem Austritt, tagesweiser Abrechnung, ungeklärten Vorbezügen oder sonstigen Sonderfällen den Abrechnungswert übernehmen; dieser hat Vorrang. BUAG/Jahreszwölftel wird hier nicht berechnet.</p>
          {!parsed.success && <p role="status" className="text-xs text-muted-foreground">{parsed.error.issues.find((issue) => issue.code === "custom")?.message ??
            "Zum Speichern sind gültige Bruttobeträge mit höchstens zwei Nachkommastellen und eine geplante Zahlung (ggf. 0) erforderlich."}</p>}
          {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button type="submit" disabled={!parsed.success || !!storageError}>Bruttowerte speichern</Button>
        </DialogFooter>
      </DialogForm>
    </DialogContent>
  </Dialog>;
}

export function AnnualSixthCard() {
  const { state } = useFinance();
  const [year, setYear] = useState<AnnualSixth["year"]>(state.settings.asOf.startsWith("2027") ? 2027 : 2026);
  const [editing, setEditing] = useState(false);
  const entry = state.annualSixth?.find((item) => item.year === year);
  const result = entry ? calculateAnnualSixth(entry) : undefined;
  const future = entry && `${year}-${String(entry.month).padStart(2, "0")}` > state.settings.asOf.slice(0, 7);
  return <section id="jahressechstel" className="panel mb-6 p-5 sm:p-6" aria-label="Jahressechstel Österreich">
    <div className="flex flex-wrap items-start justify-between gap-x-4">
    <SectionHeading title="Jahressechstel · Österreich" subtitle={entry
      ? `Abrechnungsstand ${monthLabel(`${year}-${String(entry.month).padStart(2, "0")}`)}${entry.employer ? ` · ${entry.employer}` : ""}`
      : "Sonderzahlungen anhand deiner Brutto-Lohnabrechnung einordnen"} />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <select className="select-input" aria-label="Jahressechstel Jahr" value={year} onChange={(event) => setYear(event.target.value === "2027" ? 2027 : 2026)}>
          <option value={2026}>2026</option><option value={2027}>2027</option>
        </select>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Calculator className="size-4" />{entry ? "Bruttowerte bearbeiten" : "Bruttowerte erfassen"}</Button>
      </div>
    </div>
    {future && <p className="mb-3 text-xs text-muted-foreground">Vorausschau: Dieser Abrechnungsmonat liegt nach dem Dashboard-Stichtag.</p>}
    {entry && result ? <>
      <div className="grid gap-4 sm:grid-cols-3">
        <div><p className="text-xs text-muted-foreground">Jahressechstel · {result.source === "reported" ? "laut Abrechnung" : "Hochrechnung"}</p><p className="mt-1 text-xl font-semibold tabular-nums">{currency(result.sixth)}</p></div>
        <div><p className="text-xs text-muted-foreground">Sonderzahlungen bisher · brutto</p><p className="mt-1 text-xl font-semibold tabular-nums">{currency(entry.specialGross)}</p></div>
        <div><p className="text-xs text-muted-foreground">{result.overhang > 0 ? "Rechnerischer Überhang" : "Rechnerischer Rest"}</p><p className={cn("mt-1 text-xl font-semibold tabular-nums", result.overhang > 0 && "text-destructive")}>{currency(result.overhang || result.remaining)}</p></div>
      </div>
      <p className="mt-4 text-sm">{result.overhang > 0
        ? "Die erfassten Sonderzahlungen überschreiten das aktuelle Jahressechstel. Überhänge unterliegen grundsätzlich dem Tarif; bereits erfolgte Versteuerungen oder Aufrollungen sind in diesem Vergleich nicht nachgerechnet."
        : result.remaining === 0 ? "Das aktuelle Jahressechstel ist ausgeschöpft."
          : "Die erfassten Sonderzahlungen liegen innerhalb des aktuellen Jahressechstels. Das ist keine generelle Steuerfreiheit."}</p>
      {entry.plannedSpecialGross > 0 && <p className={cn("mt-2 text-sm", result.plannedOverhang > 0 && "text-destructive")}>
        Mit zusätzlich {currency(entry.plannedSpecialGross)}: {result.plannedOverhang > 0
          ? `${currency(result.plannedOverhang)} rechnerischer Überhang bei unverändertem Jahressechstel.`
          : `${currency(result.plannedRemaining)} rechnerisch noch frei bei unverändertem Jahressechstel.`}
      </p>}
      <p className="mt-2 text-xs text-muted-foreground">Rechnerischer Vergleich, kein zugesicherter Sechstelrest für die nächste Auszahlung. Nach früheren Überhängen oder Korrekturen ist der tatsächliche Rest aus der Lohnverrechnung maßgeblich.</p>
      {result.controlSixth !== undefined && <p className="mt-2 text-sm">Rechnerisches Kontrollsechstel (laufendes Jahresbrutto / 6): {currency(result.controlSixth)}. Ob bei der letzten laufenden Jahreszahlung eine Aufrollung erforderlich ist, hängt von der bisherigen Besteuerung und gesetzlichen Ausnahmen ab.</p>}
    </> : <p className="text-sm text-muted-foreground">Noch keine belastbare Beurteilung: Die Kontoeingänge sind Nettozahlungen. Ohne laufendes Brutto und sechstelrelevante Sonderzahlungen aus der Lohnabrechnung lässt sich dein Jahressechstel nicht verlässlich bestimmen.</p>}
    <details className="mt-4 border-t pt-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer">Rechenweg und österreichische Steuerhinweise</summary>
      <div className="mt-3 space-y-2 leading-relaxed">
        <p>Bei regulärer monatlicher Abrechnung: sechstelrelevantes laufendes Brutto kumuliert / Kalendermonate seit Jänner bis zum Abrechnungsmonat × 2, einschließlich des laufenden Bezugs bei der Sonderzahlung. Auch bei Eintritt im Juli wird im September durch 9 geteilt, nicht durch 3. Sonderzahlungen erhöhen das Jahressechstel nicht. Es kann sich durch weitere laufende Bezüge ändern; der rechnerische Rest ist kein zugesichertes Jahresend-Budget.</p>
        <p>{result?.taxNote ?? "Das Jahressechstel begrenzt die begünstigte Besteuerung bestimmter Sonderzahlungen. Sozialversicherung, Freibetrag, Freigrenze und Tarifstaffeln sind davon getrennt zu betrachten."}</p>
        <p>Hier wird ein Abrechnungskontext je Jahr gespeichert. Gleichzeitige Dienstverhältnisse nicht zusammenzählen; bei Arbeitgeberwechsel nur von der Lohnverrechnung nachweislich übernommene Vorbezüge berücksichtigen. Sonderfälle (z. B. Elternkarenz, Krankengeldbezug oder Austritt), das Kontrollsechstel und die Veranlagung können abweichende Ergebnisse erfordern. Diese Übersicht berechnet keine endgültige Lohnsteuer und ersetzt keine individuelle Steuerberatung.</p>
        <p>Rechtsstand 18.09.2026: {annualSixthSources.map((source, index) => <span key={source.href}>{index > 0 && " · "}<a className="text-primary underline" href={source.href} target="_blank" rel="noreferrer">{source.label}</a></span>)}</p>
      </div>
    </details>
    {editing && <AnnualSixthForm key={year} year={year} saved={entry} onClose={() => setEditing(false)} />}
  </section>;
}
