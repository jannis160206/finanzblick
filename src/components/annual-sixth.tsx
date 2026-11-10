"use client";

import { useState } from "react";
import { Calculator } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { SectionHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { DialogStep, DialogSteps, Field, MoneyField, PremiumDialogContent, PremiumDialogHeader, moneyText, moneyValue } from "@/components/ui/premium-dialog";
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
    regularGross: saved ? moneyText(saved.regularGross) : "",
    specialGross: saved ? moneyText(saved.specialGross) : "",
    plannedSpecialGross: moneyText(saved?.plannedSpecialGross ?? 0),
    reportedSixth: moneyText(saved?.reportedSixth),
    monthlyPayroll: saved?.monthlyPayroll ?? false,
  }));
  const amount = (text: string) => text.trim() === "" ? NaN : moneyValue(text) ?? NaN;
  const parsed = annualSixthSchema.safeParse({
    year, month: Number(value.month), employer: value.employer,
    regularGross: amount(value.regularGross), specialGross: amount(value.specialGross),
    plannedSpecialGross: amount(value.plannedSpecialGross),
    ...(value.reportedSixth.trim() ? { reportedSixth: amount(value.reportedSixth) } : {}),
    monthlyPayroll: value.monthlyPayroll,
  });
  const change = (key: Exclude<keyof typeof value, "monthlyPayroll">, next: string) => setValue({ ...value, [key]: next });
  const hint = parsed.success ? undefined : parsed.error.issues.find((issue) => issue.code === "custom")?.message ??
    "Bruttobeträge mit höchstens zwei Nachkommastellen eingeben; geplante Zahlung ggf. 0.";
  const money = (key: "regularGross" | "specialGross" | "plannedSpecialGross" | "reportedSixth", label: string, caption: string, optional = false) => (
    <Field label={caption} optional={optional}>
      <MoneyField aria-label={label} value={value[key]} onValueChange={(next) => change(key, next)} />
    </Field>
  );
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <PremiumDialogContent size="md">
      <PremiumDialogHeader title={`Jahressechstel ${year}: Bruttowerte`}
        description="Bruttowerte aus der Lohnabrechnung, keine Netto-Kontoeingänge. Ein Dienstverhältnis, kumuliert bis einschließlich des gewählten Monats." />
      <DialogSteps mode="auto" submitLabel="Bruttowerte speichern" submitDisabled={!parsed.success || !!storageError}
        message={storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
        onComplete={() => {
          if (!parsed.success) { toast.error("Bruttowerte und Berechnungsgrundlage prüfen."); return; }
          if (storageError) { toast.error(storageError); return; }
          const entry = parsed.data;
          update((current) => ({ ...current,
            annualSixth: [...(current.annualSixth ?? []).filter((item) => item.year !== year), entry].sort((a, b) => a.year - b.year),
          }));
          onClose();
          toast.success("Jahressechstel-Grundlage gespeichert");
        }}>
        <DialogStep id="basis" title="Abrechnung">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Arbeitgeber" optional>
              <Input aria-label="Arbeitgeber" maxLength={120} value={value.employer} onChange={(event) => change("employer", event.target.value)} />
            </Field>
            <Field label="Abrechnungsmonat">
              <select className="select-input w-full" aria-label="Abrechnungsmonat" value={value.month} onChange={(event) => change("month", event.target.value)}>
                {Array.from({ length: 12 }, (_, index) => <option key={index} value={index + 1}>{monthLabel(`${year}-${String(index + 1).padStart(2, "0")}`)}</option>)}
              </select>
            </Field>
          </div>
          <label className="flex items-start gap-3 rounded-2xl border border-border/70 p-4 text-sm">
            <input type="checkbox" className="mt-1 size-4 accent-primary" checked={value.monthlyPayroll}
              onChange={(event) => setValue({ ...value, monthlyPayroll: event.target.checked })} />
            <span>Monatliche Standardabrechnung bestätigt, keine ungeklärten Sonderfälle.</span>
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">Kalendermonate seit Jänner zählen auch bei späterem Eintritt. Abrechnungsmonat und kumuliertes Brutto müssen zusammenpassen. Bei untermonatigem Austritt, tagesweiser Abrechnung, ungeklärten Vorbezügen oder anderen Sonderfällen den Abrechnungswert übernehmen; dieser hat Vorrang. BUAG/Jahreszwölftel wird nicht berechnet.</p>
        </DialogStep>
        <DialogStep id="gross" title="Bruttowerte">
          <div className="grid gap-5 sm:grid-cols-2">
            {money("regularGross", "Laufendes Brutto seit Jänner", "Laufendes Brutto seit Jänner")}
            {money("specialGross", "Sonderzahlungen brutto bisher", "Sechstelrelevante Sonderzahlungen bisher")}
            {money("plannedSpecialGross", "Geplante Sonderzahlung brutto", "Geplante zusätzliche Sonderzahlung")}
            {money("reportedSixth", "Jahressechstel laut Abrechnung", "Jahressechstel laut Abrechnung", true)}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">Brutto vor SV. Laufende Bezüge nur laut Sechstelbasis, ohne Sonderzahlungen oder steuerfreie Reisekosten; steuerpflichtiges Brutto kann abweichen. Sonderzahlungen nur nach § 67 Abs. 1/2 EStG, einschließlich tarifversteuerter Überhänge, ohne Abfertigungen oder anders geregelte Zahlungen. Ohne bisherige/geplante Sonderzahlung: jeweils 0.</p>
          {hint && <p role="status" className="text-xs text-muted-foreground">{hint}</p>}
        </DialogStep>
      </DialogSteps>
    </PremiumDialogContent>
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
      : "Sonderzahlungen auf Bruttobasis"} />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <select className="select-input" aria-label="Jahressechstel Jahr" value={year} onChange={(event) => setYear(event.target.value === "2027" ? 2027 : 2026)}>
          <option value={2026}>2026</option><option value={2027}>2027</option>
        </select>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Calculator className="size-4" />{entry ? "Bruttowerte bearbeiten" : "Bruttowerte erfassen"}</Button>
      </div>
    </div>
    {future && <p className="mb-3 text-xs text-muted-foreground">Vorausschau: Abrechnungsmonat nach Dashboard-Stichtag.</p>}
    {entry && result ? <>
      <div className="grid gap-4 sm:grid-cols-3">
        <div><p className="text-xs text-muted-foreground">Jahressechstel · {result.source === "reported" ? "laut Abrechnung" : "Hochrechnung"}</p><p className="mt-1 text-xl font-semibold tabular-nums">{currency(result.sixth)}</p></div>
        <div><p className="text-xs text-muted-foreground">Sonderzahlungen bisher · brutto</p><p className="mt-1 text-xl font-semibold tabular-nums">{currency(entry.specialGross)}</p></div>
        <div><p className="text-xs text-muted-foreground">{result.overhang > 0 ? "Rechnerischer Überhang" : "Rechnerischer Rest"}</p><p className={cn("mt-1 text-xl font-semibold tabular-nums", result.overhang > 0 && "text-destructive")}>{currency(result.overhang || result.remaining)}</p></div>
      </div>
      <p className="mt-4 text-sm">{result.overhang > 0
        ? "Jahressechstel überschritten. Überhänge unterliegen grundsätzlich dem Tarif; frühere Versteuerungen und Aufrollungen sind nicht nachgerechnet."
        : result.remaining === 0 ? "Das aktuelle Jahressechstel ist ausgeschöpft."
          : "Sonderzahlungen innerhalb des aktuellen Jahressechstels – nicht generell steuerfrei."}</p>
      {entry.plannedSpecialGross > 0 && <p className={cn("mt-2 text-sm", result.plannedOverhang > 0 && "text-destructive")}>
        Mit zusätzlich {currency(entry.plannedSpecialGross)}: {result.plannedOverhang > 0
          ? `${currency(result.plannedOverhang)} rechnerischer Überhang bei unverändertem Jahressechstel.`
          : `${currency(result.plannedRemaining)} rechnerisch noch frei bei unverändertem Jahressechstel.`}
      </p>}
      <p className="mt-2 text-xs text-muted-foreground">Kein zugesicherter Sechstelrest. Nach früheren Überhängen oder Korrekturen zählt der Rest laut Lohnverrechnung.</p>
      {result.controlSixth !== undefined && <p className="mt-2 text-sm">Rechnerisches Kontrollsechstel (laufendes Jahresbrutto / 6): {currency(result.controlSixth)}. Eine Aufrollung bei der letzten laufenden Jahreszahlung hängt von bisheriger Besteuerung und gesetzlichen Ausnahmen ab.</p>}
    </> : <p className="text-sm text-muted-foreground">Bruttowerte fehlen: Kontoeingänge sind Nettozahlungen. Nötig sind laufendes Brutto und sechstelrelevante Sonderzahlungen aus der Lohnabrechnung.</p>}
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
