"use client";

import type { Ref } from "react";
import { Pencil } from "lucide-react";
import { BankLogo } from "@/components/bank-logo";
import { Button } from "@/components/ui/button";
import { pocketColors, pocketIcons } from "@/components/finance-ui";
import { FinancialData } from "@/components/financial-data";
import { latestPocketSnapshot, latestTRBalance } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { pocketNames, type AppState, type PocketAmounts } from "@/lib/types";
import { cn } from "@/lib/utils";
import { bankPocketBalance, everydayPocketNames, physicalPocketBalance } from "@/lib/goals";

export function PocketBalanceCards({
  state,
  actual,
  disabled,
  editRef,
  onEdit,
}: {
  state: AppState;
  actual: PocketAmounts;
  disabled: boolean;
  editRef: Ref<HTMLButtonElement>;
  onEdit: () => void;
}) {
  return (
    <ul className="min-w-0 divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      {pocketNames.map((pocket) => {
        const Icon = pocketIcons[pocket];
        const bank = pocket === "Notgroschen" ? "Trade Republic" : "Revolut";
        const snapshot =
          pocket === "Notgroschen"
            ? latestTRBalance(state)
            : latestPocketSnapshot(state, pocket);
        const basis = physicalPocketBalance(state, pocket, actual);
        const bankBalance = bankPocketBalance(state, pocket, actual);
        const source = bankBalance === null ? "Kein eindeutiger belegter Startstand" : snapshot
          ? `${pocket === "Notgroschen" ? "Stand" : "Auszugbasis"} ${dateLabel(snapshot.date)}`
          : basis.source === "snapshot" ? "Auszugssaldo" : `Startstand ${dateLabel(state.settings.baselineDate)}`;
        return (
          <li key={pocket}>
            <article
              aria-label={`${pocket} Pocket`}
              className="flex min-h-16 min-w-0 items-center gap-3 px-4 py-3 sm:px-5"
            >
              <span
                className="flex size-10 shrink-0 items-center justify-center rounded-full"
                style={{ background: `color-mix(in srgb, ${pocketColors[pocket]} 12%, transparent)` }}
              >
                <Icon
                  className="size-4.5"
                  style={{ color: pocketColors[pocket] }}
                  aria-hidden="true"
                />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-medium">{pocket}</h3>
                <FinancialData as="p" className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                  <BankLogo bank={bank} size="xs" />
                  <span className="truncate">{bank} · <span>{source}</span></span>
                </FinancialData>
              </div>
              <FinancialData
                as="p"
                aria-label={`${pocket} Kontostand`}
                className={cn(
                  "shrink-0 text-right text-base font-semibold tabular-nums",
                  bankBalance !== null && bankBalance < 0 && "text-destructive",
                  bankBalance === null && "text-xs font-normal text-muted-foreground",
                )}
              >
                {bankBalance === null ? "Kontostand unbekannt" : currency(bankBalance)}
              </FinancialData>
              {pocket === "Notgroschen" && (
                <Button
                  ref={editRef}
                  variant="ghost"
                  size="icon"
                  className="-mr-2 size-10 shrink-0 text-muted-foreground"
                  aria-label="Kontostand aktualisieren"
                  title="Kontostand aktualisieren"
                  disabled={disabled}
                  onClick={onEdit}
                >
                  <Pencil className="size-4" aria-hidden="true" />
                </Button>
              )}
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export function EverydayPocketBalances({ state }: { state: AppState }) {
  const snapshots = new Map(
    [...(state.accountSnapshots ?? [])]
      .filter((item) => item.date <= state.settings.asOf)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((item) => [item.name, item]),
  );
  const known = everydayPocketNames.flatMap((name) => {
    const snapshot = snapshots.get(name);
    return snapshot ? [{ name, snapshot }] : [];
  });
  const missing = everydayPocketNames.filter((name) => !snapshots.has(name));
  return (
    <section
      aria-label="Revolut Alltagspockets"
      className="min-w-0 rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><BankLogo bank="Revolut" size="sm" />Revolut · Alltagspockets</h2>
        <span className="text-xs text-muted-foreground">Auszugssalden</span>
      </div>
      {known.length ? (
        <FinancialData as="dl" className={cn("-mx-4 divide-y divide-border/60 border-t border-border/60 sm:-mx-5", missing.length ? "border-b" : "-mb-4 sm:-mb-5")}>
          {known.map(({ name, snapshot }) => (
            <div
              key={name}
              className="flex min-h-12 min-w-0 items-center gap-3 px-4 py-2.5 sm:px-5"
            >
              <dt className="min-w-0 flex-1 truncate text-sm">{name}</dt>
              <dd className="text-2xs text-muted-foreground">
                {dateLabel(snapshot.date)}
              </dd>
              <dd
                className={cn(
                  "shrink-0 text-right text-sm font-semibold tabular-nums",
                  snapshot.balance < 0 && "text-destructive",
                )}
              >
                {currency(snapshot.balance)}
              </dd>
            </div>
          ))}
        </FinancialData>
      ) : (
        <FinancialData as="p" className="text-sm text-muted-foreground">
          Noch keine Auszugssalden vorhanden.
        </FinancialData>
      )}
      {!!known.length && !!missing.length && (
        <FinancialData as="p" className="mt-3 text-xs text-muted-foreground">
          Ohne Auszugssaldo: {missing.join(" · ")}
        </FinancialData>
      )}
    </section>
  );
}
