"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFinance } from "@/components/finance-provider";
import {
  PageHeading,
  SectionHeading,
} from "@/components/finance-ui";
import { currency, dateLabel, monthLabel } from "@/lib/format";

export function Plan() {
  const {
    dashboard: { plan },
    state,
  } = useFinance();
  return (
    <>
      <PageHeading
        eyebrow="VARIABLE AUSGABEN"
        title="Alltagsbudget"
        description={`${monthLabel(plan.currentMonth)} · Feste Monatsbudgets`}
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/umsaetze">
            Zugehörige Umsätze ansehen
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </PageHeading>
      <div className="panel mb-5 border-primary/30 bg-primary/5 p-5">
        <p className="text-xs">Alltagsbudget</p>
        <p className="mt-3 text-2xl font-semibold text-primary">
          {currency(plan.total)}
        </p>
      </div>
      <details>
        <summary className="mb-4 cursor-pointer text-sm">
          Budgetberechnung
        </summary>
        <div className="panel mb-6 p-5 text-sm">
          Mittagessen: {plan.lunch.homeOfficeDays} Homeoffice-Tage × 5,00 € + {plan.lunch.officeDays} Bürotage × 5,50 € = {currency(plan.lunch.total)}
          <p className="mt-2 text-xs text-muted-foreground">Feiertage und gespeicherte Urlaubszeiträume zählen nicht als Arbeitstage.</p>
        </div>
        <section className="panel overflow-hidden">
          <div className="p-5 pb-0">
            <SectionHeading
              title="Monatsbudgets"
              subtitle={`Plan bleibt fest · Ist aus vorhandenen Buchungen bis ${dateLabel(state.settings.asOf)}`}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Position</th>
                  <th className="text-right">Plan</th>
                  <th className="text-right">Ist</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="font-medium">{row.label}</td>
                    <td className="text-right font-mono font-semibold whitespace-nowrap">
                      {currency(row.total)}
                    </td>
                    <td className="text-right font-mono whitespace-nowrap">{currency(row.actual)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="font-semibold">
                    Monatsbudget
                  </td>
                  <td className="text-right font-mono font-semibold text-primary">
                    {currency(plan.total)}
                  </td>
                  <td className="text-right font-mono font-semibold">
                    {currency(plan.rows.reduce((total, row) => total + row.actual, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      </details>
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {plan.rows.map((row) => (
          <div
            className="panel flex items-center justify-between p-4"
            key={row.id}
          >
            <span className="text-sm text-muted-foreground">
              {row.label}
            </span>
            <span className="text-right text-sm">
              <span className="block font-mono">{currency(row.total)} <span className="font-sans text-xs text-muted-foreground">Plan</span></span>
              <span className="mt-1 block text-xs text-muted-foreground">{currency(row.actual)} Ist</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
