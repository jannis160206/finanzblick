"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bike,
  CalendarDays,
  Check,
  CircleAlert,
  ChevronDown,
  PiggyBank,
  ReceiptText,
  Target,
  Upload,
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
import { FinancialData } from "@/components/financial-data";
import { SeasonalIcon } from "@/components/seasonal-icons";
import {
  SectionHeading,
  pocketColors,
  pocketIcons,
} from "@/components/finance-ui";
import { currency, dateLabel, monthLabel, number, shortCurrency } from "@/lib/format";
import { pocketNames } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PlannedOneOffLines, PlannedOneOffs } from "@/components/planned-one-offs";
import { EmptyState } from "@/components/ui/empty-state";
import { goalBalanceStatus, physicalPocketBalance, physicalPocketBalances, pocketKey } from "@/lib/goals";

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
  const [showCashflow, setShowCashflow] = useState(false);
  const allocationBlocked = "allocationBlocked" in d.current && d.current.allocationBlocked === true;
  const monthSplit = d.monthlyFunding.some((item) => item.id === "savings") ? d.monthlyFunding : [
    { id: "savings", name: "Sparkonto", pocket: "Sparkonto", amount: 0, transferred: 0, done: false },
    ...d.monthlyFunding,
  ];
  const motorcycle = d.goals.find((goal) => pocketKey(goal.pocket) === "motorrad");
  const bikeBasis = motorcycle ? goalBalanceStatus(state, motorcycle, d.actual) : undefined;
  const bikeSaved = bikeBasis?.amount ?? null;
  const bikeUnknown = bikeBasis?.status === "conflict" ? "Zuordnung offen" : "Kontostand unbekannt";
  const incompleteAssets = Object.values(physicalPocketBalances(state, d.actual)).some((balance) => balance.amount === null);
  const bikeExtraLabel = (month: string) => month.slice(5) === "12" ? "Dec" :
    monthLabel(month, true).replace(/\s+\d{4}$/, "").replace(/\.$/, "");
  const kpis = [
    {
      label: "Überschuss · Plan",
      value: d.current.surplus,
      icon: Wallet,
      color: d.current.surplus >= 0 ? "text-primary" : "text-destructive",
      prominent: true,
      hint: "Nach Fixkosten, Alltagsbudget und geplanten Ausgaben.",
    },
    {
      label: "Einnahmen · Plan",
      value: d.current.salaryPlan,
      note: `Erhalten: ${currency(d.current.salaryReceived)}`,
      icon: ArrowDownLeft,
      color: "text-primary",
    },
    {
      label: "Ausgaben · Ist",
      value: d.current.actualSpending,
      icon: ArrowUpRight,
      color: "text-chart-4",
      hint: "Gebuchte Ausgaben ohne Umbuchungen.",
    },
    {
      label: "Ersparnisse gesamt",
      value: d.totalAssets,
      note: incompleteAssets ? "Unvollständig · unbekannte Guthaben nicht enthalten" : undefined,
      icon: PiggyBank,
      color: "text-primary",
    },
  ];
  const forecast = d.timeline
    .filter((row) => row.available && row.month >= d.currentMonth)
    .slice(0, 12)
    .map((row) => ({ ...row, label: monthLabel(row.month, true) }));
  const hasAssetForecast = forecast.some((row) => row.total !== 0);
  return (
    <>
      <div className="overview-heading mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <SeasonalIcon slot="overview" className="seasonal-detail size-4" fallback={<CalendarDays aria-hidden="true" className="size-4" />} />
            {monthLabel(d.currentMonth)}
            <FinancialData as="span" className="border-l border-border/70 pl-2 text-2xs">Stand {dateLabel(state.settings.asOf)}</FinancialData>
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-[34px]">Übersicht</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PlannedOneOffs className="min-h-11 rounded-xl" />
          <Button asChild size="sm" className="min-h-11 rounded-xl">
            <Link href="/umsaetze" aria-label="Kontoauszüge importieren"><Upload aria-hidden="true" className="size-4" />Importieren</Link>
          </Button>
        </div>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {kpis.map((kpi, index) => (
          <section key={kpi.label} aria-label={kpi.label} aria-describedby={kpi.hint ? `overview-metric-${index}-hint` : undefined} className={cn("panel min-w-0 p-4 sm:p-5",
            kpi.prominent ? cn("col-span-2 md:col-span-1", d.current.surplus >= 0 ? "border-primary/25 bg-primary/5" : "border-destructive/25 bg-destructive/5") :
              kpi.label === "Ersparnisse gesamt" ? "col-span-2 md:col-span-1" : "")}>
            <div className="flex items-start justify-between gap-2">
              <p title={kpi.hint} className="pt-2 text-xs font-medium text-muted-foreground">{kpi.label}</p>
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/60", kpi.color)}>
                {kpi.label === "Ausgaben · Ist" ? <SeasonalIcon slot="expense" className="seasonal-detail size-4" fallback={<kpi.icon aria-hidden="true" className="size-4" />} /> : <kpi.icon aria-hidden="true" className="size-4" />}
              </span>
            </div>
            <FinancialData as="p" className={cn("mt-4 break-words text-2xl font-semibold tracking-tight tabular-nums sm:text-[28px]", kpi.prominent && cn("text-3xl sm:text-[34px]", kpi.color))}>
              {currency(kpi.value)}
            </FinancialData>
            {kpi.note && <FinancialData as="p" className="mt-2 text-2xs text-muted-foreground">{kpi.note}</FinancialData>}
            {kpi.hint && <span id={`overview-metric-${index}-hint`} className="sr-only">{kpi.hint}</span>}
          </section>
        ))}
      </div>
      <div className="mb-5 grid gap-4 empty:hidden lg:grid-cols-2 [&>section:only-child]:col-span-full">
        <section
          className="panel min-w-0 p-4 sm:p-5"
          aria-label="Pocket-Verteilung diesen Monat"
        >
          <h2 className="mb-4 flex items-center gap-2 text-sm font-medium"><PiggyBank aria-hidden="true" className="size-4 text-muted-foreground" />Monatsverteilung</h2>
          {allocationBlocked && <FinancialData as="p" role="status" className="mb-3 text-xs text-muted-foreground">
            Automatische Sparempfehlung pausiert: Kontostand oder Pocket-Zuordnung eines Ziels klären.
          </FinancialData>}
          <div className="space-y-2">
          {monthSplit.map((item) => {
            const combined = "combined" in item && item.combined === true;
            const confirmedSavings = item.id === "savings" && !combined && item.done;
            return <div key={item.id} className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl border p-3",
              confirmedSavings ? "border-primary/20 bg-primary/5" : "border-border/60 bg-background/50")} data-funding-pot={item.pocket} data-funding-combined={combined || undefined}>
              <span className="min-w-0 break-words text-sm font-medium">{item.name}</span>
              <FinancialData as="span" className={cn("inline-flex items-center gap-2 whitespace-nowrap text-xl font-semibold tracking-tight tabular-nums", confirmedSavings && "text-primary")}>
                {item.done && <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-label={`${item.name} überwiesen`} />}
                <span>{currency(confirmedSavings ? item.transferred : item.amount)}</span>
              </FinancialData>
              {combined ? <FinancialData as="span" className="col-start-2 mt-1 justify-self-end text-2xs text-muted-foreground">Gemeinsame Überweisung</FinancialData>
                : item.id === "savings" && <FinancialData as="span" className="col-start-2 mt-1 justify-self-end text-2xs text-muted-foreground">{item.done ? "Überwiesen" : allocationBlocked ? "Empfehlung pausiert" : "Sparempfehlung"}</FinancialData>}
            </div>;
          })}
          </div>
        </section>
      <PlannedOneOffLines />
      </div>
      <div className="mb-5 grid items-start gap-5 xl:grid-cols-[1.2fr_1fr]">
        <section className="panel min-w-0 p-5 sm:p-6" aria-label="Deine Pockets">
          <SectionHeading
            title="Deine Pockets"
          >
            <Link
              href="/pockets"
              className="inline-flex min-h-8 items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            >
              Details <ArrowUpRight aria-hidden="true" className="size-3" />
            </Link>
          </SectionHeading>
          <div className="grid grid-cols-2 gap-3">
            {pocketNames.map((pocket) => {
              const Icon = pocketIcons[pocket];
              const balance = physicalPocketBalance(state, pocket, d.actual);
              return (
                <Link
                  href="/pockets"
                  key={pocket}
                  className="group min-w-0 rounded-2xl border border-border/70 bg-background/40 p-3 transition-colors hover:border-primary/30 hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4"
                >
                  <div className="mb-4 flex items-center justify-between">
                    <span className="flex size-9 items-center justify-center rounded-xl" style={{ color: pocketColors[pocket], background: `color-mix(in srgb, ${pocketColors[pocket]} 10%, transparent)` }}>
                      <Icon aria-hidden="true" className="size-4" />
                    </span>
                    <ArrowUpRight aria-hidden="true" className="size-3 text-muted-foreground transition-colors group-hover:text-primary" />
                  </div>
                  <p className="mb-1 break-words text-xs text-muted-foreground">{pocket}</p>
                  <FinancialData as="p" className="break-words text-lg font-semibold tracking-tight tabular-nums sm:text-xl">
                    {balance.amount === null ? "Kontostand unbekannt" : currency(balance.amount)}
                  </FinancialData>
                  {balance.source === "opening" && <p className="mt-2 text-2xs text-muted-foreground">Unabhängiger Startstand</p>}
                  {pocket === "Notgroschen" && <p className="mt-2 text-2xs text-muted-foreground">Trade Republic</p>}
                  {pocket === "Sparkonto" && d.currentRoundUp > 0 && <FinancialData as="p" className="mt-2 text-2xs text-muted-foreground">Round-up +{currency(d.currentRoundUp)}</FinancialData>}
                </Link>
              );
            })}
          </div>
        </section>
        {motorcycle ? <FinancialData as="section" className="panel min-w-0 overflow-hidden p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span className="flex size-9 items-center justify-center rounded-xl bg-chart-4/10"><Bike aria-hidden="true" className="size-4 text-chart-4" /></span>
              {motorcycle.name}
            </span>
            <span
              data-status={bikeSaved !== null && d.countdown.onTrack ? "positive" : "warning"}
              className={cn(
                "status-pill",
                bikeSaved !== null && d.countdown.onTrack
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-orange-500/10 text-orange-600 dark:text-orange-300",
              )}
            >
              {bikeSaved !== null && d.countdown.onTrack ? (
                <Check className="size-3" />
              ) : (
                <CircleAlert className="size-3" />
              )}
              {bikeSaved === null ? bikeUnknown : d.countdown.funded
                ? "Ziel erreicht"
                : d.countdown.overdue
                  ? "Termin überschritten"
                  : d.countdown.onTrack
                    ? "Im Plan"
                    : "Rate prüfen"}
            </span>
          </div>
          <div className="my-5">
            <p className="break-words text-xs text-muted-foreground"><span className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">{bikeSaved === null ? bikeUnknown : currency(bikeSaved)}</span>{bikeSaved !== null && " angespart"}</p>
            <p className="mt-1 text-xs text-muted-foreground">Ziel {currency(motorcycle.target)}</p>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Motorradziel"
            aria-valuenow={bikeSaved === null ? undefined : d.countdown.progress}
            aria-valuetext={bikeSaved === null ? bikeUnknown : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-chart-4 transition-all"
              style={{ width: `${bikeSaved === null ? 0 : d.countdown.progress}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><CalendarDays aria-hidden="true" className="size-3.5" />{dateLabel(motorcycle.date)}</span>
            {!d.countdown.overdue && <span>{d.countdown.days} Tage</span>}
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4 border-t pt-5">
            <div>
              <p className="text-2xs text-muted-foreground">
                Benötigt / Monat
              </p>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {bikeSaved === null ? "—" : currency(d.countdown.required)}
              </p>
            </div>
            <div>
              <p className="text-2xs text-muted-foreground">
                Geplant · {monthLabel(d.allocationMonth, true)}
              </p>
              <p
                className={cn(
                  "mt-1 text-lg font-semibold tabular-nums",
                  d.countdown.onTrack ? "text-primary" : "text-chart-4",
                )}
              >
                {bikeSaved === null ? "—" : currency(d.nextTransfer)}
              </p>
            </div>
          </div>
          {bikeSaved !== null && motorcycle.funding && d.currentMonth <= motorcycle.date.slice(0, 7) && <p className="mt-4 border-t border-border/60 pt-3 text-2xs leading-relaxed text-muted-foreground" aria-label="Motorrad-Finanzierung">
            {`Motorrad ${number(bikeSaved, 0)} €${Object.entries(motorcycle.funding.extras).sort(([a], [b]) => a.localeCompare(b))
              .map(([month, amount]) => ` · ${bikeExtraLabel(month)} +${number(amount, 0)}`).join("")} · monatlich ${number(motorcycle.funding.monthly, 0)} €`}
          </p>}
          <Link
            href="/einstellungen#sparziele"
            className="mt-3 inline-flex min-h-9 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Sparziel anpassen <ArrowRight className="size-3" />
          </Link>
        </FinancialData> : <section className="panel min-w-0 p-5 sm:p-6" aria-label="Sparziele">
          <SectionHeading title="Sparziele"><Target aria-hidden="true" className="size-4 text-primary" /></SectionHeading>
          <FinancialData className="space-y-3">
            {d.goals.map((goal) => {
              const basis = goalBalanceStatus(state, goal, d.actual);
              const progress = basis.amount === null ? null : Math.max(0, Math.min(100, basis.amount / goal.target * 100));
              const unavailable = basis.status === "conflict" ? "Zuordnung offen" : "Kontostand unbekannt";
              return <article key={goal.id} aria-label={`Sparziel ${goal.name}`} className="min-w-0 rounded-2xl border border-border/70 bg-background/40 p-4">
                <h3 className="break-words text-sm font-medium">{goal.name}</h3>
                <p className="mt-2 break-words text-xs text-muted-foreground"><span className="text-lg font-semibold text-foreground tabular-nums">{basis.amount === null ? unavailable : currency(basis.amount)}</span> von {currency(goal.target)}</p>
                <div role="progressbar" aria-label={`${goal.name} Fortschritt`} aria-valuenow={progress ?? undefined} aria-valuetext={progress === null ? unavailable : undefined} aria-valuemin={0} aria-valuemax={100} className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${progress ?? 0}%` }} />
                </div>
                <p className="mt-3 text-2xs text-muted-foreground">Bis {dateLabel(goal.date)}</p>
              </article>;
            })}
            {!d.goals.length && <div className="flex flex-col items-center rounded-2xl border border-dashed bg-muted/10 px-4 py-6 text-center">
              <Target aria-hidden="true" className="mb-3 size-7 text-primary/70" />
              <p className="text-sm font-medium">Noch kein Sparziel</p>
            </div>}
          </FinancialData>
          <Link href="/einstellungen#sparziele" className="mt-5 inline-flex items-center gap-1 text-xs text-primary">Sparziele bearbeiten <ArrowRight className="size-3" /></Link>
        </section>}
      </div>
      <section className="panel mb-5 p-5 sm:p-6" aria-label="Monatsprognose">
        <SectionHeading title="Die nächsten 90 Tage"><span className="status-pill border text-muted-foreground">Prognose</span></SectionHeading>
        <FinancialData className="grid gap-3 lg:grid-cols-3">
          {d.ninetyDays.map((row, index) => <article key={row.month} aria-label={`Prognose ${monthLabel(row.month)}`} className="min-w-0 rounded-2xl border border-border/70 bg-background/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{monthLabel(row.month)}</h3>
              {index === 0 && <span className="rounded-full bg-primary/10 px-2 py-1 text-2xs text-primary">Aktuell</span>}
            </div>
            <p className={cn("mt-4 break-words text-2xl font-semibold tracking-tight tabular-nums", row.remaining >= 0 ? "text-primary" : "text-destructive")}>{currency(row.remaining)}</p>
            <p className="mt-1 text-2xs text-muted-foreground">Rest nach Zielraten</p>
            <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-border/60 pt-4">
              {[
                { label: "Einnahmen", value: row.income }, { label: "Fixkosten", value: row.fixed },
                { label: "Alltagsbudget", value: row.variablePlan }, { label: "Zielraten", value: row.surplus - row.remaining },
              ].map(({ label, value }) => <div key={label} className="min-w-0">
                <dt className="text-2xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-words text-xs font-medium tabular-nums">{currency(value)}</dd>
              </div>)}
            </dl>
          </article>)}
        </FinancialData>
      </section>
      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <section className="panel min-w-0 p-5 sm:p-6">
          <SectionHeading
            title="Vermögensentwicklung"
            subtitle={hasAssetForecast ? `Prognose · ${forecast.length} ${forecast.length === 1 ? "Monat" : "Monate"}${incompleteAssets ? " · unvollständige Datenbasis" : ""}` : undefined}
          />
          {hasAssetForecast ? <FinancialData
            className="h-64"
            role="img"
            aria-label={incompleteAssets ? "Prognose bekannter Pocket-Guthaben" : "Prognose des gesamten Pocket-Vermögens"}
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
          </FinancialData> : <div className="flex min-h-48 items-center justify-center rounded-2xl border border-dashed bg-muted/10 p-5 text-center">
            <Link href="/monate" className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-primary">Monatsplan ergänzen <ArrowRight aria-hidden="true" className="size-4" /></Link>
          </div>}
        </section>
        <section className="panel min-w-0 p-5 sm:p-6">
          <SectionHeading
            title="Ausgaben nach Kategorie"
          ><span className="status-pill border text-muted-foreground">Ist</span></SectionHeading>
          {d.spending.length ? (
            <FinancialData className="flex min-h-64 flex-col items-center gap-3 sm:flex-row">
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
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{
                          background: chartColors[i % chartColors.length],
                        }}
                      />
                      <span className="break-words">{row.name}</span>
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">{currency(row.value)}</span>
                  </div>
                ))}
              </div>
            </FinancialData>
          ) : (
            <EmptyState icon={ReceiptText} title="Noch keine Ausgaben" className="min-h-48">
              <Link href="/umsaetze" className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs text-primary">Umsätze importieren <ArrowRight aria-hidden="true" className="size-3" /></Link>
            </EmptyState>
          )}
        </section>
        {forecast.length > 0 && <details className="panel group min-w-0 p-5 sm:p-6 xl:col-span-2" onToggle={(event) => setShowCashflow(event.currentTarget.open)}>
          <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span><span className="block font-semibold tracking-tight">Einnahmen & Ausgaben</span><span className="mt-1 block text-xs text-muted-foreground">Plan · 6 Monate</span></span>
            <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          {showCashflow && <FinancialData className="mt-5">
            <div className="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-2xs text-muted-foreground">
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
          </FinancialData>}
        </details>}
      </div>
    </>
  );
}
