"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Coins, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
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
  monthsForYear,
  roundUpTotal,
  sum,
} from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { pocketNames } from "@/lib/types";

export function Pockets() {
  const { state, dashboard: d, update } = useFinance();
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
  return (
    <>
      <PageHeading
        eyebrow="SPAREN & RESERVEN"
        title="Deine Pockets"
        description={`Ist-Stände zum ${dateLabel(state.settings.asOf)} · Gesamt ${currency(d.totalAssets)}`}
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
                <h2 className="text-sm font-medium">{pocket}</h2>
              </div>
              <p className="mt-6 text-[27px] font-semibold tracking-tight tabular-nums">
                {currency(d.actual[pocket])}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Ziel {currency(targets[pocket])}
              </p>
              <div className="mt-5 flex justify-between border-t pt-4 text-[11px] text-muted-foreground">
                <span>Dezember 2027 · Plan</span>
                <span className="font-mono text-foreground">
                  {currency(d.timeline.at(-1)!.end[pocket])}
                </span>
              </div>
            </section>
          );
        })}
      </div>
      <section className="panel mb-6 p-5 sm:p-6">
        <SectionHeading
          title="Ist-Basis"
          subtitle="Revolut laut Auszug · Trade Republic laut Einstellungen"
        />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {pocketNames.map((pocket) => (
            <div key={pocket}>
              <label className="mb-2 block text-xs text-muted-foreground">
                {pocket}
                {pocket !== "Notgroschen" ||
                latestPocketSnapshot(state, pocket) ? (
                  <>
                    <Input
                      aria-label={`${pocket} Ist laut Auszug`}
                      className="mt-2 h-10 text-sm"
                      value={currency(d.actual[pocket])}
                      readOnly
                    />
                    <span className="mt-1 block text-[11px]">
                      {latestPocketSnapshot(state, pocket)
                        ? dateLabel(latestPocketSnapshot(state, pocket)!.date)
                        : `Basis ${dateLabel(state.settings.baselineDate)}`}
                    </span>
                  </>
                ) : (
                  <MoneyInput
                    className="mt-2 h-10 text-sm"
                    label={`${pocket} Ist-Basis`}
                    value={state.settings.balances[pocket]}
                    onCommit={(value) =>
                      update((current) => ({
                        ...current,
                        settings: {
                          ...current.settings,
                          balances: {
                            ...current.settings.balances,
                            [pocket]: value ?? 0,
                          },
                        },
                      }))
                    }
                  />
                )}
              </label>
            </div>
          ))}
        </div>
        <Link
          href="/einstellungen"
          className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Ist-Datum oder Ziele ändern
          <ArrowRight className="size-3" />
        </Link>
      </section>
      <div className="grid items-start gap-5 xl:grid-cols-[1.6fr_1fr]">
        <section className="panel overflow-hidden">
          <div className="p-5 pb-0">
            <SectionHeading
              title="Kontenverlauf & Prognose"
              subtitle="Start + Rate + Buchungen − Entnahme + Nettozinsen"
            />
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
        </section>
        <section className="panel overflow-hidden">
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
          <p className="flex items-center gap-2 border-t p-4 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0 text-primary" />
            Historische Round-ups sind in der Ist-Basis enthalten.
          </p>
        </section>
      </div>
    </>
  );
}
