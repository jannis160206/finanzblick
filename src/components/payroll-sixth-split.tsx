"use client";

import { Check, ChevronDown } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { payrollMonthName } from "@/components/payroll-month-select";
import type { PayrollPresentation } from "@/components/payroll-presentation";
import { PayrollCardHeading } from "@/components/payroll-ui";
import { Card, CardContent } from "@/components/ui/card";
import { currency } from "@/lib/format";
import { sixthPaymentLabel, type SixthPayment } from "@/lib/payroll-sixth";
import { cn } from "@/lib/utils";
import { specialFreeLimit } from "@/lib/wage-tax-at";

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const rate = new Intl.NumberFormat("de-AT", { maximumFractionDigits: 1 });
const bar = "block h-full transition-[width] duration-500 ease-soft motion-reduce:transition-none";

function Share({ swatch, value, label }: { swatch: string; value: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", swatch)} />
      <span className="amount">{currency(value)}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return <span className="whitespace-nowrap">{label} <span className="amount text-foreground">{currency(value)}</span></span>;
}

/** The exact calculation: SV first, then 0 % / 6 % within the sixth and the tariff on the overhang. */
function SplitDetails({ payment, year }: { payment: SixthPayment; year: number }) {
  const { tax } = payment;
  const reducedTax = tax.higherNet > 0 ? money(tax.reducedNet * 0.06) : tax.preferential;
  const underFreeLimit = tax.freeNet > 0 && tax.sixth <= specialFreeLimit(year);
  const rows = [
    tax.freeNet > 0 && { label: underFreeLimit ? "Freigrenze · 0 %" : "620-€-Freibetrag · 0 %", base: tax.freeNet, tax: 0 },
    tax.reducedNet > 0 && { label: "6 %", base: tax.reducedNet, tax: reducedTax },
    tax.higherNet > 0 && { label: "27 % / 35,75 %", base: tax.higherNet, tax: money(tax.preferential - reducedTax) },
    tax.overflowNet > 0 && {
      label: `Tarif · Ø ${rate.format(tax.tariff / tax.overflowNet * 100)} %`, base: tax.overflowNet, tax: tax.tariff,
    },
  ].filter((row) => row !== false);
  const matches = payment.printedTax !== undefined && Math.abs(payment.printedTax - tax.preferential) < 0.005;
  return (
    <div className="pb-4 md:pl-60">
      {payment.tariffTaxed ? (
        <p className="text-xs leading-relaxed text-muted-foreground">Laut Abrechnung ganz nach Tarif versteuert – nutzt das Sechstel nicht.</p>
      ) : (
        <p className="flex flex-wrap gap-x-1.5 gap-y-0.5 text-xs leading-relaxed text-muted-foreground">
          <Figure label="Sechstel" value={tax.sixth} />
          <span aria-hidden="true">·</span>
          <Figure label="davor genutzt" value={tax.usedBefore} />
          <span aria-hidden="true">·</span>
          <Figure label="frei" value={Math.max(0, money(tax.sixth - tax.usedBefore))} />
          {payment.estimatedSixth && <><span aria-hidden="true">·</span><span>fehlende Monate geschätzt</span></>}
        </p>
      )}
      <table className="mt-3 w-full max-w-md text-xs">
        <caption className="sr-only">Lohnsteuer {sixthPaymentLabel[payment.kind]} {payrollMonthName(payment.month)}</caption>
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="pb-1.5 text-left font-normal">Teil</th>
            <th scope="col" className="pb-1.5 text-right font-normal">nach SV</th>
            <th scope="col" className="pb-1.5 text-right font-normal">Lohnsteuer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row" className="py-1 pr-3 text-left font-normal">{row.label}</th>
              <td className="amount py-1 text-right whitespace-nowrap">{currency(row.base)}</td>
              <td className="amount py-1 pl-3 text-right whitespace-nowrap">{currency(row.tax)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border/70 font-medium">
            <th scope="row" className="pt-1.5 pr-3 text-left">Gesamt</th>
            <td className="amount pt-1.5 text-right whitespace-nowrap">{currency(money(tax.gross - tax.sv))}</td>
            <td className="amount pt-1.5 pl-3 text-right whitespace-nowrap">{currency(tax.tax)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <Figure label="SV" value={tax.sv} />
        <span aria-hidden="true">·</span>
        <Figure label="Netto" value={tax.net} />
        {payment.printedTax !== undefined && (
          <>
            <span aria-hidden="true">·</span>
            {matches
              ? <span className="inline-flex items-center gap-1 text-success"><Check aria-hidden="true" className="size-3.5" />wie Abrechnung</span>
              : <Figure label="Abrechnung" value={payment.printedTax} />}
          </>
        )}
      </p>
    </div>
  );
}

function SplitRow({ payment, year }: { payment: SixthPayment; year: number }) {
  const { tax } = payment;
  const scale = Math.max(tax.gross, tax.eligibleGross + tax.overflowGross);
  const width = (value: number) => ({ width: `${(value / scale) * 100}%` });
  const taxFree = tax.eligibleGross > 0 && tax.reducedNet + tax.higherNet === 0;
  return (
    <li>
      <details className="group/split">
        <summary className="-mx-2 grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 rounded-xl px-2 py-3.5 transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{sixthPaymentLabel[payment.kind]}</span>
            <span className="block text-xs text-muted-foreground">
              {payrollMonthName(payment.month)}-Abrechnung · {payment.source === "payslip" ? "belegt" : "geschätzt"}
            </span>
          </span>
          <span className="flex items-center gap-1.5 md:order-last">
            <span className="amount text-sm">{currency(tax.gross)}</span>
            <span className="sr-only">brutto</span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-soft group-open/split:rotate-180 motion-reduce:transition-none"
            />
          </span>
          <span className="col-span-2 min-w-0 md:col-span-1">
            <span aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-muted">
              {tax.eligibleGross > 0 && <span className={cn(bar, "bg-chart-1")} style={width(tax.eligibleGross)} />}
              {tax.overflowGross > 0 && (
                <span className={cn(bar, "border-l-2 border-card bg-destructive first:border-l-0")} style={width(tax.overflowGross)} />
              )}
            </span>
            <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {tax.eligibleGross > 0 && <Share swatch="bg-chart-1" value={tax.eligibleGross} label={taxFree ? "steuerfrei" : "zu 6 %"} />}
              {tax.overflowGross > 0 && <Share swatch="bg-destructive" value={tax.overflowGross} label="voll versteuert" />}
            </span>
          </span>
        </summary>
        <SplitDetails payment={payment} year={year} />
      </details>
    </li>
  );
}

/** "Besteuerung je Sonderzahlung": how much of each special payment is taxed at 6 % and how much by the tariff. */
export function SixthSplitCard({ view }: { view: PayrollPresentation }) {
  const { year, analysis } = view;
  const payments = analysis.specialPayments;
  if (!payments.length) return null;
  return (
    <Card as="section" aria-labelledby="payroll-split-title" className="min-w-0 lg:col-span-2">
      <CardContent>
        <PayrollCardHeading
          id="payroll-split-title"
          title="Besteuerung je Sonderzahlung"
          subtitle={`Jahressechstel ${year} · 6 % im Sechstel, darüber Tarif`}
          info={
            <>
              Sonderzahlungen sind bis zum Jahressechstel (zwei durchschnittliche laufende Monatsbezüge) begünstigt: Nach
              Abzug der SV bleiben einmal im Jahr 620 € steuerfrei, der Rest kostet 6 % Lohnsteuer. Was das Sechstel
              übersteigt, wird mit dem laufenden Gehalt des Monats voll nach Tarif versteuert. Ein Klick zeigt die
              genaue Rechnung.
            </>
          }
        />
        <FinancialData as="ul" aria-label={`Sonderzahlungen ${year}`} className="mt-2 divide-y divide-border/70">
          {payments.map((payment) => (
            <SplitRow key={`${payment.month}-${payment.kind}`} payment={payment} year={year} />
          ))}
        </FinancialData>
      </CardContent>
    </Card>
  );
}
