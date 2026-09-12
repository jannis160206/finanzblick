"use client";

import Link from "next/link";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bike,
  CalendarDays,
  Check,
  CircleAlert,
  Wallet,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { useFinance } from "@/components/finance-provider";
import { SeasonalAtmosphere } from "@/components/seasonal-atmosphere";
import {
  EmptyState,
  PageHeading,
  SectionHeading,
  pocketColors,
  pocketIcons,
} from "@/components/finance-ui";
import { currency, dateLabel, monthLabel, shortCurrency } from "@/lib/format";
import { pocketNames } from "@/lib/types";
import { cn } from "@/lib/utils";

const chartTooltip = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  color: "var(--foreground)",
  fontSize: 12,
};
const chartColors = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];
const tooltipCurrency = (value: unknown) => currency(Number(value));

export function Overview() {
  const { state, dashboard: d } = useFinance();
  const rates = d.timeline.find((row) => row.month === d.currentMonth)?.rates;
  const monthSplit = (
    ["Motorrad", "Sparkonto", "Urlaub", "Notgroschen"] as const
  )
    .filter((pocket) => (rates?.[pocket] ?? 0) !== 0)
    .map((pocket) => `${pocket} ${currency(rates![pocket])}`);
  const kpis = [
    {
      label: "Ersparnisse gesamt",
      value: d.totalAssets,
      note: "Ist · alle vier Pockets",
      icon: Wallet,
      color: "text-primary",
    },
    {
      label: "Einnahmen · Plan",
      value: d.current.income,
      note: `Erhalten: ${currency(d.current.received)}`,
      icon: ArrowDownLeft,
      color: "text-primary",
    },
    {
      label: "Ausgaben · Ist",
      value: d.current.actualSpending,
      note: "Ohne Umbuchungen",
      icon: ArrowUpRight,
      color: "text-chart-4",
    },
    {
      label: "Überschuss · Plan",
      value: d.current.surplus,
      note: "Nach Fixkosten & Variablen",
      icon: Wallet,
      color: d.current.surplus >= 0 ? "text-primary" : "text-destructive",
    },
  ];
  const forecast = d.timeline
    .filter((row) => row.available && row.month >= d.currentMonth)
    .slice(0, 12)
    .map((row) => ({ ...row, label: monthLabel(row.month, true) }));
  return (
    <>
      <div className="seasonal-hero relative isolate">
        <SeasonalAtmosphere placement="hero" />
        <PageHeading
          eyebrow="DEIN FINANZCOCKPIT"
          title="Übersicht"
          description={`Berechnet für ${dateLabel(state.settings.asOf)} · Alle Beträge in Euro`}
        >
          <span className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
            <CalendarDays className="size-4 text-muted-foreground" />
            {monthLabel(d.currentMonth)}
          </span>
          <Button asChild size="sm">
            <Link href="/umsaetze">
              Kontoauszüge importieren
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </PageHeading>
      </div>
      {monthSplit.length > 0 && (
        <section
          className="panel mb-5 px-4 py-3 text-sm"
          aria-label="Pocket-Verteilung diesen Monat"
        >
          <span className="font-medium">Diesen Monat:</span>{" "}
          {monthSplit.join(" · ")}
        </section>
      )}
      {(d.missingFixed.length > 0 ||
        state.importStatus ||
        state.reviewQueue?.length) && (
        <p
          className="mb-5 text-xs text-muted-foreground"
          aria-label="Auszugsstatus"
        >
          <Link href="/umsaetze">
            Auszugsstatus: Übernommen {state.importStatus?.imported ?? 0} ·
            offen {state.reviewQueue?.length ?? 0} · nicht lesbar{" "}
            {state.importStatus?.issues.length ?? 0}
          </Link>
          {d.missingFixed.length > 0 &&
            ` · ${d.missingFixed.length} Fixkosten ohne Auszugsbeleg`}
        </p>
      )}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <section key={kpi.label} className="panel p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                {kpi.label}
              </p>
              <kpi.icon className={cn("size-4", kpi.color)} />
            </div>
            <p className="mt-5 text-[28px] font-semibold tracking-tight tabular-nums">
              {currency(kpi.value)}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">{kpi.note}</p>
          </section>
        ))}
      </div>
      <div className="mb-6 grid gap-5 xl:grid-cols-[1.45fr_1fr]">
        <section className="panel p-5 sm:p-6">
          <SectionHeading
            title="Deine Pockets"
            subtitle="Ist-Stände, nicht Prognose"
          >
            <Link
              href="/pockets"
              className="text-xs text-primary hover:underline"
            >
              Alle Pockets <ArrowUpRight className="inline size-3" />
            </Link>
          </SectionHeading>
          <div className="grid gap-3 sm:grid-cols-2">
            {pocketNames.map((pocket) => {
              const Icon = pocketIcons[pocket];
              return (
                <Link
                  href="/pockets"
                  key={pocket}
                  className="group rounded-xl border bg-background/40 p-4 transition-colors hover:border-muted-foreground/40"
                >
                  <div className="mb-4 flex items-center justify-between">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Icon
                        className="size-4"
                        style={{ color: pocketColors[pocket] }}
                      />
                      {pocket === "Notgroschen"
                        ? "Notgroschen · Trade Republic"
                        : pocket}
                    </span>
                    <ArrowUpRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  </div>
                  <p className="text-xl font-semibold tabular-nums">
                    {currency(d.actual[pocket])}
                  </p>
                  {pocket === "Sparkonto" && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Round-up · {monthLabel(d.currentMonth, true)}: +{" "}
                      {currency(d.currentRoundUp)}
                    </p>
                  )}
                  <div className="mt-4 h-1 rounded-full bg-muted">
                    <div
                      className="h-full w-full rounded-full opacity-70"
                      style={{ background: pocketColors[pocket] }}
                    />
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
        <section className="panel seasonal-bike relative overflow-hidden p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Bike className="size-5 text-chart-4" />
              Projekt Motorrad
            </span>
            <span
              data-status={d.countdown.onTrack ? "positive" : "warning"}
              className={cn(
                "status-pill",
                d.countdown.onTrack
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-orange-500/10 text-orange-600 dark:text-orange-300",
              )}
            >
              {d.countdown.onTrack ? (
                <Check className="size-3" />
              ) : (
                <CircleAlert className="size-3" />
              )}
              {d.countdown.funded
                ? "Ziel erreicht"
                : d.countdown.overdue
                  ? "Termin überschritten"
                  : d.countdown.onTrack
                    ? "Im Plan"
                    : "Rate prüfen"}
            </span>
          </div>
          <div className="my-7 flex items-end justify-between gap-3">
            <div>
              <p className="eyebrow mb-2">NOCH BIS ZUM KAUF</p>
              <p className="text-5xl font-semibold tracking-tight">
                {d.countdown.days}
                <span className="ml-2 text-base font-normal text-muted-foreground">
                  Tage
                </span>
              </p>
            </div>
            <span className="text-right text-xs text-muted-foreground">
              {dateLabel(state.settings.bikePurchaseDate)}
              <br />
              <span className="mt-1 inline-block">
                Ziel {currency(state.settings.bikeTarget)}
              </span>
            </span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Motorradziel"
            aria-valuenow={d.countdown.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-chart-4 transition-all"
              style={{ width: `${d.countdown.progress}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{currency(d.actual.Motorrad)} angespart</span>
            <span>{d.countdown.progress.toFixed(1)} %</span>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4 border-t pt-5">
            <div>
              <p className="text-[11px] text-muted-foreground">
                Benötigt / Monat
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {currency(d.countdown.required)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">
                Geplant · {monthLabel(d.allocationMonth, true)}
              </p>
              <p
                className={cn(
                  "mt-1 text-lg font-semibold tabular-nums",
                  d.countdown.onTrack ? "text-primary" : "text-chart-4",
                )}
              >
                {currency(d.nextTransfer)}
              </p>
            </div>
          </div>
          <Link
            href="/einstellungen#motorrad"
            className="mt-5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Sparziel anpassen <ArrowRight className="size-3" />
          </Link>
        </section>
      </div>
      <section className="panel mb-6 overflow-hidden">
        <div className="px-5 pt-5 sm:px-6">
          <SectionHeading
            title="Die nächsten 90 Tage"
            subtitle="Einnahmen − Fixkosten − Alltagsbudget − Motorradrate"
          >
            <span className="status-pill border text-muted-foreground">
              Prognose
            </span>
          </SectionHeading>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Monat</th>
                <th className="text-right">Einnahmen</th>
                <th className="text-right">Fixkosten</th>
                <th className="text-right">Alltagsbudget</th>
                <th className="text-right">Motorrad</th>
                <th className="text-right">Rest nach Motorradrate</th>
              </tr>
            </thead>
            <tbody>
              {d.ninetyDays.map((row, i) => (
                <tr key={row.month}>
                  <td className="font-medium">
                    {monthLabel(row.month)}
                    {i === 0 && (
                      <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                        Aktuell
                      </span>
                    )}
                  </td>
                  <td className="text-right font-mono">
                    {currency(row.income)}
                  </td>
                  <td className="text-right font-mono text-muted-foreground">
                    {currency(row.fixed)}
                  </td>
                  <td className="text-right font-mono text-muted-foreground">
                    {currency(row.variablePlan)}
                  </td>
                  <td className="text-right font-mono text-chart-4">
                    {currency(row.bikeTransfer)}
                  </td>
                  <td
                    className={cn(
                      "text-right font-mono font-semibold",
                      row.remaining >= 0 ? "text-primary" : "text-destructive",
                    )}
                  >
                    {currency(row.remaining)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <section className="panel min-w-0 p-5 sm:p-6">
          <SectionHeading
            title="Vermögensentwicklung"
            subtitle="Pocket-Prognose inklusive Nettozinsen · 12 Monate"
          />
          <div
            className="h-64"
            role="img"
            aria-label="Prognose des gesamten Pocket-Vermögens"
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={forecast}
                margin={{ left: -15, right: 8, top: 10 }}
              >
                <CartesianGrid
                  stroke="var(--border)"
                  vertical={false}
                  strokeDasharray="3 4"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={25}
                />
                <YAxis
                  tickFormatter={shortCurrency}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={chartTooltip}
                  formatter={tooltipCurrency}
                />
                <Area
                  type="monotone"
                  dataKey="total"
                  name="Vermögen"
                  stroke="var(--chart-1)"
                  fill="var(--chart-1)"
                  fillOpacity={0.08}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="panel min-w-0 p-5 sm:p-6">
          <SectionHeading
            title="Ausgaben nach Kategorie"
            subtitle={`Ist · ${monthLabel(d.currentMonth)}`}
          />
          {d.spending.length ? (
            <div className="flex min-h-64 flex-col items-center gap-3 sm:flex-row">
              <div
                className="h-52 w-full sm:w-1/2"
                role="img"
                aria-label="Aktuelle Ausgaben nach Kategorie"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={d.spending}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="64%"
                      outerRadius="88%"
                      paddingAngle={3}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {d.spending.map((row, i) => (
                        <Cell
                          key={row.name}
                          fill={chartColors[i % chartColors.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={chartTooltip}
                      formatter={tooltipCurrency}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="w-full space-y-3 sm:w-1/2">
                {d.spending.map((row, i) => (
                  <div
                    key={row.name}
                    className="flex items-center justify-between gap-3 text-[11px]"
                  >
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{
                          background: chartColors[i % chartColors.length],
                        }}
                      />
                      {row.name}
                    </span>
                    <span className="font-mono">{currency(row.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState
              title="Noch keine Ausgaben"
              description="Erfasste Umsätze erscheinen hier automatisch."
            />
          )}
        </section>
        <section className="panel min-w-0 p-5 sm:p-6 xl:col-span-2">
          <SectionHeading
            title="Einnahmen & Ausgaben"
            subtitle="Monatliche Planung · nächste sechs Monate"
          >
            <div className="flex gap-4 text-[11px] text-muted-foreground">
              <span>
                <i className="mr-1.5 inline-block size-2 rounded-sm bg-chart-1" />
                Einnahmen
              </span>
              <span>
                <i className="mr-1.5 inline-block size-2 rounded-sm bg-chart-7" />
                Fixkosten
              </span>
              <span>
                <i className="mr-1.5 inline-block size-2 rounded-sm bg-chart-3" />
                Alltagsbudget
              </span>
            </div>
          </SectionHeading>
          <div
            className="h-56"
            role="img"
            aria-label="Einnahmen, Fixkosten und variable Ausgaben pro Monat"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={forecast.slice(0, 6)}
                margin={{ left: -15, right: 8 }}
                barGap={5}
              >
                <CartesianGrid
                  stroke="var(--border)"
                  vertical={false}
                  strokeDasharray="3 4"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={shortCurrency}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: "var(--muted)", opacity: 0.5 }}
                  contentStyle={chartTooltip}
                  formatter={tooltipCurrency}
                />
                <Bar
                  dataKey="income"
                  name="Einnahmen"
                  fill="var(--chart-1)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={30}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="fixed"
                  name="Fixkosten"
                  stackId="cost"
                  fill="var(--chart-7)"
                  maxBarSize={30}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="variablePlan"
                  name="Alltagsbudget"
                  stackId="cost"
                  fill="var(--chart-3)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={30}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>
    </>
  );
}
