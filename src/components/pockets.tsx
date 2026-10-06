"use client";

import Link from "next/link";
import { useState } from "react";
import { Coins } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useFinance } from "@/components/finance-provider";
import {
  MoneyInput,
  PageHeading,
  SectionHeading,
  pocketColors,
  pocketIcons,
} from "@/components/finance-ui";
import {
  latestPocketSnapshot,
  latestTRBalance,
  monthsForYear,
  roundUpTotal,
  sum,
} from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { pocketNames, trBalanceSchema } from "@/lib/types";

function TRBalanceEditor() {
  const { state, update } = useFinance();
  const [balance, setBalance] = useState(
    latestTRBalance(state)?.balance ?? state.settings.balances.Notgroschen,
  );
  const [date, setDate] = useState(state.settings.asOf);
  const [saved, setSaved] = useState(false);
  const valid =
    trBalanceSchema.safeParse({ balance, date }).success &&
    date <= state.settings.asOf;
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        update((current) => ({
          ...current,
          trBalances: [
            ...(current.trBalances ?? []).filter((item) => item.date !== date),
            { balance, date },
          ],
        }));
        setSaved(true);
      }}
    >
      <label className="block text-xs">
        Kontostand
        <MoneyInput
          label="TR Kontostand"
          value={balance}
          onCommit={(value) => {
            setBalance(value ?? 0);
            setSaved(false);
          }}
        />
      </label>
      <label className="block text-xs">
        Datum
        <Input
          aria-label="TR Standdatum"
          type="date"
          max={state.settings.asOf}
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
            setSaved(false);
          }}
        />
      </label>
      <Button type="submit" size="sm" disabled={!valid}>
        Kontostand speichern
      </Button>
      {saved && (
        <p className="text-xs" role="status">
          Kontostand gespeichert
        </p>
      )}
    </form>
  );
}

export function Pockets() {
  const { state, dashboard: d } = useFinance();
  const [year, setYear] = useState(2026);
  const targets = {
    Notgroschen: state.settings.emergencyTarget,
    Urlaub: state.settings.vacationTarget,
    Sparkonto: state.settings.savingsTarget,
    Motorrad: state.settings.bikeTarget,
  };
  const roundUps = monthsForYear(year).map((month) => ({
    month,
    amount: roundUpTotal(state.transactions, month),
  }));
  const everyday = [
    "Mittagessen",
    "Lebensmittel",
    "Entertainment & Haushalt",
    "Tanken",
  ];
  const accounts = new Map(
    [...(state.accountSnapshots ?? [])]
      .filter((item) => item.date <= state.settings.asOf)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((item) => [item.name, item]),
  );
  return (
    <>
      <PageHeading
        eyebrow="SPAREN & RESERVEN"
        title="Deine Pockets"
        description={`Ist · ${dateLabel(state.settings.asOf)} · Gesamt ${currency(d.totalAssets)}`}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {pocketNames.map((pocket) => {
          const Icon = pocketIcons[pocket];
          return (
            <section className="panel p-5" key={pocket}>
              <div className="flex items-center gap-3">
                <span className="rounded-lg border bg-background p-2.5">
                  <Icon
                    className="size-5"
                    style={{ color: pocketColors[pocket] }}
                  />
                </span>
                <h2 className="text-sm font-medium">
                  {pocket === "Notgroschen"
                    ? "Notgroschen · Trade Republic"
                    : pocket}
                </h2>
              </div>
              <p
                aria-label={`${pocket} Kontostand`}
                className="mt-6 text-[27px] font-semibold tracking-tight tabular-nums"
              >
                {currency(d.actual[pocket])}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                <Link
                  href="/einstellungen#sparziele"
                >
                  {targets[pocket] > 0 ? `Ziel ${currency(targets[pocket])}` : "Kein Ziel festgelegt"}
                </Link>
              </p>
              <p className="mt-3 text-[11px] text-muted-foreground">
                {pocket === "Notgroschen"
                  ? `Trade Republic · Stand ${dateLabel(latestTRBalance(state)?.date ?? state.settings.baselineDate)}`
                  : latestPocketSnapshot(state, pocket)
                    ? `Revolut · Auszug ${dateLabel(latestPocketSnapshot(state, pocket)!.date)}`
                    : "Revolut · Startstand, noch kein Auszug"}
              </p>
              {pocket === "Notgroschen" && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-xs">
                    Kontostand aktualisieren
                  </summary>
                  <TRBalanceEditor />
                </details>
              )}
            </section>
          );
        })}
      </div>
      <section className="mb-6" aria-label="Revolut Alltagspockets">
        <SectionHeading title="Revolut · Alltagspockets" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {everyday.map((name) => {
            const snapshot = accounts.get(name);
            return (
              <section key={name} className="panel p-5">
                <h2 className="text-sm font-medium">{name}</h2>
                <p className="mt-4 text-xl font-semibold">
                  {snapshot ? currency(snapshot.balance) : "—"}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {snapshot
                    ? `Revolut · Auszug ${dateLabel(snapshot.date)}`
                    : "Noch kein Kontostand"}
                </p>
              </section>
            );
          })}
        </div>
      </section>
      <div className="grid items-start gap-5 xl:grid-cols-[1.6fr_1fr]">
        <details className="panel overflow-hidden">
          <summary className="cursor-pointer p-5 text-sm font-medium">
            Prognosedetails
          </summary>
          <div className="p-5 pb-0">
            <SectionHeading title="Kontenverlauf & Prognose" />
          </div>
          <div className="max-h-[600px] overflow-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Monat</th>
                  {pocketNames.map((pocket) => (
                    <th key={pocket} className="text-right">
                      {pocket}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.timeline
                  .filter((row) => row.available)
                  .map((row) => (
                    <tr key={row.month}>
                      <td className="whitespace-nowrap">
                        {monthLabel(row.month, true)}
                      </td>
                      {pocketNames.map((pocket) => (
                        <td
                          key={pocket}
                          className="text-right font-mono text-xs whitespace-nowrap"
                        >
                          {currency(row.end[pocket])}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
        <details className="panel overflow-hidden">
          <summary className="cursor-pointer p-5 text-sm font-medium">
            Sparkonto-Details
          </summary>
          <div className="p-5 pb-0">
            <SectionHeading
              title="Round-up → Sparkonto"
              subtitle="Umbuchungen, keine Ausgaben"
            >
              <Coins className="size-5 text-amber-400" />
            </SectionHeading>
            <div className="mb-5 flex items-center justify-between">
              <p className="text-2xl font-semibold tabular-nums">
                {currency(sum(roundUps.map((row) => row.amount)))}
              </p>
              <select
                aria-label="Round-up Jahr"
                className="select-input"
                value={year}
                onChange={(event) => setYear(Number(event.target.value))}
              >
                <option>2026</option>
                <option>2027</option>
              </select>
            </div>
          </div>
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Monat</th>
                <th className="text-right">Round-up</th>
              </tr>
            </thead>
            <tbody>
              {roundUps.map((row) => (
                <tr key={row.month}>
                  <td>{monthLabel(row.month, true)}</td>
                  <td className="text-right font-mono">
                    {currency(row.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </>
  );
}
