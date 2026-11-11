"use client";

import type { ReactNode } from "react";
import { ArrowRight, ChevronDown, TriangleAlert } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { payrollShare } from "@/components/payroll-focus";
import { SixthSplitCard } from "@/components/payroll-sixth-split";
import { PayrollCardHeading as CardHeading, PayrollLabel, PayrollStatusBadge, payrollInfoTip as infoTip } from "@/components/payroll-ui";
import {
  payrollEstimate,
  payrollMoney,
  payrollPeriod,
  type PayrollPresentation,
} from "@/components/payroll-presentation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { currency, monthLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

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
const open = (value: string) => value === "Noch offen";
/** Compact figure below a headline number; the full wording stays available to screen readers. */
function Figure({
  short,
  full,
  value,
  tone,
}: {
  short: ReactNode;
  full: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs break-words text-muted-foreground">
        <PayrollLabel short={short} full={full} />
      </dt>
      <dd
        className={cn(
          "mt-1 break-words",
          open(value)
            ? "text-xs text-muted-foreground"
            : "amount text-sm sm:text-base",
          tone === "up" && "text-destructive",
          tone === "down" && "text-money-in",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

const splitParts = [
  { key: "net", label: "Netto", color: "bg-chart-1" },
  { key: "tax", label: "Lohnsteuer", color: "bg-chart-2" },
  { key: "sv", label: "SV", color: "bg-chart-3" },
] as const;
type SplitValues = Record<(typeof splitParts)[number]["key"], number>;

/** Gross split into net, Lohnsteuer and SV – same colors as the Brutto → Netto bar of the month. */
function SplitBar({ gross, values }: { gross: number; values: SplitValues }) {
  const scale = Math.max(gross, values.net + values.tax + values.sv);
  if (scale <= 0) return null;
  return (
    <div aria-hidden="true" className="flex h-2.5 overflow-hidden rounded-full bg-muted">
      {splitParts
        .filter((part) => values[part.key] > 0)
        .map((part, index) => (
          <span
            key={part.key}
            className={cn(
              "block h-full transition-[width] duration-500 ease-soft motion-reduce:transition-none",
              part.color,
              index > 0 && "border-l-2 border-card",
            )}
            style={{ width: `${(values[part.key] / scale) * 100}%` }}
          />
        ))}
    </div>
  );
}

function NextPaymentCard({ view }: { view: PayrollPresentation }) {
  const { analysis, latest, year, nextPayment, next, missing } = view;
  const tax = next?.tax;
  const blocked = analysis.contextIssues.length > 0;
  const delta = tax?.signedOverflowDelta;
  // The model's SV of the payment: together with Lohnsteuer and net it adds up to the gross.
  const split: SplitValues | undefined =
    tax && nextPayment?.specialSv !== undefined
      ? { net: tax.netSpecial, tax: tax.total, sv: nextPayment.specialSv }
      : undefined;
  return (
    <Card as="section" aria-label="Steuer nächste Sonderzahlung" className="min-w-0">
      <CardContent className="flex h-full flex-col gap-5">
        <CardHeading
          title="Nächste Sonderzahlung"
          subtitle={
            nextPayment
              ? monthLabel(payrollPeriod(year, nextPayment.month))
              : blocked
                ? "Steuer- und Nettoprognose nicht verfügbar"
                : "Keine weitere Sonderzahlung im Modell"
          }
          info={
            <>
              Unverbindliche Schätzung aus deinen Abrechnungen: je ein Grundgehalt im Juni und November,
              Lohnsteuer nach den bisherigen Bezügen. Mehr-/Mindersteuer ist der Lohnsteuer-Unterschied, weil ein
              Teil über dem Jahressechstel liegt und zum Tarif versteuert wird (positiv = mehr Steuer). Die
              tatsächliche Abrechnung ersetzt die Schätzung.
            </>
          }
          action={nextPayment && <PayrollStatusBadge status="forecast" className="mt-0.5" />}
        />
        {blocked && (
          <p role="status" className="text-sm text-muted-foreground">
            {analysis.contextIssues.join(" ")} Belegte Werte bleiben erhalten.
          </p>
        )}
        {nextPayment ? (
          <FinancialData className="flex flex-1 flex-col gap-5">
            <div className="space-y-4">
              <dl>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    <PayrollLabel short="Auszahlung netto" full="Geschätzter Auszahlungsanteil netto" />
                  </dt>
                  <dd
                    className={cn(
                      "mt-1 break-words",
                      tax ? "amount text-display" : "text-xl font-medium text-muted-foreground",
                    )}
                  >
                    {payrollMoney(tax?.netSpecial)}
                  </dd>
                </div>
              </dl>
              {split && (
                <div>
                  <SplitBar gross={nextPayment.specialGross} values={split} />
                  <ul
                    aria-label="Aufteilung der Sonderzahlung"
                    className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs"
                  >
                    {splitParts.map((part) => (
                      <li key={part.key} className="flex items-center gap-1.5">
                        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", part.color)} />
                        {part.label}
                        {nextPayment.specialGross > 0 && (
                          <span className="text-muted-foreground tabular-nums">
                            {payrollShare(split[part.key] / nextPayment.specialGross)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <dl className="mt-auto grid grid-cols-3 gap-x-3 border-t border-border/70 pt-4 sm:gap-x-4">
              <Figure short="Brutto" full="Sonderzahlung brutto" value={currency(nextPayment.specialGross)} />
              <Figure short="Lohnsteuer" full="Geschätzte Lohnsteuer" value={payrollMoney(tax?.total)} />
              <Figure
                short={<>Mehr-/<wbr />Mindersteuer</>}
                full="Mehr-/Mindersteuer durch Sechstelüberhang"
                value={payrollMoney(delta)}
                tone={delta === undefined || delta === 0 ? undefined : delta > 0 ? "up" : "down"}
              />
            </dl>
            {!tax && (
              <p className="text-xs text-muted-foreground">
                {missing
                  ? "Steuerprognose offen: fehlende Belege klären."
                  : "Steuerprognose offen: weitere Nachweise nötig."}
              </p>
            )}
          </FinancialData>
        ) : (
          !analysis.hasSpecialPaymentModel &&
          latest &&
          latest.month < 12 && (
            <p className="text-sm text-muted-foreground">
              Grundgehalt für das Sonderzahlungsmodell nicht belegt.
            </p>
          )
        )}
      </CardContent>
    </Card>
  );
}

function MeterFigure({
  swatch,
  label,
  value,
  tone,
}: {
  swatch: string;
  label: string;
  value: number;
  tone?: "destructive";
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", swatch)} />
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 break-words amount text-sm",
          tone === "destructive" && "text-destructive",
        )}
      >
        {currency(value)}
      </dd>
    </div>
  );
}

function SixthMeter({ view }: { view: PayrollPresentation }) {
  const { actual, analysis } = view;
  // Without a verified usage the analysis compares gross special payments, like the projections do.
  const consumed = actual?.usedSixth ?? actual?.specialGrossYtd;
  if (!actual || consumed === undefined || analysis.contextIssues.length) {
    return <p className="text-xs text-muted-foreground">Verbrauch noch nicht belegt.</p>;
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
    <div className="min-w-0">
      <div className="mb-2 flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h4 className="text-xs font-medium text-muted-foreground">Verbrauch</h4>
        {actual.usedSixth === undefined && (
          <span className="flex items-center gap-0.5">
            <Badge variant="secondary">Bruttovergleich</Badge>
            <InfoTip label="Bruttovergleich" className={infoTip}>
              Der Verbrauch steht nicht auf der Abrechnung. Vorläufig zählen alle bisherigen Sonderzahlungen
              brutto als verbraucht.
            </InfoTip>
          </span>
        )}
      </div>
      <FinancialData>
        <div
          role="progressbar"
          aria-label="Jahressechstel verbraucht"
          aria-valuemin={0}
          aria-valuemax={sixth}
          aria-valuenow={used}
          aria-valuetext={text}
          className="flex h-2.5 overflow-hidden rounded-full bg-muted"
        >
          {scale > 0 && (
            <>
              <div
                className="h-full bg-chart-1 transition-[width] duration-500 ease-soft motion-reduce:transition-none"
                style={{ width: `${(used / scale) * 100}%` }}
              />
              {overhang > 0 && (
                <div
                  className="h-full border-l-2 border-card bg-destructive transition-[width] duration-500 ease-soft motion-reduce:transition-none"
                  style={{ width: `${(overhang / scale) * 100}%` }}
                />
              )}
            </>
          )}
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-x-4">
          <MeterFigure swatch="bg-chart-1" label="Verbraucht" value={used} />
          <MeterFigure swatch="border border-muted-foreground/50 bg-muted" label="Rest" value={remaining} />
          {overhang > 0 && (
            <MeterFigure swatch="bg-destructive" label="Überhang" value={overhang} tone="destructive" />
          )}
        </dl>
      </FinancialData>
    </div>
  );
}

function SixthCard({ view }: { view: PayrollPresentation }) {
  const {
    analysis,
    actual,
    latest,
    year,
    estimateMonth,
    currentEstimate,
    yearEndSixth,
    yearEndEstimate,
    rough,
    uncertain,
  } = view;
  const estimates = [
    ...(estimateMonth < 12
      ? [{ label: monthLabel(payrollPeriod(year, estimateMonth)), value: payrollEstimate(currentEstimate) }]
      : []),
    {
      label: `Jahresende · Dezember ${year}`,
      value: yearEndSixth === undefined ? payrollEstimate(yearEndEstimate) : payrollMoney(yearEndSixth),
    },
  ];
  return (
    <Card as="section" aria-labelledby="payroll-sixth-title" className="min-w-0">
      <CardContent className="flex h-full flex-col gap-5">
        <section aria-label="Jahressechstel Abrechnungsstand" className="min-w-0">
          <CardHeading
            id="payroll-sixth-title"
            title="Jahressechstel"
            subtitle={
              latest
                ? `Stand: ${monthLabel(payrollPeriod(latest.year, latest.month))}`
                : "Noch keine Abrechnung"
            }
            info={
              <>
                Sonderzahlungen bis zu einem Sechstel der laufenden Jahresbezüge werden begünstigt versteuert.
                Was darüber hinausgeht (Überhang), wird wie ein laufender Bezug zum Tarif versteuert.
              </>
            }
            action={
              actual && (
                <Badge variant={actual.source === "reported" ? "success" : "secondary"} className="mt-0.5">
                  {actual.source === "reported" ? "laut Abrechnung" : "berechnet"}
                </Badge>
              )
            }
          />
          <FinancialData
            as="p"
            className={cn(
              "mt-3 break-words",
              actual ? "amount text-2xl" : "text-xl font-medium text-muted-foreground",
            )}
          >
            {payrollMoney(actual?.sixth)}
          </FinancialData>
        </section>
        <SixthMeter view={view} />
        <section aria-label="Jahressechstel Prognose" className="mt-auto border-t border-border/70 pt-4">
          <div className="flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">Schätzung</h4>
            {(uncertain || rough) && (
              <Badge variant="warning">{uncertain ? "Spanne" : "vorläufig"}</Badge>
            )}
            <InfoTip label="Schätzung Jahressechstel" className={infoTip}>
              {analysis.contextIssues.length
                ? "Für diesen Beschäftigungskontext gibt es keine Fortschreibung, nur belegte Abrechnungswerte."
                : "Hochrechnung bei gleichbleibenden laufenden Bezügen; aktualisiert sich mit jeder Abrechnung."}
              {rough && " Fehlende Monate sind nur geschätzt."}
              {uncertain && " Die Spanne hängt davon ab, wie die erkannte Prämie dem Sechstel zugeordnet wird."}
            </InfoTip>
          </div>
          <FinancialData as="dl" className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
            {estimates.map((estimate) => (
              <div key={estimate.label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{estimate.label}</dt>
                <dd
                  className={cn(
                    "mt-0.5 break-words",
                    open(estimate.value) ? "text-xs text-muted-foreground" : "amount text-base",
                  )}
                >
                  {estimate.value}
                </dd>
              </div>
            ))}
          </FinancialData>
        </section>
      </CardContent>
    </Card>
  );
}

function HeadroomBar({
  reserved,
  minimum,
  maximum,
}: {
  reserved: number;
  minimum: number;
  maximum: number;
}) {
  const scale = reserved + maximum;
  const width = (value: number) => ({ width: `${(value / scale) * 100}%` });
  const range = maximum > minimum;
  return (
    <div className="min-w-0">
      {scale > 0 && (
        <div aria-hidden="true" className="flex h-2.5 overflow-hidden rounded-full bg-muted">
          {reserved > 0 && <span className="block h-full bg-muted-foreground/40" style={width(reserved)} />}
          {minimum > 0 && (
            <span className="block h-full border-l-2 border-card bg-chart-1 first:border-l-0" style={width(minimum)} />
          )}
          {range && (
            <span className="block h-full border-l-2 border-card bg-chart-1/35 first:border-l-0" style={width(maximum - minimum)} />
          )}
        </div>
      )}
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
          <span className="text-muted-foreground">Geplante Sonderzahlungen</span>
          <span className="tabular-nums">{currency(reserved)}</span>
        </li>
        <li className="flex items-center gap-1.5 text-muted-foreground">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-chart-1" />
          Spielraum
        </li>
        {range && (
          <li className="flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-chart-1/35" />
            je nach Prämienzuordnung
          </li>
        )}
      </ul>
    </div>
  );
}

function TaxExample({ bonus }: { bonus: PayrollPresentation["bonus"] }) {
  const example = bonus.taxExample;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-0.5">
        <h4 className="text-sm leading-snug font-semibold tracking-tight">Steuerbeispiel</h4>
        <InfoTip label="Steuerbeispiel" className={infoTip}>
          Was von 1.000 € zusätzlichem Brutto bleibt, wenn der Betrag zur Gänze zum laufenden Tarif versteuert
          wird – etwa eine Prämie über dem Jahressechstel.
        </InfoTip>
      </div>
      {example ? (
        <details aria-label="Steuerbeispiel" className="group/example mt-3 min-w-0">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5 transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <FinancialData
              as="span"
              className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm"
            >
              <span className="whitespace-nowrap">
                <span className="amount">+{currency(example.gross)}</span>{" "}
                <span className="text-muted-foreground">brutto</span>
              </span>
              <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 self-center text-muted-foreground" />
              <span className="sr-only">ergibt</span>
              <span className="whitespace-nowrap">
                <span className="amount">{currency(example.net)}</span>{" "}
                <span className="text-muted-foreground">netto</span>
              </span>
              <span aria-hidden="true" className="text-muted-foreground">·</span>
              <span className="whitespace-nowrap">
                <span className="amount">{currency(example.tax)}</span>{" "}
                <span className="text-muted-foreground">Steuer</span>
              </span>
            </FinancialData>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-soft group-open/example:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <FinancialData className="pt-4">
            <div role="group" aria-label="Steuerbeispiel Zusatzprämie">
              <SplitBar gross={example.gross} values={example} />
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                {splitParts.map((part) => (
                  <div key={part.key} className="min-w-0">
                    <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", part.color)} />
                      {part.label}
                    </dt>
                    <dd className="mt-0.5 break-words amount text-sm">{currency(example[part.key])}</dd>
                  </div>
                ))}
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Abzüge gesamt</dt>
                  <dd className="mt-0.5 break-words amount text-sm">{currency(example.deductions)}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                Ø Tarif{" "}
                <strong className="font-semibold text-foreground tabular-nums">
                  {`${example.effectiveTariffRate.toLocaleString("de-AT", { maximumFractionDigits: 2 })} %`}
                </strong>{" "}
                auf den Betrag nach SV
              </p>
            </div>
          </FinancialData>
        </details>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Steuer und Netto noch offen: {bonus.taxIssues[0]}
        </p>
      )}
    </div>
  );
}

function BonusCard({ view }: { view: PayrollPresentation }) {
  const { bonus, year } = view;
  const range = bonus.headroom;
  const amount = range
    ? range.minimum === range.maximum
      ? currency(range.minimum)
      : `${currency(range.minimum)} – ${currency(range.maximum)}`
    : "Noch offen";
  return (
    <Card as="section" aria-label="Zusätzlicher Prämien-Spielraum" className="min-w-0 lg:col-span-2">
      <CardContent className="@container/bonus">
        <div className="grid gap-x-8 gap-y-5 @2xl/bonus:grid-cols-2">
          <div className="min-w-0">
            <CardHeading
              title="Prämien-Spielraum"
              subtitle={`Auszahlung im ${monthLabel(payrollPeriod(year, bonus.month))}`}
              info={
                <>
                  Wie viel zusätzliches Brutto – etwa eine Prämie – im Auszahlungsmonat noch ins Jahressechstel
                  passt, ohne einen Überhang zu erzeugen. Geplante Sonderzahlungen sind bereits reserviert.
                  Vorsichtige Schätzung.
                </>
              }
            />
            <FinancialData className="mt-3 space-y-3">
              <p
                className={cn(
                  "break-words",
                  range ? "amount text-2xl" : "text-xl font-medium text-muted-foreground",
                )}
              >
                {amount}
              </p>
              <p className="text-xs text-muted-foreground">
                {range
                  ? range.maximum === 0
                    ? "Kein Spielraum ohne Sechstelüberhang."
                    : "Zusätzlich brutto, ohne Sechstelüberhang."
                  : bonus.headroomIssues[0]}
              </p>
              {range && range.minimum !== range.maximum && (
                <p className="text-xs font-medium text-warning">
                  Zuordnung offen: vorsichtig am unteren Wert orientieren.
                </p>
              )}
              {range && (
                <HeadroomBar
                  reserved={bonus.reservedSpecialGross}
                  minimum={range.minimum}
                  maximum={range.maximum}
                />
              )}
            </FinancialData>
          </div>
          <div className="min-w-0 border-t border-border/70 pt-5 @2xl/bonus:border-t-0 @2xl/bonus:border-l @2xl/bonus:pt-0 @2xl/bonus:pl-8">
            <TaxExample bonus={bonus} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** "Sonderzahlung & Jahressechstel": next payment, sixth, the split of every special payment and bonus room. */
export function PayrollResults({ view }: { view: PayrollPresentation }) {
  return (
    <section aria-labelledby="payroll-special-title" className="min-w-0 space-y-4 pt-2">
      <div className="flex items-center gap-0.5">
        <h2 id="payroll-special-title" className="font-semibold tracking-tight">
          Sonderzahlung &amp; Jahressechstel
        </h2>
        <InfoTip label="Sonderzahlung & Jahressechstel" className={infoTip}>
          Urlaubs- und Weihnachtsgeld werden bis zum Jahressechstel begünstigt versteuert. Belegte Werte kommen aus
          deinen Abrechnungen, alles andere ist eine unverbindliche Schätzung.
        </InfoTip>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <NextPaymentCard view={view} />
        <SixthCard view={view} />
        <SixthSplitCard view={view} />
        <BonusCard view={view} />
      </div>
    </section>
  );
}
