"use client";

import { useState } from "react";
import { useFinance } from "@/components/finance-provider";
import { PayslipImportPanel } from "@/components/payslip-import";
import { PageHeading, SectionHeading } from "@/components/finance-ui";
import { analyzePayrollAutomatically, payrollTaxSources } from "@/lib/payroll-analysis";
import { payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";
import { currency, monthLabel } from "@/lib/format";

const period = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
const money = (value: number | undefined) => value === undefined ? "Nicht belegt" : currency(value);

function PayrollWorkspace() {
  const { state } = useFinance();
  const [year, setYear] = useState<Payslip["year"]>(state.settings.asOf.startsWith("2027") ? 2027 : 2026);
  const [selectedEmployer, setSelectedEmployer] = useState("");
  const employers = [...new Map((state.payslips ?? []).filter((entry) => entry.year === year)
    .map((entry) => [payrollEmployerKey(entry.employer), entry.employer])).values()];
  const employer = employers.find((name) => payrollEmployerKey(name) === payrollEmployerKey(selectedEmployer)) ?? employers[0] ?? "";
  const analysis = analyzePayrollAutomatically(state.payslips ?? [], year, employer);
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
        setYear(event.target.value === "2027" ? 2027 : 2026);
      }}><option value="2026">2026</option><option value="2027">2027</option></select>
      {employers.length > 0 && <>
        <label className="sr-only" htmlFor="payroll-employer">Dienstverhältnis</label>
        <select id="payroll-employer" className="select-input max-w-full" value={employer} onChange={(event) => setSelectedEmployer(event.target.value)}>
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
      </> : <p className="text-sm text-muted-foreground">Noch keine belastbare Berechnung. Bitte eine lesbare Lohnabrechnung als PDF hochladen. Die Auswertung verwendet nur die erkannten Belegwerte; Netto-Kontoeingänge werden nicht hochgerechnet.</p>}
      {analysis.issues.length > 0 && <div className="mt-4 space-y-2 text-sm text-muted-foreground" role="status">{analysis.issues.map((issue, index) => <p key={index}>{issue}</p>)}</div>}
      {analysis.missingMonths.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Fehlende Einzelabrechnungen: {analysis.missingMonths.map((month) => monthLabel(period(year, month))).join(", ")}. Nur ausdrücklich belegte kumulierte Werte können diese Lücken für die Rechnung schließen.</p>}
    </section>
    <section className="panel mb-6 p-5 sm:p-6" aria-label="Jahressechstel Prognose">
      <SectionHeading title="Vorausschau bis Jahresende" subtitle="Automatisches Modell · unbestätigte Annahmen, keine garantierte Abrechnung oder endgültige Steuerfestsetzung" />
      <div className="mb-4 space-y-2 text-sm text-muted-foreground" aria-label="Automatische Modellannahmen">
        {analysis.assumptions.map((assumption) => <p key={assumption}>{assumption}</p>)}
      </div>
      {analysis.yearEnd ? <>
        <div className="grid gap-5 sm:grid-cols-3">
          {currentModel && <div><p className="text-xs text-muted-foreground">Modelliertes Jahressechstel · {monthLabel(period(year, currentModel.month))}</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(currentModel.sixth)}</p></div>}
          <div><p className="text-xs text-muted-foreground">Voraussichtliches Jahressechstel · Dezember</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(analysis.yearEnd.sixth)}</p></div>
          <div><p className="text-xs text-muted-foreground">Sonderzahlungen im Jahresmodell · brutto</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(analysis.hasSpecialPaymentModel ? analysis.yearEnd.specialGrossYtd : undefined)}</p></div>
        </div>
        <p className="mt-4 text-sm">{!analysis.hasSpecialPaymentModel
          ? "Ohne belegtes Grundgehalt ist kein Sonderzahlungsmodell möglich. Die Vorausschau zeigt nur das laufende Brutto und das daraus modellierte Jahressechstel."
          : analysis.yearEnd.overhang > 0
          ? `Im Jahres-Bruttovergleich liegen ${currency(analysis.yearEnd.overhang)} Sonderzahlungen über dem Kontrollsechstel. Bereits versteuerte Überhänge sind keine neue Steuerschuld.`
          : `Im Jahres-Bruttovergleich liegen die geplanten Sonderzahlungen innerhalb des Kontrollsechstels.`}</p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-sm" aria-label="Monatliche Gehaltsprognose">
            <thead><tr className="border-b text-xs text-muted-foreground"><th className="p-2">Monat · Prognose</th><th className="p-2 text-right">Laufendes Brutto</th><th className="p-2 text-right">Sonderzahlung</th><th className="p-2 text-right">Jahressechstel</th><th className="p-2 text-right">Rest brutto</th></tr></thead>
            <tbody>{analysis.projections.map((month) => <tr key={month.month} className="border-b last:border-0">
              <td className="p-2 whitespace-nowrap">{monthLabel(period(year, month.month))}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{money(analysis.forecast.months.find((entry) => entry.month === month.month)?.regularGross)}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{money(analysis.hasSpecialPaymentModel ? month.specialGross : undefined)}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{money(month.sixth)}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{money(analysis.hasSpecialPaymentModel ? month.remaining : undefined)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </> : <p className="text-sm text-muted-foreground">{latest?.month === 12 ? "Die letzte gespeicherte Abrechnung ist bereits Dezember; es gibt keine weiteren Prognosemonate." : "Für eine Vorausschau fehlen noch ausreichende Belege. Bitte vollständige, lesbare PDF-Abrechnungen mit laufendem Brutto und gegebenenfalls kumulierten Jahreswerten hochladen."}</p>}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Das rechnerische Kontrollsechstel am Jahresende ist die laufende Jahresbasis / 6. Tatsächliche Aufrollungen können frühere Steuerbeträge ändern und hängen von Ausnahmen und der Lohnverrechnung ab; eine Nachverrechnung wird hier nicht als sicherer Steuerbetrag zugesagt.</p>
    </section>
    <section className="panel mb-6 p-5 sm:p-6" aria-label="Steuer nächste Sonderzahlung">
      <SectionHeading title="Nächste modellierte Sonderzahlung" subtitle={next ? `${monthLabel(period(year, next.month))} · alle Beträge sind unbestätigte Modellwerte` : "Noch keine weitere Sonderzahlung im automatischen Modell"} />
      {next && <>
        {next.utilizationSource === "gross-comparison" && <p className="mb-4 text-sm text-muted-foreground">Nur vorläufiger Bruttovergleich: Der bisherige Sechstelverbrauch ist nicht belegt. Die folgende Aufteilung ist keine gesicherte begünstigte Auszahlung.</p>}
        <div className="grid gap-5 sm:grid-cols-3">
          <div><p className="text-xs text-muted-foreground">Sonderzahlung brutto</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(next.specialGross)}</p></div>
          <div><p className="text-xs text-muted-foreground">Davon innerhalb des Sechstels</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(next.eligibleGross)}</p></div>
          <div><p className="text-xs text-muted-foreground">Davon tarifpflichtiger Überhang</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(next.overflowGross)}</p></div>
        </div>
        {next.tax ? <div className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-2">
          <div><p className="text-xs text-muted-foreground">Geschätzte Lohnsteuer auf die Sonderzahlung · automatisches Modell</p><p className="mt-1 text-xl font-semibold tabular-nums">{currency(next.tax.total)}</p><p className="mt-1 text-xs text-muted-foreground">Begünstigt: {currency(next.tax.preferential)} · Tarif auf Überhang: {currency(next.tax.tariff)}</p></div>
          <div><p className="text-xs text-muted-foreground">Steuerdifferenz durch den Überhang · Schätzung</p><p className="mt-1 text-xl font-semibold tabular-nums">{currency(next.tax.signedOverflowDelta)}</p><p className="mt-1 text-xs text-muted-foreground">Verglichen mit derselben Zahlung vollständig innerhalb des Sechstels, bei denselben Abzügen. Ein negativer Wert wäre eine Mindersteuer.</p></div>
          <p className="text-sm sm:col-span-2">Modellierter Auszahlungsanteil nach SV und Lohnsteuer: {currency(next.tax.netSpecial)}. Sonstige Abzüge sind nicht enthalten.</p>
        </div> : <p className="mt-4 text-sm text-muted-foreground">Keine ausreichend abgesicherte Steuer-Modellrechnung: Belege fehlen oder der Fall ist nicht unterstützt. Weitere lesbare PDF-Abrechnungen können fehlende Nachweise liefern; Sonderfälle bleiben der Lohnverrechnung vorbehalten.</p>}
        {next.taxIssues.length > 0 && <div className="mt-3 space-y-2 text-xs text-muted-foreground" role="status">{next.taxIssues.map((issue, index) => <p key={index}>{issue}</p>)}</div>}
        {next.taxAssumptions.length > 0 && <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Verwendete Steuerannahmen</summary>
          <div className="mt-2 space-y-2">{next.taxAssumptions.map((assumption, index) => <p key={index}>{assumption}</p>)}</div>
        </details>}
      </>}
      {!next && !analysis.hasSpecialPaymentModel && latest?.month !== 12 && <p className="mt-4 text-sm text-muted-foreground">Für die automatische Sonderzahlungsannahme fehlt ein ausdrücklich belegtes Grundgehalt. Bitte eine entsprechende PDF-Abrechnung hochladen; Betrag und Zahlungsplan werden nicht aus Nettoeingängen abgeleitet.</p>}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Die Schätzung betrifft die Lohnsteuer im Auszahlungsmonat, nicht die endgültige Jahressteuer nach Arbeitnehmerveranlagung. Sechstelüberhänge werden grundsätzlich nach dem laufenden Tarif besteuert; SV, der jährliche Freibetrag und die Freigrenze sind getrennt zu behandeln. Bei unbekannten Vorbezügen, Arbeitgeberwechsel, Teilmonaten oder anderen Sonderfällen ist die Lohnverrechnung maßgeblich.</p>
    </section>
    <p className="text-xs leading-relaxed text-muted-foreground">Österreichische Standardfälle, keine individuelle Steuerberatung. Die Daten werden je Arbeitgeber getrennt ausgewertet. Rechtsstand 18.09.2026: {payrollTaxSources.map((source, index) => <span key={source.href}>{index > 0 && " · "}<a className="text-primary underline" href={source.href} target="_blank" rel="noreferrer">{source.label}</a></span>)}</p>
  </>;
}

export function PayrollTaxes() {
  const { ready } = useFinance();
  return ready ? <PayrollWorkspace /> : <p role="status" className="text-sm text-muted-foreground">Lohnabrechnungen werden geladen …</p>;
}
