"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFinance } from "@/components/finance-provider";
import { PageHeading } from "@/components/finance-ui";
import { FinancialData } from "@/components/financial-data";
import { BudgetCard, BudgetSummary } from "@/components/budget-cards";
import { round, sum } from "@/lib/calc";
import { dateLabel, monthLabel } from "@/lib/format";
import { ledgerHref, parseBudgetGroup } from "@/lib/ledger-link";

const ledgerHrefFor = (id: string, month: string) => {
  const group = parseBudgetGroup(id);
  return group ? ledgerHref({ month, group }) : undefined;
};

export function Plan() {
  const {
    dashboard: { plan, currentMonth },
    state,
  } = useFinance();
  const [onlyOverBudget, setOnlyOverBudget] = useState(false);
  const rows = plan.rows.map((row) => ({
    ...row,
    remaining: round(row.total - row.actual),
  }));
  const overBudget = rows.filter((row) => row.remaining < 0);
  const visibleRows = onlyOverBudget ? overBudget : rows;
  const actual = round(sum(rows.map((row) => row.actual)));

  return (
    <>
      <PageHeading
        eyebrow="BUDGETDETAILS"
        title="Alltagsbudget"
        description={`${monthLabel(plan.currentMonth)} · Ist bis ${dateLabel(state.settings.asOf)}`}
        sensitiveDescription
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/umsaetze">
            Umsätze ansehen
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Button>
      </PageHeading>
      <div className="space-y-6">
        <BudgetSummary total={plan.total} actual={actual} />
        <section aria-labelledby="budget-positions">
          <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 id="budget-positions" className="font-semibold tracking-tight">
              Monatsbudgets
            </h2>
            <div
              className="flex flex-wrap gap-1"
              role="group"
              aria-label="Budgetansicht"
            >
              <Button
                size="sm"
                variant={onlyOverBudget ? "ghost" : "secondary"}
                aria-pressed={!onlyOverBudget}
                onClick={() => setOnlyOverBudget(false)}
              >
                Alle <FinancialData as="span">({rows.length})</FinancialData>
              </Button>
              <Button
                size="sm"
                variant={onlyOverBudget ? "secondary" : "ghost"}
                aria-pressed={onlyOverBudget}
                onClick={() => setOnlyOverBudget(true)}
              >
                Über Budget <FinancialData as="span">({overBudget.length})</FinancialData>
              </Button>
            </div>
          </header>
          {visibleRows.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visibleRows.map((row) => (
                <BudgetCard key={row.id} row={row} href={ledgerHrefFor(row.id, currentMonth)} />
              ))}
            </div>
          ) : (
            <FinancialData
              as="p"
              role="status"
              className="panel rounded-2xl p-6 text-sm text-muted-foreground"
            >
              Keine Budgetüberschreitungen bis zum angezeigten Stand.
            </FinancialData>
          )}
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Geteilte Ausgaben zählen mit deinem Eigenanteil. Erstattungen
            mindern das Ist. Der Budgetrest ist kein Kontostand und keine
            Sparempfehlung.
          </p>
        </section>
      </div>
    </>
  );
}
