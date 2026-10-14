"use client";

import { useState, type ReactNode } from "react";
import {
  CalendarRange,
  ChevronDown,
  Coins,
  type LucideIcon,
} from "lucide-react";
import { useCompactLayout } from "@/components/ui/use-compact-layout";
import { FinancialData } from "@/components/financial-data";
import { monthsForYear, roundUpTotal, sum, type Dashboard } from "@/lib/calc";
import { currency, monthLabel } from "@/lib/format";
import { pocketNames, type AppState, type Pocket } from "@/lib/types";
import { pocketKey } from "@/lib/goals";

function PocketDisclosure({
  title,
  summary,
  icon: Icon,
  children,
}: {
  title: string;
  summary: ReactNode;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <details className="group min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 p-4 transition-colors hover:bg-muted/20 focus-visible:outline-2 focus-visible:outline-ring sm:px-5 [&::-webkit-details-marker]:hidden">
        <Icon
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 text-sm font-medium">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {summary}
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      {children}
    </details>
  );
}

function PocketYearSelect({
  label,
  year,
  onChange,
}: {
  label: string;
  year: number;
  onChange: (year: number) => void;
}) {
  return (
    <select
      aria-label={label}
      className="select-input min-h-10 min-w-0"
      value={year}
      onChange={(event) => {
        const value = [2026, 2027].find(
          (item) => String(item) === event.target.value,
        );
        if (value) onChange(value);
      }}
    >
      <option value="2026">2026</option>
      <option value="2027">2027</option>
    </select>
  );
}

export function PocketForecast({ dashboard }: { dashboard: Dashboard; state?: AppState }) {
  const compact = useCompactLayout();
  const [selectedYear, setYear] = useState<number | null>(null);
  const [selectedPocket, setPocket] = useState<Pocket | "all" | null>(null);
  const year = selectedYear ?? Number(dashboard.currentMonth.slice(0, 4));
  const pocket = selectedPocket ?? (compact ? "Sparkonto" : "all");
  const shown = pocket === "all" ? pocketNames : [pocket];
  const rows = dashboard.timeline.filter(
    (row) => row.available && row.month.startsWith(String(year)),
  );
  return (
    <PocketDisclosure
      title="Verlauf & Prognose"
      summary={String(year)}
      icon={CalendarRange}
    >
      <div className="flex flex-wrap gap-3 border-t border-border/60 p-4 sm:px-5">
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">
          Pocket
          <select
            aria-label="Prognose-Pocket"
            className="select-input mt-1.5 min-h-10 w-full min-w-0"
            value={pocket}
            onChange={(event) => {
              const value = pocketNames.find(
                (item) => item === event.target.value,
              );
              if (event.target.value === "all") setPocket("all");
              else if (value) setPocket(value);
            }}
          >
            <option value="all">Alle Pockets</option>
            {pocketNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col text-xs text-muted-foreground">
          Jahr
          <div className="mt-1.5">
            <PocketYearSelect
              label="Prognosejahr"
              year={year}
              onChange={setYear}
            />
          </div>
        </label>
        <p className="w-full text-2xs text-muted-foreground">
          Berechnete Monatsendwerte · keine bestätigten Kontostände.
        </p>
      </div>
      {rows.length ? (
        <div
          className="max-h-96 overflow-auto"
          tabIndex={0}
          aria-label="Pocket-Prognose scrollen"
        >
          <table className="data-table w-full" aria-label="Pocket-Prognose">
            <thead className="sticky top-0 z-10">
              <tr>
                <th scope="col">Monat</th>
                {shown.map((name) => (
                  <th key={name} scope="col" className="text-right">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <FinancialData as="tbody">
              {rows.map((row) => (
                <tr key={row.month}>
                  <th
                    scope="row"
                    className="text-left text-xs font-normal whitespace-nowrap"
                  >
                    {monthLabel(row.month, true)}
                  </th>
                  {shown.map((name) => (
                    <td
                      key={name}
                      className="text-right text-xs whitespace-nowrap tabular-nums"
                    >
                      {row.physicalEnd[pocketKey(name)] === null ? "Unbekannt" : currency(row.end[name])}
                    </td>
                  ))}
                </tr>
              ))}
            </FinancialData>
          </table>
        </div>
      ) : (
        <FinancialData as="p" className="border-t p-4 text-sm text-muted-foreground">
          Für {year} sind keine Planwerte verfügbar.
        </FinancialData>
      )}
    </PocketDisclosure>
  );
}

export function PocketRoundUps({ state }: { state: AppState }) {
  const [selectedYear, setYear] = useState<number | null>(null);
  const year = selectedYear ?? Number(state.settings.asOf.slice(0, 4));
  const bookings = state.transactions.filter(
    (row) => row.date <= state.settings.asOf,
  );
  const rows = monthsForYear(year)
    .map((month) => ({ month, amount: roundUpTotal(bookings, month) }))
    .filter((row) => row.amount > 0);
  const total = sum(rows.map((row) => row.amount));
  return (
    <PocketDisclosure
      title="Round-ups"
      summary={
        <FinancialData as="span">{`${year} · ${currency(total)}`}</FinancialData>
      }
      icon={Coins}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 p-4 sm:px-5">
        <p className="text-xs text-muted-foreground">
          Ins Sparkonto · Umbuchungen, keine Ausgaben.
        </p>
        <PocketYearSelect
          label="Round-up Jahr"
          year={year}
          onChange={setYear}
        />
      </div>
      {rows.length ? (
        <table className="data-table w-full" aria-label="Round-ups">
          <thead>
            <tr>
              <th scope="col">Monat</th>
              <th scope="col" className="text-right">
                Round-up
              </th>
            </tr>
          </thead>
          <FinancialData as="tbody">
            {rows.map((row) => (
              <tr key={row.month}>
                <th scope="row" className="text-left text-xs font-normal">
                  {monthLabel(row.month, true)}
                </th>
                <td className="text-right tabular-nums">
                  {currency(row.amount)}
                </td>
              </tr>
            ))}
          </FinancialData>
        </table>
      ) : (
        <FinancialData as="p" className="border-t p-4 text-sm text-muted-foreground">
          Keine Round-ups für {year} gebucht.
        </FinancialData>
      )}
    </PocketDisclosure>
  );
}
