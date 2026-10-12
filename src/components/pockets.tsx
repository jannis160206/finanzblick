"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { PageHeading } from "@/components/finance-ui";
import { FinancialData } from "@/components/financial-data";
import {
  PocketBalanceCards,
  EverydayPocketBalances,
} from "@/components/pocket-balance-cards";
import { PocketForecast, PocketRoundUps } from "@/components/pocket-details";
import { TRBalanceDialog } from "@/components/tr-balance-dialog";
import { sum } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { pocketNames } from "@/lib/types";

export function Pockets() {
  const { state, dashboard, storageError } = useFinance();
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const goalsLink = useRef<HTMLAnchorElement>(null);
  const total = sum(pocketNames.map((pocket) => dashboard.actual[pocket]));
  return (
    <>
      <PageHeading
        eyebrow="SPAREN & RESERVEN"
        title="Deine Pockets"
        description={`Stand ${dateLabel(state.settings.asOf)}`}
        sensitiveDescription
      >
        <div
          aria-label="Reserven gesamt"
          className="min-w-0 rounded-xl border border-border/70 bg-card px-4 py-3"
        >
          <p className="text-xs text-muted-foreground">Reserven gesamt</p>
          <FinancialData
            as="p"
            className="mt-1 text-2xl font-semibold tracking-tight tabular-nums"
          >
            {currency(total)}
          </FinancialData>
        </div>
      </PageHeading>
      <section aria-label="Sparen und Reserven" className="mb-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Sparen & Reserven</h2>
          <Link
            ref={goalsLink}
            href="/einstellungen#sparziele"
            className="inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            Sparziele
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
        <PocketBalanceCards
          state={state}
          actual={dashboard.actual}
          disabled={!!storageError}
          editRef={editButton}
          onEdit={() => setEditing(true)}
        />
      </section>
      <EverydayPocketBalances state={state} />
      <div className="mt-5 grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <PocketForecast dashboard={dashboard} />
        <PocketRoundUps state={state} />
      </div>
      {editing && (
        <TRBalanceDialog
          close={() => setEditing(false)}
          returnFocus={() => {
            if (editButton.current && !editButton.current.disabled)
              editButton.current.focus();
            else goalsLink.current?.focus();
          }}
        />
      )}
    </>
  );
}
