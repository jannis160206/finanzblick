"use client";

import { ChevronDown, TriangleAlert } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { PayrollDisclosure, PayrollFigures } from "@/components/payroll-ui";
import {
  payrollEstimate,
  payrollMoney,
  payrollPeriod,
  type PayrollPresentation,
} from "@/components/payroll-presentation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { currency, monthLabel } from "@/lib/format";

export function PayrollCoverage({ view }: { view: PayrollPresentation }) {
  const { analysis, missing, rough, uncertain } = view;
  if (!missing && !uncertain) return null;
  const count = analysis.missingMonths.length;
  const chips = [
    missing && `${count} ${count === 1 ? "Monat fehlt" : "Monate fehlen"}`,
    uncertain && "Prämienzuordnung offen",
  ].filter(Boolean);
  const detail = (
    <>
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
    </>
  );
  return (
    <div role="status" className="flex flex-wrap items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full bg-warning-soft px-3 py-1 text-left text-xs font-medium text-warning transition-colors hover:bg-warning/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0">{chips.join(" · ")}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 text-sm leading-relaxed">
          {detail}
        </PopoverContent>
      </Popover>
      <span className="sr-only">{detail}</span>
    </div>
  );
}

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function SixthProgress({ view }: { view: PayrollPresentation }) {
  const { actual, analysis } = view;
  // Without a verified usage the analysis compares gross special payments, like the projections do.
  const consumed = actual?.usedSixth ?? actual?.specialGrossYtd;
  if (!actual || consumed === undefined || analysis.contextIssues.length) {
    return (
      <div>
        <h3 className="text-sm font-medium">Jahressechstel</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Verbrauch noch nicht belegt.
        </p>
      </div>
    );
  }
  const sixth = actual.sixth;
  const used = Math.min(consumed, sixth);
  const remaining = actual.remaining ?? money(Math.max(0, sixth - consumed));
  const overhang = money(Math.max(0, consumed - sixth));
  const scale = Math.max(sixth, consumed);
  const text = `Verbraucht ${currency(used)} von ${currency(sixth)}, Rest ${currency(remaining)}${
    overhang > 0 ? `, Überhang ${currency(overhang)}` : ""
  }`;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-sm font-medium">Jahressechstel</h3>
        <p className="text-xs text-muted-foreground">
          Stand {monthLabel(payrollPeriod(view.year, actual.month))}
          {actual.usedSixth === undefined && " · Bruttovergleich"}
        </p>
      </div>
      <FinancialData>
        <div
          role="progressbar"
          aria-label="Jahressechstel verbraucht"
          aria-valuemin={0}
          aria-valuemax={sixth}
          aria-valuenow={used}
          aria-valuetext={text}
          className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-muted"
        >
          {scale > 0 && (
            <>
              <div className="h-full bg-chart-1" style={{ width: `${(used / scale) * 100}%` }} />
              {overhang > 0 && (
                <div
                  className="h-full border-l-2 border-card bg-destructive"
                  style={{ width: `${(overhang / scale) * 100}%` }}
                />
              )}
            </>
          )}
        </div>
        <p className="mt-2 flex flex-wrap justify-between gap-x-3 text-sm text-muted-foreground">
          <span>
            Verbraucht{" "}
            <span className="font-semibold text-foreground tabular-nums">{currency(used)}</span>{" "}
            von <span className="tabular-nums">{currency(sixth)}</span>
          </span>
          <span className="whitespace-nowrap">
            Rest <span className="font-semibold text-foreground tabular-nums">{currency(remaining)}</span>
          </span>
          {overhang > 0 && (
            <span className="font-medium text-destructive">
              {" "}· Überhang <span className="tabular-nums">{currency(overhang)}</span>
            </span>
          )}
        </p>
      </FinancialData>
    </div>
  );
}

function DetailHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
    </div>
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
    <Card as="section" aria-labelledby="payroll-special-title" className="min-w-0">
      <CardHeader>
        <CardTitle id="payroll-special-title">Sonderzahlung &amp; Jahressechstel</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 pt-4">
        <section className="min-w-0" aria-label="Steuer nächste Sonderzahlung">
          <DetailHeading
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
        <SixthProgress view={view} />
        <PayrollDisclosure title="Mehr Details" label="Gehaltsdetails" inset>
          <FinancialData className="divide-y divide-border/60">
            <section
              className="min-w-0 pb-5"
              aria-label="Jahressechstel Abrechnungsstand"
            >
              <DetailHeading
                title="Jahressechstel · Abrechnungsstand"
                subtitle={
                  latest
                    ? `Stand: ${monthLabel(payrollPeriod(latest.year, latest.month))}`
                    : "Noch keine Abrechnung"
                }
              />
              <p className="amount break-words text-2xl">
                {payrollMoney(actual?.sixth)}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {actual
                  ? actual.source === "reported"
                    ? "Laut Lohnabrechnung"
                    : "Aus den laufenden Bezügen berechnet"
                  : "Noch nicht vollständig belegt"}
              </p>
            </section>
            <section className="min-w-0 py-5" aria-label="Jahressechstel Prognose">
              <DetailHeading
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
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {analysis.contextIssues.length
                  ? "Nur belegte Abrechnungswerte; für diesen Kontext keine Fortschreibung."
                  : rough
                    ? "Lücken nur geschätzt."
                    : "Aktualisiert sich mit jeder Abrechnung."}
              </p>
            </section>
            <section
              className="min-w-0 pt-5"
              aria-label="Zusätzlicher Prämien-Spielraum"
            >
              <DetailHeading
                title="Zusätzlicher Prämien-Spielraum"
                subtitle={`Auszahlung im ${monthLabel(payrollPeriod(year, bonus.month))} · vorsichtige Brutto-Schätzung`}
              />
              <p className="amount break-words text-2xl">
                {bonusRange
                  ? bonusRange.minimum === bonusRange.maximum
                    ? currency(bonusRange.minimum)
                    : `${currency(bonusRange.minimum)} – ${currency(bonusRange.maximum)}`
                  : "Noch offen"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
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
              <PayrollDisclosure
                title="Steuerbeispiel für 1.000 €"
                label="Steuerbeispiel"
                inset
              >
                <div role="group" aria-label="Steuerbeispiel Zusatzprämie">
                  <p className="text-sm font-medium">
                    Wenn 1.000 € brutto vollständig tarifpflichtig sind
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
          </FinancialData>
        </PayrollDisclosure>
      </CardContent>
    </Card>
  );
}
