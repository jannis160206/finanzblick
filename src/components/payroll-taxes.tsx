"use client";

import { useState } from "react";
import { useFinance } from "@/components/finance-provider";
import { PayslipImportPanel } from "@/components/payslip-import";
import { PageHeading, SectionHeading } from "@/components/finance-ui";
import { analyzePayrollAutomatically, estimatePayrollBonus, payrollTaxSources } from "@/lib/payroll-analysis";
import { payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";
import { currency, monthLabel } from "@/lib/format";

const period = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
const money = (value: number | undefined) => value === undefined ? "Noch offen" : currency(value);
const estimate = (value: { sixth: number; sixthUpper?: number } | undefined) => value?.sixthUpper !== undefined
  ? `${currency(value.sixth)} – ${currency(value.sixthUpper)}` : money(value?.sixth);

function PayrollWorkspace() {
  const { state } = useFinance();
  const [year, setYear] = useState<Payslip["year"]>(state.settings.asOf.startsWith("2027") ? 2027 : 2026);
  const [selectedEmployer, setSelectedEmployer] = useState("");
  const employers = [...new Map((state.payslips ?? []).filter((entry) => entry.year === year)
    .map((entry) => [payrollEmployerKey(entry.employer), entry.employer])).values()];
  const employer = employers.find((name) => payrollEmployerKey(name) === payrollEmployerKey(selectedEmployer)) ?? employers[0] ?? "";
  const analysis = analyzePayrollAutomatically(state.payslips ?? [], year, employer);
  const { latest, actual } = analysis;
  const dashboardYear = Number(state.settings.asOf.slice(0, 4));
  const nextMonth = year === dashboardYear ? Number(state.settings.asOf.slice(5, 7)) : year < dashboardYear ? 13 : 1;
  const estimateMonth = Math.max(latest?.month ?? 1, Math.min(12, nextMonth));
  const currentEstimate = analysis.sixthEstimates.find((entry) => entry.month === estimateMonth);
  const yearEndSixth = analysis.yearEnd?.sixth ?? actual?.controlSixth;
  const yearEndEstimate = analysis.sixthEstimates.find((entry) => entry.month === 12);
  const nextPayment = analysis.forecast.months.find((entry) => entry.specialGross > 0 && entry.month >= nextMonth);
  const next = analysis.projections.find((entry) => entry.month === nextPayment?.month);
  const bonus = estimatePayrollBonus(state.payslips ?? [], analysis, nextPayment?.month ?? estimateMonth);
  const bonusRange = bonus.headroom;
  const bonusExample = bonus.taxExample;
  const missing = analysis.missingMonths.map((month) => monthLabel(period(year, month))).join(", ");
  const rough = analysis.estimatedHistoryMonths.length > 0;
  const uncertain = analysis.unresolvedSixthMonths.length > 0;
  const projectedMonths = analysis.sixthEstimates.filter((entry) => latest && entry.month > latest.month);

  return <>
    <PageHeading eyebrow="Österreich · Lohnabrechnung" title="Gehalt & Steuern"
      description="Dein Jahressechstel, die Jahresprognose und die nächste Sonderzahlung.">
      <label className="sr-only" htmlFor="payroll-year">Steuerjahr</label>
      <select id="payroll-year" className="select-input" value={year} onChange={(event) => setYear(event.target.value === "2027" ? 2027 : 2026)}>
        <option value="2026">2026</option><option value="2027">2027</option>
      </select>
      {employers.length > 0 && <>
        <label className="sr-only" htmlFor="payroll-employer">Dienstverhältnis</label>
        <select id="payroll-employer" className="select-input max-w-full" value={employer} onChange={(event) => setSelectedEmployer(event.target.value)}>
          {employers.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </>}
    </PageHeading>

    {(missing || uncertain) && <p role="status" className="mb-4 rounded-lg border border-amber-500/30 p-3 text-sm">
      {missing && <>Fehlende Abrechnung: {missing}. {rough ? "Die Schätzung ist deshalb vorläufig. " : "Für vollständige Nachweise die fehlenden PDFs hochladen. "}</>}
      {uncertain && <>Prämie erkannt, Sechstelzuordnung nicht belegt. Die Schätzung zeigt beide Möglichkeiten.</>}
    </p>}
    <div className="mb-6 grid gap-4 lg:grid-cols-3">
      <section className="panel p-5 sm:p-6" aria-label="Jahressechstel Abrechnungsstand">
        <SectionHeading title="Jahressechstel · Abrechnungsstand" subtitle={latest
          ? `Stand: ${monthLabel(period(latest.year, latest.month))}` : "Noch keine Abrechnung"} />
        <p className="text-2xl font-semibold tabular-nums">{money(actual?.sixth)}</p>
        <p className="mt-2 text-xs text-muted-foreground">{actual
          ? actual.source === "reported" ? "Laut Lohnabrechnung" : "Aus den laufenden Bezügen berechnet"
          : latest ? "Noch nicht vollständig belegt" : "PDF hochladen – Berechnung startet automatisch"}</p>
      </section>
      <section className="panel p-5 sm:p-6 lg:col-span-2" aria-label="Jahressechstel Prognose">
        <SectionHeading title="Jahressechstel · Schätzung" subtitle={uncertain ? "Vorläufige Spanne · je nach Prämienzuordnung" : rough ? "Vorläufig · fehlende Monate geschätzt" : "Bei gleichbleibenden laufenden Bezügen"} />
        <div className="grid gap-5 sm:grid-cols-2">
          <div><p className="text-xs text-muted-foreground">{monthLabel(period(year, estimateMonth))}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{estimate(currentEstimate)}</p></div>
          <div><p className="text-xs text-muted-foreground">Jahresende · Dezember {year}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{yearEndSixth === undefined ? estimate(yearEndEstimate) : money(yearEndSixth)}</p></div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{rough
          ? "Lücken werden mit dem Durchschnitt der vorhandenen Monatsbezüge geschätzt, nicht als echte Abrechnungen gespeichert."
          : "Neue Abrechnungen aktualisieren die Prognose automatisch."}</p>
      </section>
    </div>

    {latest && <section className="panel mb-6 p-5 sm:p-6" aria-label="Steuer nächste Sonderzahlung">
      <SectionHeading title="Nächste Sonderzahlung" subtitle={nextPayment
        ? `${monthLabel(period(year, nextPayment.month))} · Schätzung, kein feststehender Auszahlungsbetrag`
        : "Keine weitere Sonderzahlung im aktuellen Modell"} />
      {nextPayment ? <>
        <div className="grid gap-5 sm:grid-cols-3">
          <div><p className="text-xs text-muted-foreground">Sonderzahlung brutto</p><p className="mt-1 text-xl font-semibold tabular-nums">{currency(nextPayment.specialGross)}</p></div>
          <div><p className="text-xs text-muted-foreground">Geschätzte Lohnsteuer</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(next?.tax?.total)}</p></div>
          <div><p className="text-xs text-muted-foreground">Mehr-/Mindersteuer durch Sechstelüberhang</p><p className="mt-1 text-xl font-semibold tabular-nums">{money(next?.tax?.signedOverflowDelta)}</p></div>
        </div>
        {!next?.tax && <p className="mt-3 text-xs text-muted-foreground">{missing
          ? "Die Steuerprognose bleibt bis zur Klärung der fehlenden Belege offen."
          : "Die Steuerberechnung benötigt weitere Nachweise; Gründe stehen unter Berechnungsdetails."}</p>}
      </> : !analysis.hasSpecialPaymentModel && latest.month < 12 && <p className="text-sm text-muted-foreground">Ein belegtes Grundgehalt für das Sonderzahlungsmodell fehlt.</p>}
    </section>}

    {latest && <section className="panel mb-6 p-5 sm:p-6" aria-label="Zusätzlicher Prämien-Spielraum">
      <SectionHeading title="Wie viel zusätzliche Prämie ist noch drin?"
        subtitle={`Bei Auszahlung im ${monthLabel(period(year, bonus.month))} · vorsichtige Brutto-Schätzung`} />
      <p className="text-2xl font-semibold tabular-nums">{bonusRange
        ? bonusRange.minimum === bonusRange.maximum ? currency(bonusRange.minimum)
          : `${currency(bonusRange.minimum)} – ${currency(bonusRange.maximum)}`
        : "Noch offen"}</p>
      <p className="mt-2 text-sm text-muted-foreground">{bonusRange
        ? bonusRange.maximum === 0 ? "Im Modell bleibt kein zusätzlicher Spielraum ohne Sechstelüberhang."
          : "Zusätzliches Brutto ohne modellierten Sechstelüberhang – geplante Sonderzahlungen sind schon reserviert."
        : bonus.headroomIssues[0]}</p>
      {bonusRange && <p className="mt-2 text-xs text-muted-foreground">
        Noch eingeplante Sonderzahlungen: {currency(bonus.reservedSpecialGross)}.
        {bonusRange.minimum !== bonusRange.maximum && " Die Spanne berücksichtigt die offene Prämienzuordnung; orientiere dich vorsichtig am unteren Wert."}
      </p>}
      <p className="mt-3 text-xs text-muted-foreground">Bei begünstigungsfähigen Sonderzahlungen gilt der laufende Tarif nur für den Überhang, nicht für die ganze Prämie. Innerhalb des Sechstels gelten begünstigte Sätze, oft 6 % nach SV – nicht pauschal steuerfrei.</p>
      <div className="mt-5 border-t pt-4" role="group" aria-label="Steuerbeispiel Zusatzprämie">
        <p className="text-sm font-medium">Wenn 1.000 € brutto vollständig tarifpflichtig sind</p>
        <p className="mt-1 text-xs text-muted-foreground">Isoliertes Rechenbeispiel im selben Auszahlungsmonat, keine verbindliche Abrechnung.</p>
        {bonusExample ? <>
          <p className="mt-3 text-sm">Laufender Tarif: durchschnittlich <strong>{bonusExample.effectiveTariffRate.toLocaleString("de-AT", { maximumFractionDigits: 2 })} %</strong> auf den Betrag nach SV.</p>
          <dl className="mt-3 grid gap-4 sm:grid-cols-4">
            <div><dt className="text-xs text-muted-foreground">SV-Anteil</dt><dd className="mt-1 font-semibold tabular-nums">{currency(bonusExample.sv)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Zusätzliche Lohnsteuer</dt><dd className="mt-1 font-semibold tabular-nums">{currency(bonusExample.tax)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Abzüge insgesamt</dt><dd className="mt-1 font-semibold tabular-nums">{currency(bonusExample.deductions)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Von 1.000 € bleiben netto</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{currency(bonusExample.net)}</dd></div>
          </dl>
        </> : <p className="mt-3 text-sm text-muted-foreground">Steuer und Netto noch offen: {bonus.taxIssues[0]}</p>}
      </div>
    </section>}

    <PayslipImportPanel year={year} employer={employer} onImported={(entry) => { setYear(entry.year); setSelectedEmployer(entry.employer); }} />

    {projectedMonths.length > 0 && <details className="panel mb-4 p-5 text-sm" aria-label="Monatliche Gehaltsprognose">
      <summary className="cursor-pointer font-medium">Monatliche Prognose anzeigen</summary>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm" aria-label="Monatliche Gehaltsprognose">
          <thead><tr className="border-b text-xs text-muted-foreground"><th className="p-2">Monat · Schätzung</th><th className="p-2 text-right">Laufendes Brutto</th><th className="p-2 text-right">Sonderzahlung</th><th className="p-2 text-right">Jahressechstel</th></tr></thead>
          <tbody>{projectedMonths.map((month) => {
            const forecast = analysis.forecast.months.find((entry) => entry.month === month.month);
            return <tr key={month.month} className="border-b last:border-0">
              <td className="p-2 whitespace-nowrap">{monthLabel(period(year, month.month))}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{money(forecast?.regularGross)}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{money(analysis.hasSpecialPaymentModel ? forecast?.specialGross : undefined)}</td>
              <td className="p-2 text-right whitespace-nowrap tabular-nums">{estimate(month)}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </details>}
    <details className="panel mb-6 p-5 text-sm" aria-label="Berechnungsdetails">
      <summary className="cursor-pointer font-medium">Berechnungsdetails, Annahmen & Quellen</summary>
      <div className="mt-4 space-y-4 text-xs leading-relaxed text-muted-foreground">
        {actual && <dl className="grid gap-3 sm:grid-cols-3">
          <div><dt>Laufende Basis seit Jänner</dt><dd className="mt-1 tabular-nums">{money(actual.regularGrossYtd)}</dd></div>
          <div><dt>Sonderzahlungen bisher · brutto</dt><dd className="mt-1 tabular-nums">{money(actual.specialGrossYtd)}</dd></div>
          <div><dt>Verbleibendes Brutto-Sechstel</dt><dd className="mt-1 tabular-nums">{money(actual.remaining)}</dd></div>
        </dl>}
        {analysis.issues.length > 0 && <div className="space-y-2">{analysis.issues.map((issue, index) => <p key={index}>{issue}</p>)}</div>}
        {rough && <p>Für {analysis.estimatedHistoryMonths.map((month) => monthLabel(period(year, month))).join(", ")} fehlt die laufende Bruttobasis. Nur die separat angezeigte Jahressechstel-Schätzung verwendet hierfür den Durchschnitt der verfügbaren vollen Monatsabrechnungen. Ist-Werte, Sechstelverbrauch und Steuer werden daraus nicht abgeleitet.</p>}
        {uncertain && <p>Die tarifbesteuerte VEB-Prämie ist mit der SV-Sonderzahlungsbasis abgeglichen. Laufende Tarifbesteuerung allein belegt keine Sechstelerhöhung (§ 67 Abs. 10 EStG). Die Spanne enthält deshalb beide Varianten: ohne und mit Einbeziehung in die laufende Sechstelbasis. Die Prämie wird nicht monatlich fortgeschrieben. Ein später belegter kumulierter laufender Bruttostand ersetzt diese Spanne; eine gesicherte Steuerrechnung benötigt zusätzlich belegte Verbrauchswerte.</p>}
        {latest && <div className="space-y-2">
          <p>Prämien-Spielraum: kleinster verbleibender Brutto-Sechstelbetrag vom gewählten Auszahlungsmonat bis Dezember, nach Abzug bisheriger und geplanter Sonderzahlungen. Das berücksichtigt auch ein sinkendes Sechstel und das Kontrollsechstel. Bereits gezahlte Sonderzahlungen werden vorsichtig vollständig reserviert, auch wenn sie früher teilweise tarifbesteuert wurden. Das kann den tatsächlich verfügbaren Spielraum unterschätzen. Eine offene Prämie wird unten vollständig als Verbrauch, oben mit dem belegten Mindestverbrauch angesetzt; dies sind Grenzen, keine bestätigte Steuerzuordnung.</p>
          <p>Das 1.000-€-Beispiel unterstellt eine zusätzliche SV-Sonderzahlung, die vollständig dem laufenden Tarif unterliegt. Es vergleicht die fortgeschriebene laufende LSt-Basis ohne und mit dieser isolierten Zahlung. Es ist keine Simulation einer größeren Prämie aus Spielraum plus 1.000 €: weitere gleichzeitige Überhänge können den Tarif erhöhen. Die SV wird anhand der gesamten modellierten Monats-Sonderzahlung einschließlich Beispiel und bisheriger Jahres-SV-Basis proportional aufgeteilt. Beitragssatzsprünge können auch Abzüge der übrigen Sonderzahlung verändern. Persönliche Abzüge bleiben unverändert; begünstigte Steuersätze oberhalb der 6-%-Stufe und die tatsächliche Prämienvereinbarung sind gesondert zu beachten.</p>
          {[...bonus.headroomIssues, ...bonus.taxIssues].map((issue, index) => <p key={index}>{issue}</p>)}
        </div>}
        {next && <dl className="grid gap-3 sm:grid-cols-3">
          <div><dt>Sonderzahlung innerhalb des Sechstels · Modell</dt><dd className="mt-1 tabular-nums">{currency(next.eligibleGross)}</dd></div>
          <div><dt>Tarifpflichtiger Überhang · Modell</dt><dd className="mt-1 tabular-nums">{currency(next.overflowGross)}</dd></div>
          <div><dt>Auszahlungsanteil nach SV und Lohnsteuer · Modell</dt><dd className="mt-1 tabular-nums">{money(next.tax?.netSpecial)}</dd></div>
        </dl>}
        {next?.taxIssues.length ? <div className="space-y-2">{next.taxIssues.map((issue, index) => <p key={index}>{issue}</p>)}</div> : null}
        <div className="space-y-2" aria-label="Automatische Modellannahmen">
          {(next?.taxAssumptions ?? analysis.assumptions).map((assumption, index) => <p key={index}>{assumption}</p>)}
        </div>
        <p>Das Kontrollsechstel am Jahresende beträgt laufendes Jahresbrutto / 6. Schätzungen sind keine endgültige Lohnabrechnung oder individuelle Steuerberatung. Die Auswertung erfolgt getrennt je Arbeitgeber; Aufrollungen und Sonderfälle können abweichen.</p>
        <p>Rechtsstand 18.09.2026: {payrollTaxSources.map((source, index) => <span key={source.href}>{index > 0 && " · "}<a className="text-primary underline" href={source.href} target="_blank" rel="noreferrer">{source.label}</a></span>)}</p>
      </div>
    </details>
  </>;
}

export function PayrollTaxes() {
  const { ready } = useFinance();
  return ready ? <PayrollWorkspace /> : <p role="status" className="text-sm text-muted-foreground">Lohnabrechnungen werden geladen …</p>;
}
