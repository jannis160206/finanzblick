"use client";

import type { Ref } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pocketColors, pocketIcons } from "@/components/finance-ui";
import { latestPocketSnapshot, latestTRBalance } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { pocketNames, type AppState, type PocketAmounts } from "@/lib/types";
import { cn } from "@/lib/utils";

const everydayNames = [
  "Mittagessen",
  "Lebensmittel",
  "Entertainment & Haushalt",
  "Tanken",
] as const;

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
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {pocketNames.map((pocket) => {
        const Icon = pocketIcons[pocket];
        const bank = pocket === "Notgroschen" ? "Trade Republic" : "Revolut";
        const snapshot =
          pocket === "Notgroschen"
            ? latestTRBalance(state)
            : latestPocketSnapshot(state, pocket);
        return (
          <article
            key={pocket}
            aria-label={`${pocket} Pocket`}
            className="min-w-0 rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/40">
                  <Icon
                    className="size-4.5"
                    style={{ color: pocketColors[pocket] }}
                    aria-hidden="true"
                  />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">{pocket}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">{bank}</p>
                </div>
              </div>
              {pocket === "Notgroschen" && (
                <Button
                  ref={editRef}
                  variant="ghost"
                  size="icon"
                  className="size-10 shrink-0 text-muted-foreground"
                  aria-label="Kontostand aktualisieren"
                  title="Kontostand aktualisieren"
                  disabled={disabled}
                  onClick={onEdit}
                >
                  <Pencil className="size-4" aria-hidden="true" />
                </Button>
              )}
            </div>
            <p
              aria-label={`${pocket} Kontostand`}
              className={cn(
                "mt-5 text-2xl font-semibold tracking-tight break-words tabular-nums",
                actual[pocket] < 0 && "text-destructive",
              )}
            >
              {currency(actual[pocket])}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {snapshot
                ? `${pocket === "Notgroschen" ? "Stand" : "Auszugbasis"} ${dateLabel(snapshot.date)}`
                : `Startstand ${dateLabel(state.settings.baselineDate)}`}
            </p>
          </article>
        );
      })}
    </div>
  );
}

export function EverydayPocketBalances({ state }: { state: AppState }) {
  const snapshots = new Map(
    [...(state.accountSnapshots ?? [])]
      .filter((item) => item.date <= state.settings.asOf)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((item) => [item.name, item]),
  );
  const known = everydayNames.flatMap((name) => {
    const snapshot = snapshots.get(name);
    return snapshot ? [{ name, snapshot }] : [];
  });
  const missing = everydayNames.filter((name) => !snapshots.has(name));
  return (
    <section
      aria-label="Revolut Alltagspockets"
      className="min-w-0 rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Revolut · Alltagspockets</h2>
        <span className="text-xs text-muted-foreground">Auszugssalden</span>
      </div>
      {known.length ? (
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {known.map(({ name, snapshot }) => (
            <div
              key={name}
              className="min-w-0 rounded-xl bg-muted/20 px-3 py-3"
            >
              <dt className="text-xs text-muted-foreground">{name}</dt>
              <dd
                className={cn(
                  "mt-2 text-lg font-semibold break-words tabular-nums",
                  snapshot.balance < 0 && "text-destructive",
                )}
              >
                {currency(snapshot.balance)}
              </dd>
              <dd className="mt-1 text-[11px] text-muted-foreground">
                {dateLabel(snapshot.date)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          Noch keine Auszugssalden vorhanden.
        </p>
      )}
      {!!known.length && !!missing.length && (
        <p className="mt-3 text-xs text-muted-foreground">
          Ohne Auszugssaldo: {missing.join(" · ")}
        </p>
      )}
    </section>
  );
}
