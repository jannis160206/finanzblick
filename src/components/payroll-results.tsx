import { SectionHeading } from "@/components/finance-ui";
import { PayrollDisclosure, PayrollFigures } from "@/components/payroll-ui";
import {
  payrollEstimate,
  payrollMoney,
  payrollPeriod,
  type PayrollPresentation,
} from "@/components/payroll-presentation";
import { currency, monthLabel } from "@/lib/format";

export function PayrollCoverage({ view }: { view: PayrollPresentation }) {
  const { missing, rough, uncertain } = view;
  if (!missing && !uncertain) return null;
  return (
    <p
      role="status"
      className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-relaxed"
    >
      {missing && (
        <>
          Fehlende Abrechnung: {missing}.{" "}
          {rough
            ? "Schätzung vorläufig. "
            : "PDFs für vollständige Nachweise ergänzen. "}
        </>
      )}
      {uncertain && (
        <>
          Prämie erkannt, Sechstelzuordnung offen. Schätzung umfasst beide
          Varianten.
        </>
      )}
    </p>
  );
}

export function PayrollResults({ view }: { view: PayrollPresentation }) {
  const {
    analysis,
    latest,
    actual,
    year,
    estimateMonth,
    currentEstimate,
    yearEndSixth,
    yearEndEstimate,
    nextPayment,
    next,
    missing,
    rough,
    uncertain,
    bonus,
  } = view;
  const bonusRange = bonus.headroom;
  const bonusExample = bonus.taxExample;
  return (
    <div className="min-w-0 space-y-4">
      <section
        className="panel min-w-0 rounded-2xl p-5 shadow-sm"
        aria-label="Steuer nächste Sonderzahlung"
      >
        <SectionHeading
          title="Nächste Sonderzahlung"
          subtitle={
            nextPayment
              ? `${monthLabel(payrollPeriod(year, nextPayment.month))} · Unverbindliche Schätzung`
              : analysis.contextIssues.length
                ? "Steuer- und Nettoprognose nicht verfügbar"
                : "Keine weitere Sonderzahlung im Modell"
          }
        />
        {analysis.contextIssues.length > 0 && (
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            {analysis.contextIssues.join(" ")} Belegte Werte bleiben erhalten.
          </p>
        )}
        {nextPayment ? (
          <>
            <PayrollFigures
              figures={[
                {
                  label: "Sonderzahlung brutto",
                  value: currency(nextPayment.specialGross),
                },
                {
                  label: "Geschätzter Auszahlungsanteil netto",
                  value: payrollMoney(next?.tax?.netSpecial),
                },
                {
                  label: "Geschätzte Lohnsteuer",
                  value: payrollMoney(next?.tax?.total),
                },
                {
                  label: "Mehr-/Mindersteuer durch Sechstelüberhang",
                  value: payrollMoney(next?.tax?.signedOverflowDelta),
                },
              ]}
            />
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Netto-Modell nach SV und Lohnsteuer, kein bestätigter
              Auszahlungsbetrag.
            </p>
            {!next?.tax && (
              <p className="mt-2 text-xs text-muted-foreground">
                {missing
                  ? "Steuerprognose offen: fehlende Belege klären."
                  : "Steuerprognose offen: weitere Nachweise nötig."}
              </p>
            )}
          </>
        ) : (
          !analysis.hasSpecialPaymentModel &&
          latest &&
          latest.month < 12 && (
            <p className="text-sm text-muted-foreground">
              Grundgehalt für das Sonderzahlungsmodell nicht belegt.
            </p>
          )
        )}
      </section>
      <PayrollDisclosure
        title="Details · Jahressechstel, Prämien-Spielraum und Steuerbeispiel"
        label="Gehaltsdetails"
      >
        <div className="space-y-4 px-5 pb-5">
      <div className="grid gap-3 lg:grid-cols-3">
        <section
          className="panel min-w-0 rounded-2xl p-5 shadow-sm"
          aria-label="Jahressechstel Abrechnungsstand"
        >
          <SectionHeading
            title="Jahressechstel · Abrechnungsstand"
            subtitle={
              latest
                ? `Stand: ${monthLabel(payrollPeriod(latest.year, latest.month))}`
                : "Noch keine Abrechnung"
            }
          />
          <p className="break-words text-2xl font-semibold tracking-tight tabular-nums">
            {payrollMoney(actual?.sixth)}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {actual
              ? actual.source === "reported"
                ? "Laut Lohnabrechnung"
                : "Aus den laufenden Bezügen berechnet"
              : "Noch nicht vollständig belegt"}
          </p>
        </section>
        <section
          className="panel min-w-0 rounded-2xl p-5 shadow-sm lg:col-span-2"
          aria-label="Jahressechstel Prognose"
        >
          <SectionHeading
            title="Jahressechstel · Schätzung"
            subtitle={
              uncertain
                ? "Vorläufige Spanne · je nach Prämienzuordnung"
                : rough
                  ? "Vorläufig · fehlende Monate geschätzt"
                  : "Bei gleichbleibenden laufenden Bezügen"
            }
          />
          <PayrollFigures
            figures={[
              {
                label: monthLabel(payrollPeriod(year, estimateMonth)),
                value: payrollEstimate(currentEstimate),
              },
              {
                label: `Jahresende · Dezember ${year}`,
                value:
                  yearEndSixth === undefined
                    ? payrollEstimate(yearEndEstimate)
                    : payrollMoney(yearEndSixth),
              },
            ]}
          />
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {analysis.contextIssues.length
              ? "Nur belegte Abrechnungswerte; für diesen Kontext keine Fortschreibung."
              : rough
              ? "Lücken nur geschätzt, nicht als Abrechnungen gespeichert."
              : "Prognose aktualisiert sich mit neuen Abrechnungen."}
          </p>
        </section>
      </div>
      <section
        className="panel min-w-0 rounded-2xl p-5 shadow-sm"
        aria-label="Zusätzlicher Prämien-Spielraum"
      >
        <SectionHeading
          title="Zusätzlicher Prämien-Spielraum"
          subtitle={`Auszahlung im ${monthLabel(payrollPeriod(year, bonus.month))} · vorsichtige Brutto-Schätzung`}
        />
        <p className="break-words text-2xl font-semibold tracking-tight tabular-nums">
          {bonusRange
            ? bonusRange.minimum === bonusRange.maximum
              ? currency(bonusRange.minimum)
              : `${currency(bonusRange.minimum)} – ${currency(bonusRange.maximum)}`
            : "Noch offen"}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {bonusRange
            ? bonusRange.maximum === 0
              ? "Modell: kein weiterer Spielraum ohne Sechstelüberhang."
              : "Zusätzliches Brutto ohne modellierten Sechstelüberhang."
            : bonus.headroomIssues[0]}
        </p>
        {bonusRange && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Geplante Sonderzahlungen bereits reserviert:{" "}
            {currency(bonus.reservedSpecialGross)}.
            {bonusRange.minimum !== bonusRange.maximum &&
              " Offene Prämienzuordnung: vorsichtig am unteren Wert orientieren."}
          </p>
        )}
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Bei begünstigungsfähigen Sonderzahlungen gilt der Tarif nur für den
          Überhang, nicht für die ganze Prämie. Innerhalb des Sechstels:
          begünstigte Sätze, oft 6 % nach SV, nicht pauschal steuerfrei.
        </p>
        <PayrollDisclosure
          title="Steuerbeispiel für 1.000 €"
          label="Steuerbeispiel"
          inset
        >
          <div role="group" aria-label="Steuerbeispiel Zusatzprämie">
            <p className="text-sm font-medium">
              Wenn 1.000 € brutto vollständig tarifpflichtig sind
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Isoliertes Beispiel für diesen Monat, keine verbindliche
              Abrechnung.
            </p>
            {bonusExample ? (
              <>
                <p className="mt-3 text-sm">
                  Laufender Tarif: durchschnittlich{" "}
                  <strong>
                    {bonusExample.effectiveTariffRate.toLocaleString("de-AT", {
                      maximumFractionDigits: 2,
                    })}{" "}
                    %
                  </strong>{" "}
                  auf den Betrag nach SV.
                </p>
                <PayrollFigures
                  className="mt-3"
                  figures={[
                    { label: "SV-Anteil", value: currency(bonusExample.sv) },
                    {
                      label: "Zusätzliche Lohnsteuer",
                      value: currency(bonusExample.tax),
                    },
                    {
                      label: "Abzüge insgesamt",
                      value: currency(bonusExample.deductions),
                    },
                    {
                      label: "Von 1.000 € bleiben netto",
                      value: currency(bonusExample.net),
                    },
                  ]}
                />
              </>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                Steuer und Netto noch offen: {bonus.taxIssues[0]}
              </p>
            )}
          </div>
        </PayrollDisclosure>
      </section>
        </div>
      </PayrollDisclosure>
    </div>
  );
}
