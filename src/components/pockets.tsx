"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { PageHeading } from "@/components/finance-ui";
import { FinancialData } from "@/components/financial-data";
import {
  PocketBalanceCards,
  EverydayPocketBalances,
} from "@/components/pocket-balance-cards";
import { PocketForecast, PocketRoundUps } from "@/components/pocket-details";
import { sum } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { pocketNames } from "@/lib/types";
import { bankPocketBalance } from "@/lib/goals";

export function Pockets() {
  const { state, dashboard } = useFinance();
  const balances = pocketNames.map((pocket) => bankPocketBalance(state, pocket, dashboard.actual));
  const total = sum(balances.map((amount) => amount ?? 0));
  const incomplete = balances.some((amount) => amount === null);
  return (
    <>
      <PageHeading
        title="Sparen"
        description={`Stand ${dateLabel(state.settings.asOf)}`}
        sensitiveDescription
      />
      <div className="mb-5 overflow-hidden rounded-3xl border border-border/70 bg-gradient-to-br from-primary/10 via-card to-card shadow-sm">
        <div aria-label="Reserven gesamt" className="px-5 pt-5 pb-4 sm:px-6">
          <p className="text-xs font-medium text-muted-foreground">Reserven gesamt</p>
          <FinancialData as="p" className="mt-1 break-words text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
            {currency(total)}
          </FinancialData>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {incomplete ? "Unvollständig · unbekannte Kontostände nicht enthalten" : pocketNames.join(" · ")}
          </p>
        </div>
        <FinancialData as="dl" className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3 sm:px-6">
          <dt className="text-xs text-muted-foreground">Guthaben gesamt <span className="hidden sm:inline">· inkl. Alltagskonten</span></dt>
          <dd className="truncate text-base font-semibold tabular-nums">{currency(dashboard.totalAssets)}</dd>
        </FinancialData>
      </div>
      <section aria-label="Sparen und Reserven" className="mb-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Sparen & Reserven</h2>
          <Link
            href="/sparen#sparziele"
            className="inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            Sparziele
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
        <PocketBalanceCards state={state} actual={dashboard.actual} />
      </section>
      <EverydayPocketBalances state={state} />
      <div className="mt-5 grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <PocketForecast dashboard={dashboard} state={state} />
        <PocketRoundUps state={state} />
      </div>
    </>
  );
}
