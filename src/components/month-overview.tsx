"use client";

import { useId, type ReactNode } from "react";
import Link from "next/link";
import { CalendarClock, ChevronRight, PiggyBank, Receipt, ShoppingBasket, Wallet } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FinancialData } from "@/components/financial-data";
import { PlanValueDetails, bundleRows, planValueInfo } from "@/components/month-plan-grid";
import { financeRowValue, round, sum, type Dashboard } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { ledgerHref } from "@/lib/ledger-link";
import type { MonthPlanActuals } from "@/lib/month-actuals";
import type { AppState, FinanceRow } from "@/lib/types";
import { cn } from "@/lib/utils";

type MonthForecast = Dashboard["timeline"][number];

const avatarTones = [
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
];
function Avatar({ label }: { label: string }) {
  const tone = avatarTones[[...label].reduce((hash, char) => hash + char.charCodeAt(0), 0) % avatarTones.length];
  return (
    <span aria-hidden="true" className={cn("grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold", tone)}>
      {label.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function Progress({ value, total, tone = "bg-primary", label }: { value: number; total: number; tone?: string; label: string }) {
  const percent = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : value > 0 ? 100 : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className={cn("h-full rounded-full transition-[width] motion-reduce:transition-none", tone)} style={{ width: `${percent}%` }} />
    </div>
  );
}

function Section({ title, icon, total, meta, children }: {
  title: string;
  icon: ReactNode;
  total: number;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      <header className="space-y-2 px-4 pt-4 pb-3 sm:px-5">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-muted-foreground">{icon}</span>
          <h3 id={id} className="text-sm font-semibold tracking-tight">{title}</h3>
          <FinancialData as="span" className="ml-auto text-sm font-semibold tabular-nums">{currency(total)}</FinancialData>
        </div>
        {meta}
      </header>
      <FinancialData as="ul" className="divide-y divide-border/60 border-t border-border/60">{children}</FinancialData>
    </section>
  );
}

const rowClass = "flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5";

function RowBody({ label, sub, amount, amountTone, subTone, chevron }: {
  label: string;
  sub?: ReactNode;
  amount: number;
  amountTone?: string;
  subTone?: string;
  chevron?: boolean;
}) {
  return (
    <>
      <Avatar label={label} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        {sub && <span className={cn("mt-0.5 block truncate text-xs text-muted-foreground", subTone)}>{sub}</span>}
      </span>
      <span className={cn("shrink-0 text-sm font-medium tabular-nums", amountTone)}>{currency(amount)}</span>
      {chevron && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
    </>
  );
}

const stateTone: Record<string, string> = {
  booked: "text-emerald-700 dark:text-emerald-400",
  different: "text-amber-700 dark:text-amber-400",
  due: "text-amber-700 dark:text-amber-400",
  missing: "text-muted-foreground",
  open: "text-muted-foreground",
};

type OverviewProps = {
  month: string;
  forecast: MonthForecast;
  rows: FinanceRow[];
  dashboard: Dashboard;
  actuals: MonthPlanActuals;
  holidayRanges: AppState["holidayRanges"];
};

function fixedSubline(row: FinanceRow, month: string, value: number, props: OverviewProps) {
  const currentMonth = props.dashboard.currentMonth;
  const actual = props.actuals.rows[row.id]?.[month];
  const status = month === currentMonth ? props.actuals.status[row.id] : undefined;
  const info = planValueInfo(row, month, value, currentMonth, actual, status);
  const dates = actual?.bookings.map((booking) => dateLabel(booking.date)).join(" · ");
  if (month > currentMonth) return { text: "Geplant", state: undefined, order: "9" };
  if (info.state === "booked") return { text: `Abgebucht${dates ? ` · ${dates}` : ""}`, state: info.state, order: `2${actual?.bookings[0]?.date ?? ""}` };
  if (info.state === "different") return { text: `Abgebucht ${currency(info.booked)}${dates ? ` · ${dates}` : ""}`, state: info.state, order: `2${actual?.bookings[0]?.date ?? ""}` };
  if (info.state === "due") return { text: "Heute fällig", state: info.state, order: "0" };
  if (info.state === "open") {
    const from = status?.expectedFrom;
    const to = status?.expectedTo;
    const when = from ? from === to || !to ? `ca. ${dateLabel(from)}` : `ca. ${Number(from.slice(8))}.–${dateLabel(to)}` : "Termin offen";
    return { text: `Offen · ${when}`, state: info.state, order: `1${from ?? "9"}` };
  }
  if (info.state === "missing") return { text: "Keine Buchung gefunden", state: info.state, order: "3" };
  return { text: info.description, state: info.state, order: "9" };
}

function FixedRow({ bundle, props }: { bundle: FinanceRow[]; props: OverviewProps }) {
  const { month, dashboard, actuals } = props;
  const value = (row: FinanceRow) => financeRowValue(row, month, dashboard.plan, props.holidayRanges);
  const [first] = bundle;
  const total = round(sum(bundle.map(value)));
  const lines = bundle.map((row) => ({ row, ...fixedSubline(row, month, value(row), props) }));
  const sub = bundle.length === 1
    ? lines[0].text
    : `${bundle.length} Posten · ${lines.filter((line) => line.state === "booked" || line.state === "different").length} abgebucht`;
  const tone = bundle.length === 1 ? stateTone[lines[0].state ?? ""] : undefined;
  const label = bundle.length === 1 ? first.label : `${first.label} (${bundle.length})`;
  return (
    <li>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={rowClass} aria-label={`${label}: ${currency(total)}, ${sub}`}>
            <RowBody label={label} sub={sub} subTone={tone} amount={total} chevron />
          </button>
        </PopoverTrigger>
        <PopoverContent className="max-h-[70vh] w-80 space-y-3 overflow-y-auto text-xs">
          {bundle.map((row, index) => (
            <div key={row.id} className={cn(index > 0 && "border-t pt-3")}>
              <PlanValueDetails
                row={row}
                month={month}
                value={value(row)}
                currentMonth={dashboard.currentMonth}
                actual={actuals.rows[row.id]?.[month]}
                status={month === dashboard.currentMonth ? actuals.status[row.id] : undefined}
              />
            </div>
          ))}
        </PopoverContent>
      </Popover>
    </li>
  );
}

function BudgetRow({ row, props }: { row: FinanceRow; props: OverviewProps }) {
  const { month, dashboard, actuals } = props;
  const plan = financeRowValue(row, month, dashboard.plan, props.holidayRanges);
  const budget = actuals.budgets[row.id];
  const tracked = month <= dashboard.currentMonth && props.forecast.actualCoverage !== "none";
  const spent = tracked ? actuals.rows[row.id]?.[month]?.amount ?? 0 : 0;
  const rest = round(plan - spent);
  const body = (
    <>
      <Avatar label={row.label} />
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.label}</span>
          <span className="shrink-0 text-sm font-medium tabular-nums">
            {tracked ? <>{currency(spent)} <span className="text-xs font-normal text-muted-foreground">/ {currency(plan)}</span></> : currency(plan)}
          </span>
        </span>
        {tracked && (
          <>
            <Progress value={spent} total={plan} label={`${row.label} ausgeschöpft`} tone={rest < 0 ? "bg-destructive" : spent / (plan || 1) > 0.85 ? "bg-amber-500" : "bg-primary"} />
            <span className={cn("block text-xs", rest < 0 ? "text-destructive" : "text-muted-foreground")}>
              {rest < 0 ? `${currency(-rest)} über Budget` : `${currency(rest)} übrig`}
            </span>
          </>
        )}
      </span>
      {budget && tracked && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
    </>
  );
  return (
    <li>
      {budget && tracked ? (
        <Link href={ledgerHref({ month, group: budget })} className={rowClass} title="Buchungen dieses Budgets anzeigen">{body}</Link>
      ) : (
        <div className={rowClass.replace("hover:bg-muted/50", "")}>{body}</div>
      )}
    </li>
  );
}

/** Finanzguru-style month: sections of list rows instead of a spreadsheet. */
export function MonthOverview(props: OverviewProps) {
  const { month, forecast, rows, dashboard, actuals } = props;
  const currentMonth = dashboard.currentMonth;
  const value = (row: FinanceRow) => financeRowValue(row, month, dashboard.plan, props.holidayRanges);
  const active = (kind: FinanceRow["kind"]) => rows.filter((row) => row.kind === kind && value(row) > 0);
  const income = active("income").sort((a, b) => value(b) - value(a));
  const fixedBundles = bundleRows(active("fixed"), true)
    .map((bundle) => ({ bundle, order: bundle.map((row) => fixedSubline(row, month, value(row), props).order).sort()[0] }))
    .sort((a, b) => a.order.localeCompare(b.order) || sum(b.bundle.map(value)) - sum(a.bundle.map(value)))
    .map((entry) => entry.bundle);
  const variable = active("variable").sort((a, b) => value(b) - value(a));
  const fixedRows = active("fixed");
  const isCurrent = month === currentMonth;
  const bookedFixed = isCurrent
    ? fixedRows.filter((row) => actuals.status[row.id]?.status === "booked")
    : month < currentMonth ? fixedRows.filter((row) => actuals.rows[row.id]?.[month]) : [];
  const openFixed = isCurrent
    ? round(sum(fixedRows.map((row) => actuals.status[row.id]?.status === "booked" ? 0 : actuals.status[row.id]?.openAmount ?? value(row))))
    : 0;
  const tracked = month <= currentMonth && forecast.actualCoverage !== "none";
  const budgetTotal = round(forecast.variablePlan - forecast.amexOpen);
  const budgetSpent = tracked ? round(sum(variable.map((row) => actuals.rows[row.id]?.[month]?.amount ?? 0))) : 0;
  const other = [
    ...(forecast.plannedOneOffs > 0 ? [{ label: "Geplante Einmalausgaben", amount: forecast.plannedOneOffs, sub: "Aus deiner Planung" }] : []),
    ...(forecast.amexOpen > 0 ? [{ label: "Amex noch zu überweisen", amount: forecast.amexOpen, sub: "Offener Kreditkartensaldo" }] : []),
  ];
  return (
    <div role="group" aria-label={`Monatsübersicht ${monthLabel(month)}`} className="grid gap-4 p-4 sm:p-5 lg:grid-cols-2">
      {income.length > 0 && (
        <Section title="Einnahmen" icon={<Wallet className="size-4" />} total={forecast.income}>
          {income.map((row) => (
            <li key={row.id} className={rowClass.replace("hover:bg-muted/50", "")}>
              <RowBody label={row.label} sub={month > currentMonth ? "Erwartet" : "Geplant"} amount={value(row)} amountTone="text-emerald-700 dark:text-emerald-400" />
            </li>
          ))}
        </Section>
      )}
      {fixedBundles.length > 0 && (
        <Section
          title="Fixkosten"
          icon={<Receipt className="size-4" />}
          total={forecast.fixed}
          meta={month <= currentMonth && (
            <div className="space-y-1.5">
              <Progress value={bookedFixed.length} total={fixedRows.length} label="Fixkosten abgebucht" tone="bg-emerald-500" />
              <FinancialData as="p" className="text-xs text-muted-foreground">
                {bookedFixed.length} von {fixedRows.length} abgebucht
                {isCurrent && (openFixed > 0 ? ` · ${currency(openFixed)} offen` : " · alles erledigt")}
              </FinancialData>
            </div>
          )}
        >
          {fixedBundles.map((bundle) => <FixedRow key={bundle[0].id} bundle={bundle} props={props} />)}
        </Section>
      )}
      {variable.length > 0 && (
        <Section
          title="Alltagsbudget"
          icon={<ShoppingBasket className="size-4" />}
          total={budgetTotal}
          meta={tracked && (
            <div className="space-y-1.5">
              <Progress value={budgetSpent} total={budgetTotal} label="Alltagsbudget ausgeschöpft" tone={budgetSpent > budgetTotal ? "bg-destructive" : "bg-primary"} />
              <FinancialData as="p" className={cn("text-xs", budgetSpent > budgetTotal ? "text-destructive" : "text-muted-foreground")}>
                {currency(budgetSpent)} ausgegeben · {budgetSpent > budgetTotal ? `${currency(round(budgetSpent - budgetTotal))} drüber` : `${currency(round(budgetTotal - budgetSpent))} übrig`}
              </FinancialData>
            </div>
          )}
        >
          {variable.map((row) => <BudgetRow key={row.id} row={row} props={props} />)}
        </Section>
      )}
      {other.length > 0 && (
        <Section title="Einmalig & Kreditkarte" icon={<CalendarClock className="size-4" />} total={round(sum(other.map((item) => item.amount)))}>
          {other.map((item) => (
            <li key={item.label} className={rowClass.replace("hover:bg-muted/50", "")}>
              <RowBody label={item.label} sub={item.sub} amount={item.amount} />
            </li>
          ))}
        </Section>
      )}
      {!income.length && !fixedBundles.length && !variable.length && !other.length && (
        <p className="flex items-center gap-2 rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">
          <PiggyBank aria-hidden="true" className="size-4" />Für {monthLabel(month)} ist noch nichts geplant.
        </p>
      )}
    </div>
  );
}

/** Stacked bar showing where the month's income goes. */
export function IncomeSplit({ income, fixed, everyday, oneOff, label }: {
  income: number;
  fixed: number;
  everyday: number;
  oneOff: number;
  label: string;
}) {
  const free = round(income - fixed - everyday - oneOff);
  const base = Math.max(income, fixed + everyday + oneOff, 1);
  const parts = [
    { key: "Fixkosten", value: fixed, tone: "bg-sky-500" },
    { key: "Alltag", value: everyday, tone: "bg-violet-500" },
    { key: "Einmalig & Karte", value: oneOff, tone: "bg-amber-500" },
    { key: free < 0 ? "Fehlbetrag" : "Frei", value: Math.abs(free), tone: free < 0 ? "bg-destructive" : "bg-emerald-500" },
  ].filter((part) => part.value > 0);
  if (!parts.length) return null;
  return (
    <FinancialData role="group" className="space-y-2.5 border-t border-border/60 px-4 py-4 sm:px-5" aria-label={label}>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {parts.map((part) => (
          <div key={part.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", part.tone)} style={{ width: `${(part.value / base) * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {parts.map((part) => (
          <li key={part.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-2 rounded-full", part.tone)} />
            {part.key} <span className="font-medium text-foreground tabular-nums">{currency(part.value)}</span>
          </li>
        ))}
      </ul>
    </FinancialData>
  );
}
