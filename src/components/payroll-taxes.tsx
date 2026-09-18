"use client";

import { useState } from "react";
import { Calculator } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { AnnualSixthCard } from "@/components/annual-sixth";
import { PayslipImportPanel } from "@/components/payslip-import";
import { PageHeading, SectionHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogForm, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { analyzePayroll, payrollTaxSources } from "@/lib/payroll-analysis";
import { payrollEmployerKey, payrollForecastSchema, type Payslip, type PayrollForecast } from "@/lib/payslip-schema";
import { currency, monthLabel } from "@/lib/format";

const period = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
const money = (value: number | undefined) => value === undefined ? "Nicht belegt" : currency(value);

function ForecastEditor({ value, onClose }: { value: PayrollForecast; onClose: () => void }) {
  const { state, update, storageError } = useFinance();
  const relevantPayroll = JSON.stringify((state.payslips ?? []).filter((entry) => entry.year === value.year &&
    payrollEmployerKey(entry.employer) === payrollEmployerKey(value.employer)));
  const [initialPayroll] = useState(relevantPayroll);
  const [confirmed, setConfirmed] = useState(value.standardPayrollConfirmed);
  const [months, setMonths] = useState(() => value.months.map((month) => ({
    month: month.month, regularGross: String(month.regularGross), specialGross: String(month.specialGross),
    monthlyTaxableBase: month.monthlyTaxableBase === undefined ? "" : String(month.monthlyTaxableBase),
    specialSv: month.specialSv === undefined ? "" : String(month.specialSv),
  })));
  const number = (text: string) => text.trim() === "" ? NaN : Number(text);
  const parsed = payrollForecastSchema.safeParse({
    ...value, standardPayrollConfirmed: confirmed,
    months: months.map((month) => ({
      month: month.month, regularGross: number(month.regularGross), specialGross: number(month.specialGross),
      ...(month.monthlyTaxableBase.trim() ? { monthlyTaxableBase: number(month.monthlyTaxableBase) } : {}),
      ...(month.specialSv.trim() ? { specialSv: number(month.specialSv) } : {}),
    })),
  });
  function change(index: number, key: "regularGross" | "specialGross" | "monthlyTaxableBase" | "specialSv", text: string) {
    setMonths((current) => current.map((month, item) => item === index ? {
      ...month, [key]: text,
      ...(key === "regularGross" ? { monthlyTaxableBase: "" } : {}),
      ...(key === "specialGross" ? { specialSv: "" } : {}),
    } : month));
    setConfirmed(false);
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Prognoseannahmen {value.year}</DialogTitle>
        <DialogDescription>{value.employer}: Fehlende und zukünftige Monate sind Annahmen, keine ausbezahlten Bezüge. Neue Abrechnungen ersetzen die entsprechenden Prognosemonate.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={(event) => {
        event.preventDefault();
        if (!parsed.success) { toast.error("Bitte die Prognosebeträge prüfen."); return; }
        if (storageError) { toast.error(storageError); return; }
        if (relevantPayroll !== initialPayroll) {
          toast.error("Die Lohnabrechnungen wurden inzwischen geändert. Bitte die Prognose erneut öffnen.");
          return;
        }
        const forecast = parsed.data;
        update((state) => ({ ...state, payrollForecasts: [
          ...(state.payrollForecasts ?? []).filter((saved) => saved.year !== forecast.year ||
            payrollEmployerKey(saved.employer) !== payrollEmployerKey(forecast.employer)),
          forecast,
        ] }));
        onClose();
        toast.success("Prognoseannahmen lokal gespeichert");
      }}>
        <DialogBody className="space-y-4">
          <p className="text-xs leading-relaxed text-muted-foreground">Startvorschlag: gleichbleibende laufende Bezüge. Bei erkanntem Grundgehalt werden Juni und November mit je einem Grundgehalt vorgeschlagen – keine Zusage aus dem Kollektivvertrag. Beträge und Zahlungsmonate an deinen Vertrag anpassen. Änderungen am Brutto löschen die zugehörige Steuerbasis bzw. SV-Annahme, damit keine veraltete Steuerberechnung entsteht.</p>
          {months.map((month, index) => <section key={month.month} className="rounded-lg border p-3" aria-label={`Prognose ${monthLabel(period(value.year, month.month))}`}>
            <h3 className="mb-3 text-sm font-medium">{monthLabel(period(value.year, month.month))}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {([
                ["regularGross", "Laufendes sechstelrelevantes Brutto"],
                ["specialGross", "Sonderzahlung brutto"],
                ["monthlyTaxableBase", "LSt-Basis vor Werbungskostenpauschale"],
                ["specialSv", "SV der Sonderzahlung (für Steuerschätzung)"],
              ] as const).map(([key, label]) => <label key={key} className="space-y-1 text-xs">{label} (€)
                <Input type="number" min="0" max="1000000000" step="0.01" value={month[key]}
                  onChange={(event) => change(index, key, event.target.value)} />
              </label>)}
            </div>
          </section>)}
          <p className="text-xs leading-relaxed text-muted-foreground">Die laufende LSt-Basis ist vor dem Werbungskostenpauschale anzugeben; das Modell zieht 132 € jährlich bzw. 11 € monatlich ab. SV ist nicht bei jedem Dienstverhältnis gleich. Begünstigungen, Höchstbeitragsgrundlagen und frühere Sonderzahlungen prüfen; unbekannte SV leer lassen, nicht mit 0 ersetzen. Vorgeschlagene SV-Werte für 2026 sind Standardannahmen für vollversicherte Arbeitnehmer, nicht für Lehrlinge. Für 2027 ist eine eigene SV-Angabe erforderlich.</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 accent-primary" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            Annahmen geprüft: reguläre Monatsabrechnung, unverändertes Dienstverhältnis und persönliche Abzüge, keine einkommensabhängigen Begünstigungen, nur normale Urlaubs-/Weihnachtszahlungen nach § 67 Abs. 1/2, keine ungeklärten Aufrollungen.
          </label>
          {!parsed.success && <p role="alert" className="text-sm text-destructive">{parsed.error.issues[0]?.message}</p>}
          {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button disabled={!parsed.success || !!storageError} type="submit">Prognose speichern</Button>
        </DialogFooter>
      </DialogForm>
    </DialogContent>
  </Dialog>;
}

function PayrollWorkspace() {
  const { state, storageError } = useFinance();
  const [year, setYear] = useState<Payslip["year"]>(state.settings.asOf.startsWith("2027") ? 2027 : 2026);
  const [selectedEmployer, setSelectedEmployer] = useState("");
  const [editing, setEditing] = useState(false);
  const employers = [...new Map((state.payslips ?? []).filter((entry) => entry.year === year)
    .map((entry) => [payrollEmployerKey(entry.employer), entry.employer])).values()];
  const employer = employers.find((name) => payrollEmployerKey(name) === payrollEmployerKey(selectedEmployer)) ?? employers[0] ?? "";
  const saved = state.payrollForecasts?.find((entry) => entry.year === year && payrollEmployerKey(entry.employer) === payrollEmployerKey(employer));
  const analysis = analyzePayroll(state.payslips ?? [], year, employer, saved);
  const latest = analysis.latest;
  const actual = analysis.actual;
  const dashboardYear = Number(state.settings.asOf.slice(0, 4));
  const nextMonth = year === dashboardYear ? Number(state.settings.asOf.slice(5, 7)) : year < dashboardYear ? 13 : 1;
  const next = analysis.projections.find((month) => month.specialGross > 0 && month.month >= nextMonth);
  const currentModel = year === dashboardYear && latest && latest.month < nextMonth
    ? analysis.projections.find((month) => month.month === nextMonth) : undefined;
  return <>
    <PageHeading eyebrow="Österreich · Lohnabrechnung" title="Gehalt & Steuern"
      description="Jahressechstel aus deinen Abrechnungen – aktueller Belegstand, Jahresprognose und mögliche Mehrsteuer bei Sonderzahlungen.">
      <label className="sr-only" htmlFor="payroll-year">Steuerjahr</label>
      <select id="payroll-year" className="select-input" value={year} onChange={(event) => {
        setYear(event.target.value === "2027" ? 2027 : 2026); setEditing(false);
      }}><option value="2026">2026</option><option value="2027">2027</option></select>
      {employers.length > 0 && <>
        <label className="sr-only" htmlFor="payroll-employer">Dienstverhältnis</label>
        <select id="payroll-employer" className="select-input max-w-full" value={employer} onChange={(event) => { setSelectedEmployer(event.target.value); setEditing(false); }}>
          {employers.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </>}
    </PageHeading>
    <PayslipImportPanel year={year} employer={employer} onImported={(entry) => { setYear(entry.year); setSelectedEmployer(entry.employer); }} />
    <section className="panel mb-6 p-5 sm:p-6" aria-label="Jahressechstel Abrechnungsstand">
      <SectionHeading title="Belegter Abrechnungsstand" subtitle={latest
        ? `${monthLabel(period(latest.year, latest.month))} · ${latest.employer}`
        : "Noch keine bestätigte Lohnabrechnung für dieses Jahr"} />
      {latest && period(latest.year, latest.month) < state.settings.asOf.slice(0, 7) &&
        <p className="mb-4 rounded-lg border border-amber-500/30 p-3 text-sm">Nicht der heutige Ist-Stand: Abrechnungen nach {monthLabel(period(latest.year, latest.month))} fehlen. Spätere Beträge unten sind nur Prognosen, auch wenn der Monat bereits vergangen ist.</p>}
      {latest && period(latest.year, latest.month) > state.settings.asOf.slice(0, 7) &&
        <p className="mb-4 text-sm text-muted-foreground">Diese Abrechnung liegt nach dem Dashboard-Stichtag.</p>}
      {actual ? <>
        <div className="grid gap-5 sm:grid-cols-3">
          <div><p className="text-xs text-muted-foreground">Jahressechstel · {actual.source === "reported" ? "laut Abrechnung" : "aus Monatswerten berechnet"}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{money(actual.sixth)}</p></div>
          <div><p className="text-xs text-muted-foreground">Sonderzahlungen bisher · brutto</p><p className="mt-1 text-2xl font-semibold tabular-nums">{money(actual.specialGrossYtd)}</p></div>
          <div><p className="text-xs text-muted-foreground">Verbleibendes Brutto-Sechstel</p><p className="mt-1 text-2xl font-semibold tabular-nums">{money(actual.remaining)}</p></div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">Laufende Sechstel-Basis seit Jänner: {money(actual.regularGrossYtd)}. Ein fehlender kumulierter Wert ist unbekannt, nicht null. Ein Abrechnungswert hat Vorrang vor einer eigenen Hochrechnung.</p>
        {actual.controlSixth !== undefined && <p className="mt-3 text-sm">Rechnerisches Kontrollsechstel aus den Jahresbezügen: {currency(actual.controlSixth)}. Ein abweichender Abrechnungswert oder eine nötige Aufrollung ist mit der Lohnverrechnung zu klären.</p>}
      </> : <p className="text-sm text-muted-foreground">Noch keine belastbare Berechnung. Bitte die Lohnabrechnung importieren und die erkannten Bruttowerte bestätigen. Netto-Kontoeingänge werden nicht hochgerechnet.</p>}
      {analysis.issues.length > 0 && <div className="mt-4 space-y-2 text-sm text-muted-foreground" role="status">{analysis.issues.map((issue, index) => <p key={index}>{issue}</p>)}</div>}
      {analysis.missingMonths.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Fehlende Einzelabrechnungen: {analysis.missingMonths.map((month) => monthLabel(period(year, month))).join(", ")}. Nur ausdrücklich belegte kumulierte Werte können diese Lücken für die Rechnung schließen.</p>}
    </section>
    <section className="panel mb-6 p-5 sm:p-6" aria-label="Jahressechstel Prognose">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading title="Vorausschau bis Jahresende" subtitle="Szenario, keine garantierte Abrechnung oder endgültige Steuerfestsetzung" />
        <Button variant="outline" size="sm" disabled={!latest || !analysis.forecast.months.length || !!storageError} onClick={() => setEditing(true)}>
          <Calculator className="size-4" />Prognose anpassen
        </Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">Startvorschlag: gleichbleibende Bezüge und, falls ein Grundgehalt erkennbar ist, je ein Grundgehalt im Juni und November. Fehlende Monate bleiben Annahmen. Gehaltserhöhungen, variable Zulagen und den tatsächlichen Sonderzahlungsplan unter „Prognose anpassen“ ändern.</p>
      {analysis.yearEnd ? <>
        <div className="grid gap-5 sm:grid-cols-3">
          {currentModel && <div><p className="text-xs text-muted-foreground">Modelliertes Jahressechstel · {monthLabel(period(year, currentModel.month))}</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(currentModel.sixth)}</p></div>}
          <div><p className="text-xs text-muted-foreground">Voraussichtliches Jahressechstel · Dezember</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(analysis.yearEnd.sixth)}</p></div>
          <div><p className="text-xs text-muted-foreground">Sonderzahlungen im Jahresmodell · brutto</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(analysis.yearEnd.specialGrossYtd)}</p></div>
        </div>
        <p className="mt-4 text-sm">{analysis.yearEnd.overhang > 0
          ? `Im Jahres-Bruttovergleich liegen ${currency(analysis.yearEnd.overhang)} Sonderzahlungen über dem Kontrollsechstel. Bereits versteuerte Überhänge sind keine neue Steuerschuld.`
          : `Im Jahres-Bruttovergleich liegen die geplanten Sonderzahlungen innerhalb des Kontrollsechstels.`}</p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-sm" aria-label="Monatliche Gehaltsprognose">
            <thead><tr className="border-b text-xs text-muted-foreground"><th className="p-2">Monat · Prognose</th><th className="p-2 text-right">Laufendes Brutto</th><th className="p-2 text-right">Sonderzahlung</th><th className="p-2 text-right">Jahressechstel</th><th className="p-2 text-right">Rest brutto</th></tr></thead>
            <tbody>{analysis.projections.map((month) => <tr key={month.month} className="border-b last:border-0">
              <td className="p-2 whitespace-nowrap">{monthLabel(period(year, month.month))}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{money(analysis.forecast.months.find((entry) => entry.month === month.month)?.regularGross)}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{money(month.specialGross)}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{money(month.sixth)}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{money(month.remaining)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </> : <p className="text-sm text-muted-foreground">{latest?.month === 12 ? "Die letzte gespeicherte Abrechnung ist bereits Dezember; es gibt keine weiteren Prognosemonate." : "Für eine Vorausschau fehlen noch vollständige laufende Bruttowerte oder die nötigen kumulierten Angaben."}</p>}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Das rechnerische Kontrollsechstel am Jahresende ist die laufende Jahresbasis / 6. Tatsächliche Aufrollungen können frühere Steuerbeträge ändern und hängen von Ausnahmen und der Lohnverrechnung ab; eine Nachverrechnung wird hier nicht als sicherer Steuerbetrag zugesagt.</p>
    </section>
    <section className="panel mb-6 p-5 sm:p-6" aria-label="Steuer nächste Sonderzahlung">
      <SectionHeading title="Nächste geplante Sonderzahlung" subtitle={next ? `${monthLabel(period(year, next.month))} · alle Beträge sind Modellwerte` : "Noch keine weitere Sonderzahlung im gewählten Szenario"} />
      {next && <>
        {next.utilizationSource === "gross-comparison" && <p className="mb-4 text-sm text-muted-foreground">Nur vorläufiger Bruttovergleich: Der bisherige Sechstelverbrauch ist nicht belegt. Die folgende Aufteilung ist keine gesicherte begünstigte Auszahlung.</p>}
        <div className="grid gap-5 sm:grid-cols-3">
          <div><p className="text-xs text-muted-foreground">Sonderzahlung brutto</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(next.specialGross)}</p></div>
          <div><p className="text-xs text-muted-foreground">Davon innerhalb des Sechstels</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(next.eligibleGross)}</p></div>
          <div><p className="text-xs text-muted-foreground">Davon tarifpflichtiger Überhang</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(next.overflowGross)}</p></div>
        </div>
        {next.tax ? <div className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-2">
          <div><p className="text-xs text-muted-foreground">Geschätzte Lohnsteuer auf die Sonderzahlung</p><p className="mt-1 text-xl font-semibold tabular-nums">{currency(next.tax.total)}</p><p className="mt-1 text-xs text-muted-foreground">Begünstigt: {currency(next.tax.preferential)} · Tarif auf Überhang: {currency(next.tax.tariff)}</p></div>
          <div><p className="text-xs text-muted-foreground">Steuerdifferenz durch den Überhang · Schätzung</p><p className="mt-1 text-xl font-semibold tabular-nums">{currency(next.tax.signedOverflowDelta)}</p><p className="mt-1 text-xs text-muted-foreground">Verglichen mit derselben Zahlung vollständig innerhalb des Sechstels, bei denselben Abzügen. Ein negativer Wert wäre eine Mindersteuer.</p></div>
          <p className="text-sm sm:col-span-2">Modellierter Auszahlungsanteil nach SV und Lohnsteuer: {currency(next.tax.netSpecial)}. Sonstige Abzüge sind nicht enthalten.</p>
        </div> : <p className="mt-4 text-sm text-muted-foreground">Noch kein verlässlicher Steuerbetrag: Bitte die Prognoseannahmen und fehlenden Steuer-/SV-Werte prüfen.</p>}
        {next.taxIssues.length > 0 && <div className="mt-3 space-y-2 text-xs text-muted-foreground" role="status">{next.taxIssues.map((issue, index) => <p key={index}>{issue}</p>)}</div>}
        {next.taxAssumptions.length > 0 && <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Verwendete Steuerannahmen</summary>
          <div className="mt-2 space-y-2">{next.taxAssumptions.map((assumption, index) => <p key={index}>{assumption}</p>)}</div>
        </details>}
      </>}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Die Schätzung betrifft die Lohnsteuer im Auszahlungsmonat, nicht die endgültige Jahressteuer nach Arbeitnehmerveranlagung. Sechstelüberhänge werden grundsätzlich nach dem laufenden Tarif besteuert; SV, der jährliche Freibetrag und die Freigrenze sind getrennt zu behandeln. Bei unbekannten Vorbezügen, Arbeitgeberwechsel, Teilmonaten oder anderen Sonderfällen ist die Lohnverrechnung maßgeblich.</p>
    </section>
    <details className="mb-6 rounded-xl border p-5 text-sm">
      <summary className="cursor-pointer font-medium">Manuelle Jahressechstel-Berechnung / bisher gespeicherte Werte</summary>
      <div className="mt-4"><AnnualSixthCard /></div>
    </details>
    <p className="text-xs leading-relaxed text-muted-foreground">Österreichische Standardfälle, keine individuelle Steuerberatung. Die Daten werden je Arbeitgeber getrennt ausgewertet. Rechtsstand 18.09.2026: {payrollTaxSources.map((source, index) => <span key={source.href}>{index > 0 && " · "}<a className="text-primary underline" href={source.href} target="_blank" rel="noreferrer">{source.label}</a></span>)}</p>
    {editing && <ForecastEditor key={`${year}|${employer}`} value={analysis.forecast} onClose={() => setEditing(false)} />}
  </>;
}

export function PayrollTaxes() {
  const { ready } = useFinance();
  return ready ? <PayrollWorkspace /> : <p role="status" className="text-sm text-muted-foreground">Lohnabrechnungen werden geladen …</p>;
}
