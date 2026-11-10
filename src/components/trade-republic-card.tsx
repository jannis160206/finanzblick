"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { BankLogo } from "@/components/bank-logo";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { latestTRBalance } from "@/lib/calc";
import { currency, dateLabel, percent } from "@/lib/format";
import { trInterestRate, type TrInterestRate } from "@/lib/tr-interest";

const rateSource = (rate: TrInterestRate) => rate.source === "credits"
  ? `aus Zinsgutschriften (${rate.credits === 1 ? "1 Gutschrift" : `${rate.credits} Gutschriften`} seit ${dateLabel(rate.from)})`
  : rate.date ? `zuletzt gespeichert (${dateLabel(rate.date)})` : "zuletzt gespeichert";

/** Notgroschen at Trade Republic, read-only: balance from the bank connection, rate from the interest credits. */
export function TradeRepublicCard() {
  const { state } = useFinance();
  const balance = latestTRBalance(state);
  const rate = trInterestRate(state);
  return (
    <Card as="section" id="tr-zinsen" aria-labelledby="tr-zinsen-heading" className="scroll-mt-24">
      <CardHeader>
        <CardTitle id="tr-zinsen-heading" className="flex items-center gap-2.5 text-base">
          <BankLogo bank="Trade Republic" size="md" />
          Trade Republic
        </CardTitle>
        <CardDescription>Notgroschen · Kontostand aus der Bankverbindung, Zinssatz aus den Zinsgutschriften.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FinancialData as="dl" className="grid gap-4 rounded-2xl border border-border/70 bg-muted/15 p-4 sm:grid-cols-3 sm:p-5">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Kontostand</dt>
            <dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{balance ? currency(balance.balance) : "–"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Stand vom</dt>
            <dd className="mt-2 text-lg font-medium tabular-nums">{balance ? dateLabel(balance.date) : "–"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Zinssatz p.a.</dt>
            <dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{rate ? percent(rate.rate) : "–"}</dd>
            <dd className="mt-1 text-xs text-muted-foreground">{rate ? rateSource(rate) : "Noch keine Zinsgutschrift"}</dd>
          </div>
        </FinancialData>
        {!balance && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            Noch kein Kontostand von Trade Republic.
            <Link href="/einstellungen#bankverbindung"
              className="inline-flex min-h-10 items-center gap-1 rounded-md font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              Trade Republic unter Banken & Verbindungen verbinden
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
