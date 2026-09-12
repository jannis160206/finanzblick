"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Calculator } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFinance } from "@/components/finance-provider";
import {
  EmptyState,
  PageHeading,
  SectionHeading,
} from "@/components/finance-ui";
import { currency, monthLabel, percent } from "@/lib/format";
import { planWeights } from "@/lib/calc";
import { cn } from "@/lib/utils";

export function Plan() {
  const {
    dashboard: { plan },
  } = useFinance();
  const [showAll, setShowAll] = useState(true);
  const rows = plan.rows.filter((row) => showAll || row.eligible);
  return (
    <>
      <PageHeading
        eyebrow="VARIABLE AUSGABEN"
        title="Dein variabler Plan"
        description={`${monthLabel(plan.months[0])} – ${monthLabel(plan.currentMonth)} · Automatisch aus deinen Umsätzen`}
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/umsaetze">
            Umsätze bearbeiten
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </PageHeading>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Historisch gewichtet",
            value: currency(plan.historicalTotal),
            note: "Vier abgeschlossene Monate",
          },
          {
            label: "Aktueller Monat",
            value: currency(plan.currentTotal),
            note: `${percent(plan.currentFactor)} Monatsanteil`,
          },
          {
            label: "Wiederkehrende Händler",
            value: String(plan.eligibleCount),
            note: "In mindestens 2 von 4 Monaten",
          },
          {
            label: "Variabler Monatsplan",
            value: currency(plan.total),
            note: "Basis für die Monatsplanung",
          },
        ].map((item, index) => (
          <div
            className={cn(
              "panel p-5",
              index === 3 && "border-primary/30 bg-primary/5",
            )}
            key={item.label}
          >
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p
              className={cn(
                "mt-4 text-2xl font-semibold tracking-tight tabular-nums",
                index === 3 && "text-primary",
              )}
            >
              {item.value}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {item.note}
            </p>
          </div>
        ))}
      </div>
      <section className="panel overflow-hidden">
        <div className="p-5 pb-0">
          <SectionHeading
            title="Händler & Gewichtung"
            subtitle="Geladene Buchungen nach Händler und Kategorie zusammengefasst"
          >
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="accent-primary"
                checked={showAll}
                onChange={(event) => setShowAll(event.target.checked)}
              />
              Auch einmalige Händler
            </label>
          </SectionHeading>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Händler</th>
                <th>Kategorie</th>
                {plan.months.map((month, index) => (
                  <th className="text-right whitespace-nowrap" key={month}>
                    {monthLabel(month, true)}
                    <span className="mt-1 block font-normal text-muted-foreground">
                      {percent(planWeights[index])}
                    </span>
                  </th>
                ))}
                <th className="text-right whitespace-nowrap">
                  {monthLabel(plan.currentMonth, true)}
                  <span className="mt-1 block font-normal">
                    × {percent(plan.currentFactor)}
                  </span>
                </th>
                <th className="text-center">Monate</th>
                <th className="text-right">Plan</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.merchant}-${row.category}`}
                  className={!row.eligible ? "opacity-50" : ""}
                >
                  <td
                    className="max-w-60 truncate font-medium"
                    title={row.merchant}
                  >
                    {row.merchant}
                  </td>
                  <td className="text-xs text-muted-foreground">
                    {row.category}
                  </td>
                  {row.values.map((value, index) => (
                    <td
                      key={index}
                      className="text-right font-mono whitespace-nowrap"
                    >
                      {currency(value)}
                    </td>
                  ))}
                  <td className="text-right font-mono whitespace-nowrap">
                    {currency(row.current)}
                  </td>
                  <td className="text-center">
                    <span
                      className={cn(
                        "status-pill whitespace-nowrap",
                        row.eligible
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {row.appearances} / 4
                    </span>
                  </td>
                  <td className="text-right font-mono font-semibold whitespace-nowrap">
                    {currency(row.planned)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={8} className="font-semibold">
                  Gewichteter Monatsplan
                </td>
                <td className="text-right font-mono font-semibold text-primary">
                  {currency(plan.total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {!rows.length && (
          <EmptyState
            title="Noch keine passenden Händler"
            description="Für den Plan werden Umsätze aus mindestens zwei der vier abgeschlossenen Monate benötigt."
          />
        )}
      </section>
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {plan.byCategory.map((row) => (
          <div
            className="panel flex items-center justify-between p-4"
            key={row.category}
          >
            <span className="text-sm text-muted-foreground">
              {row.category}
            </span>
            <span className="font-mono text-sm">{currency(row.total)}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
        <Calculator className="size-4" />
        Planwerte sind schreibgeschützt. Abweichende Monatsbudgets lassen sich
        unter „Monate“ setzen.
      </div>
    </>
  );
}
