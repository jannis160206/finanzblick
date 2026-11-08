"use client";

import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Check, ChevronRight, CircleDashed, Clock, Info, Pencil, Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/finance-ui";
import { FinancialData } from "@/components/financial-data";
import { useSecurityMode } from "@/components/security-mode-provider";
import { useCompactLayout } from "@/components/ui/use-compact-layout";
import { financeRowValue, round, type Dashboard } from "@/lib/calc";
import type { FixedCostScheduleItem } from "@/lib/fixed-cost-schedule";
import { currency, dateLabel, monthLabel, number } from "@/lib/format";
import { ledgerHref } from "@/lib/ledger-link";
import type { MonthPlanActuals, RowMonthActual } from "@/lib/month-actuals";
import type { AppState, FinanceRow } from "@/lib/types";
import type { MonthPlanArea } from "@/components/month-plan-toolbar";
import { cn } from "@/lib/utils";

type MonthForecast = Dashboard["timeline"][number];
const groups = [
  { kind: "income", label: "Einnahmen", total: "Einnahmen gesamt" },
  { kind: "fixed", label: "Fixkosten", total: "Fixkosten gesamt" },
  { kind: "variable", label: "Variable Ausgaben", total: "Variabel gesamt" },
] as const;

// A booked amount counts as "as planned" within a few cents or two percent.
export const deviates = (planned: number, actual: number) =>
  Math.abs(actual - planned) > Math.max(1, Math.abs(planned) * 0.02);

export type FixedCellState = "booked" | "different" | "missing" | "open" | "due";
export function fixedCellState(
  planned: number,
  actual: RowMonthActual | undefined,
  month: string,
  currentMonth: string,
  status?: FixedCostScheduleItem,
): FixedCellState | undefined {
  if (month > currentMonth) return;
  if (month === currentMonth) {
    if (!status) return actual ? (deviates(planned, actual.amount) ? "different" : "booked") : undefined;
    if (status.status === "booked") return actual && deviates(planned, actual.amount) ? "different" : "booked";
    return status.status === "open" ? "open" : "due";
  }
  if (!actual) return planned > 0 ? "missing" : undefined;
  return deviates(planned, actual.amount) ? "different" : "booked";
}
const fixedStateText: Record<FixedCellState, string> = {
  booked: "Wie geplant gebucht",
  different: "Gebucht, aber anderer Betrag",
  missing: "Keine Buchung gefunden",
  open: "Noch offen",
  due: "Fällig, aber noch nicht gebucht",
};
function FixedStateIcon({ state }: { state: FixedCellState }) {
  const common = "size-3 shrink-0";
  if (state === "booked") return <Check aria-hidden="true" className={cn(common, "text-emerald-600 dark:text-emerald-400")} />;
  if (state === "different" || state === "due") return <AlertTriangle aria-hidden="true" className={cn(common, "text-amber-600 dark:text-amber-400")} />;
  if (state === "open") return <Clock aria-hidden="true" className={cn(common, "text-muted-foreground")} />;
  return <CircleDashed aria-hidden="true" className={cn(common, "text-muted-foreground/70")} />;
}

type MonthPlanGridProps = {
  months: string[];
  timeline: MonthForecast[];
  rows: FinanceRow[];
  area: MonthPlanArea;
  dashboard: Dashboard;
  actuals: MonthPlanActuals;
  holidayRanges: AppState["holidayRanges"];
  focused: boolean;
  editing: boolean;
  disabled: boolean;
  onEdit: (row: FinanceRow) => void;
  onDelete: (row: FinanceRow) => void;
  onCommit: (row: FinanceRow, month: string, value: number | null) => void;
};

function MonthGroupRows({
  group,
  ...props
}: MonthPlanGridProps & { group: (typeof groups)[number] }) {
  const { months, dashboard, timeline, rows } = props;
  const common = { months, currentMonth: dashboard.currentMonth };
  const own = rows.filter((row) => row.kind === group.kind);
  return (
    <>
      {bundleRows(own, group.kind === "fixed" && !props.editing).map((entry) =>
        entry.length === 1 ? (
          <MonthPositionRow key={entry[0].id} {...props} row={entry[0]} />
        ) : (
          <MonthBundleRows key={entry[0].id} {...props} bundle={entry} />
        ),
      )}
      {group.kind === "variable" && (
        <CalculatedMonthRow
          {...common}
          label="Amex noch zu überweisen"
          values={timeline.map((row) => row.amexOpen)}
          title={`Karte ${currency(dashboard.amex.outstanding)} · Eigenanteil ${currency(dashboard.amex.ownOutstanding)} · Rücklage ${currency(dashboard.amex.reserved)}`}
        />
      )}
      <CalculatedMonthRow
        {...common}
        label={group.total}
        strong
        values={timeline.map((row) =>
          group.kind === "income"
            ? row.income
            : group.kind === "fixed"
              ? row.fixed
              : row.variablePlan,
        )}
      />
      {group.kind !== "income" && timeline.some((row) => hasActuals(row, dashboard.currentMonth)) && (
        <CalculatedMonthRow
          {...common}
          label={group.kind === "fixed" ? "Fixkosten Ist" : "Übrige Ausgaben Ist"}
          actual
          title={group.kind === "fixed"
            ? "Tatsächlich gebuchte Fixkosten bis heute. Grün = im Plan, rot = mehr als geplant."
            : "Alle tatsächlichen Ausgaben außer Fixkosten – inklusive Einmalkäufen, Reisen und Shopping. Verglichen mit variablem Budget plus geplanten Einmalausgaben."}
          values={timeline.map((row) => !hasActuals(row, dashboard.currentMonth) ? null :
            group.kind === "fixed" ? row.fixedSpending : round(row.actualSpending - row.fixedSpending))}
          plans={timeline.map((row) => group.kind === "fixed" ? row.fixed : round(row.variablePlan + row.plannedOneOffs))}
        />
      )}
    </>
  );
}

const hasActuals = (row: MonthForecast, currentMonth: string) =>
  row.month <= currentMonth && row.actualCoverage !== "none";

// Same-named fixed costs (e.g. six Amazon instalments) collapse into one expandable row.
export function bundleRows(rows: FinanceRow[], enabled: boolean): FinanceRow[][] {
  if (!enabled) return rows.map((row) => [row]);
  const bundles = new Map<string, FinanceRow[]>();
  for (const row of rows) {
    const key = row.label.trim().toLocaleLowerCase("de");
    bundles.set(key, [...(bundles.get(key) ?? []), row]);
  }
  return [...bundles.values()];
}

function MonthBundleRows({
  bundle,
  ...props
}: MonthPlanGridProps & { bundle: FinanceRow[] }) {
  const [open, setOpen] = useState(false);
  const { months, dashboard, holidayRanges } = props;
  const label = bundle[0].label.trim();
  const id = useId();
  const totals = months.map((month) =>
    bundle.reduce((total, row) => total + financeRowValue(row, month, dashboard.plan, holidayRanges), 0));
  return (
    <>
      <tr data-bundle={label}>
        <th scope="row" className="sticky-label">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            onClick={() => setOpen((value) => !value)}
            className="flex min-h-8 w-full items-center gap-1.5 rounded-md text-left text-xs font-normal focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            <span className="min-w-0 break-words">{label}</span>
            <span className="shrink-0 text-muted-foreground">({bundle.length})</span>
          </button>
        </th>
        {totals.map((value, index) => (
          <td key={months[index]} data-current={months[index] === dashboard.currentMonth}>
            <span className="block text-right text-xs whitespace-nowrap tabular-nums" aria-label={`${label} gesamt ${monthLabel(months[index])}`}>
              {number(value)}
            </span>
          </td>
        ))}
      </tr>
      {open && bundle.map((row, index) => (
        <MonthPositionRow key={row.id} {...props} row={row} nested={`${label} ${index + 1}`} rowId={index === 0 ? id : undefined} />
      ))}
    </>
  );
}

function MonthResultRows({ months, timeline, dashboard }: MonthPlanGridProps) {
  const common = { months, currentMonth: dashboard.currentMonth };
  return (
    <>
      {timeline.some((row) => row.plannedOneOffs > 0) && (
        <CalculatedMonthRow
          {...common}
          label="Geplante Einmalausgaben"
          values={timeline.map((row) => row.plannedOneOffs)}
        />
      )}
      <CalculatedMonthRow
        {...common}
        label="Überschuss"
        values={timeline.map((row) => row.surplus)}
        strong
        surplus
      />
    </>
  );
}

function MonthPlanCard({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <table
        className="month-grid data-table w-full"
        data-view="month"
        aria-label={label}
      >
        <caption className="border-b border-border/60 px-4 py-3 text-left text-sm font-semibold">
          {label}
        </caption>
        <colgroup>
          <col className="w-3/5" />
          <col />
        </colgroup>
        <thead className="sr-only">
          <tr>
            <th scope="col">Position</th>
            <th scope="col">Betrag · EUR</th>
          </tr>
        </thead>
        <FinancialData as="tbody">{children}</FinancialData>
      </table>
    </div>
  );
}

function MonthGroupCard({
  group,
  ...props
}: MonthPlanGridProps & { group: (typeof groups)[number] }) {
  return (
    <MonthPlanCard label={group.label}>
      <MonthGroupRows {...props} group={group} />
    </MonthPlanCard>
  );
}

function FocusedMonthPlan(props: MonthPlanGridProps) {
  const selected = groups.filter(
    (group) => props.area === "all" || props.area === group.kind,
  );
  return (
    <div
      role="group"
      aria-label="Monatspositionen"
      className="bg-muted/15 p-4 sm:p-5"
    >
      <div
        className={cn(
          "mx-auto grid items-start gap-4",
          props.area === "all" ? "max-w-4xl lg:grid-cols-2" : "max-w-xl",
        )}
      >
        <div className="min-w-0 space-y-4">
          {selected
            .filter(
              (group) => props.area !== "all" || group.kind !== "variable",
            )
            .map((group) => (
              <MonthGroupCard key={group.kind} {...props} group={group} />
            ))}
          <MonthPlanCard label="Monatsergebnis">
            <MonthResultRows {...props} />
          </MonthPlanCard>
        </div>
        {selected
          .filter((group) => props.area === "all" && group.kind === "variable")
          .map((group) => (
            <MonthGroupCard key={group.kind} {...props} group={group} />
          ))}
      </div>
    </div>
  );
}

function CalculatedMonthRow({
  label,
  values,
  months,
  currentMonth,
  strong = false,
  title,
  surplus = false,
  actual = false,
  plans,
}: {
  label: string;
  values: (number | null)[];
  months: string[];
  currentMonth: string;
  strong?: boolean;
  title?: string;
  surplus?: boolean;
  /** Booked spending, coloured against `plans`: red above plan, green for finished months within it. */
  actual?: boolean;
  plans?: number[];
}) {
  return (
    <tr className={cn(strong && "summary-row", surplus && "surplus-row", actual && "text-muted-foreground")}>
      <th
        scope="row"
        className={cn("sticky-label", strong ? "font-semibold" : "font-normal", actual && "text-xs")}
      >
        {label}
        {title && (
          <FinancialData as="span">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`${label}: Details`}
                  className="ml-1 inline-flex size-6 items-center justify-center rounded-full align-middle text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Info aria-hidden="true" className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-72 text-xs leading-relaxed">{title}</PopoverContent>
            </Popover>
          </FinancialData>
        )}
      </th>
      {values.map((value, index) => {
        const plan = plans?.[index];
        const over = actual && value !== null && plan !== undefined && value > plan && deviates(plan, value);
        const within = actual && value !== null && plan !== undefined && !over && months[index] < currentMonth;
        return (
          <td
            key={months[index]}
            data-current={months[index] === currentMonth}
            data-tone={over ? "over" : within ? "within" : undefined}
            title={actual && value !== null && plan !== undefined ? `Plan ${currency(plan)} · Ist ${currency(value)}${months[index] === currentMonth ? " (bisher)" : ""}` : undefined}
            className={cn(
              "text-right tabular-nums",
              strong && "font-semibold",
              actual && "text-xs",
              !actual && value !== null && value < 0 && "text-destructive",
              over && "text-destructive",
              within && "text-emerald-700 dark:text-emerald-400",
            )}
          >
            {value === null ? "—" : number(value)}
          </td>
        );
      })}
    </tr>
  );
}

export function planValueInfo(
  row: FinanceRow,
  month: string,
  value: number,
  currentMonth: string,
  actual?: RowMonthActual,
  status?: FixedCostScheduleItem,
) {
  const fixed = row.kind === "fixed";
  const state = fixed ? fixedCellState(value, actual, month, currentMonth, status) : undefined;
  const booked = actual?.amount ?? 0;
  const over = !fixed && booked > value && deviates(value, booked);
  const description = fixed
    ? state ? fixedStateText[state] : month > currentMonth ? "Geplant" : "Kein Ist"
    : over ? "Über Budget" : month === currentMonth ? "Bisher ausgegeben" : month > currentMonth ? "Geplant" : "Im Budget";
  return { fixed, state, booked, over, description };
}

export function PlanValueDetails({
  row,
  month,
  value,
  currentMonth,
  actual,
  status,
  budget,
}: {
  row: FinanceRow;
  month: string;
  value: number;
  currentMonth: string;
  actual?: RowMonthActual;
  status?: FixedCostScheduleItem;
  budget?: MonthPlanActuals["budgets"][string];
}) {
  const { state, booked, over, description } = planValueInfo(row, month, value, currentMonth, actual, status);
  return (
    <FinancialData>
          <p className="font-semibold">{row.label} · {monthLabel(month)}</p>
          <p className={cn("mt-0.5", (state === "different" || state === "due" || over) ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
            {description}
          </p>
          <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
            <dt className="text-muted-foreground">Geplant</dt><dd className="text-right">{currency(value)}</dd>
            <dt className="text-muted-foreground">{month === currentMonth ? "Bisher gebucht" : "Gebucht"}</dt><dd className="text-right">{currency(booked)}</dd>
            {(actual || month < currentMonth) && (
              <>
                <dt className="text-muted-foreground">Differenz</dt>
                <dd className={cn("text-right", booked > value && deviates(value, booked) && "text-destructive")}>
                  {booked - value > 0 ? "+" : ""}{currency(round(booked - value))}
                </dd>
              </>
            )}
            {state === "open" && status?.expectedFrom && (
              <>
                <dt className="text-muted-foreground">Erwartet</dt>
                <dd className="text-right">{status.expectedFrom === status.expectedTo ? dateLabel(status.expectedFrom) : `${dateLabel(status.expectedFrom)} – ${dateLabel(status.expectedTo!)}`}</dd>
              </>
            )}
          </dl>
          {!!actual?.bookings.length && (
            <ul className="mt-3 space-y-1 border-t pt-2" aria-label="Buchungen">
              {actual.bookings.slice(0, 8).map((booking) => (
                <li key={booking.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    <span className="text-muted-foreground">{dateLabel(booking.date)}</span> {booking.name}
                    {booking.account && <span className="text-muted-foreground"> · {booking.account}</span>}
                  </span>
                  <span className="shrink-0 tabular-nums">{currency(booking.amount)}</span>
                </li>
              ))}
              {actual.bookings.length > 8 && <li className="text-muted-foreground">+ {actual.bookings.length - 8} weitere</li>}
            </ul>
          )}
          <Link
            href={ledgerHref({ month, ...(budget ? { group: budget } : {}) })}
            className="mt-3 inline-flex min-h-8 items-center gap-1 font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            In Umsätzen ansehen <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </Link>
        </FinancialData>
  );
}

function PlanValueCell({
  row,
  month,
  value,
  currentMonth,
  actual,
  status,
  budget,
  covered,
}: {
  row: FinanceRow;
  month: string;
  value: number;
  currentMonth: string;
  actual?: RowMonthActual;
  status?: FixedCostScheduleItem;
  budget?: MonthPlanActuals["budgets"][string];
  covered: boolean;
}) {
  const label = `${row.label} ${monthLabel(month)}`;
  const detailsId = useId();
  const plain = (
    <span className="block text-right text-xs whitespace-nowrap tabular-nums" aria-label={label}>
      {number(value)}
    </span>
  );
  const tracked = (row.kind === "fixed" || (row.kind === "variable" && budget)) && month <= currentMonth && covered;
  if (!tracked) return plain;
  const { fixed, state, booked, over, description } = planValueInfo(row, month, value, currentMonth, actual, status);
  if (fixed && !state) return plain;
  return (
    <>
    <span id={detailsId} className="sr-only">
      {`Plan ${currency(value)}, ${fixed ? description : `Ist ${currency(booked)}`}. Details anzeigen`}
    </span>
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-state-kind={state}
          aria-label={label}
          aria-describedby={detailsId}
          className="ml-auto flex min-h-8 w-full flex-col items-end justify-center rounded-md px-1 text-right text-xs tabular-nums transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            {state && <FixedStateIcon state={state} />}
            {number(value)}
          </span>
          {!fixed && (
            <span className={cn("text-2xs whitespace-nowrap", over ? "text-destructive" : "text-muted-foreground")}>
              Ist {number(booked)}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-xs">
        <PlanValueDetails row={row} month={month} value={value} currentMonth={currentMonth} actual={actual} status={status} budget={budget} />
      </PopoverContent>
    </Popover>
    </>
  );
}

function MonthPositionRow({
  row,
  months,
  dashboard,
  actuals,
  timeline,
  holidayRanges,
  focused,
  editing,
  disabled,
  onEdit,
  onDelete,
  onCommit,
  nested,
  rowId,
}: {
  row: FinanceRow;
  nested?: string;
  rowId?: string;
  months: string[];
  dashboard: Dashboard;
  actuals: MonthPlanActuals;
  timeline: MonthForecast[];
  holidayRanges: AppState["holidayRanges"];
  focused: boolean;
  editing: boolean;
  disabled: boolean;
  onEdit: (row: FinanceRow) => void;
  onDelete: (row: FinanceRow) => void;
  onCommit: (row: FinanceRow, month: string, value: number | null) => void;
}) {
  const duplicate = row.kind === "fixed" ? actuals.duplicates[row.id] : undefined;
  return (
    <tr id={rowId} className={cn(nested && "bg-muted/20")}>
      <th scope="row" className={cn("sticky-label", nested && "pl-8")}>
        <div
          className={cn(
            "flex gap-2",
            focused
              ? "flex-col items-start sm:flex-row sm:items-center sm:justify-between"
              : "items-center justify-between",
          )}
        >
          <span
            className="min-w-0 text-xs font-normal leading-relaxed break-words"
            title={row.label}
          >
            {row.label}
            {duplicate && (
              <span
                role="img"
                aria-label={`${duplicate.count}× ${currency(duplicate.amount)} in den Fixkosten – vermutlich doppelt`}
                title={`${duplicate.count}× ${currency(duplicate.amount)} in den Fixkosten – vermutlich doppelt. Bitte eine Zeile löschen.`}
                className="ml-1 inline-flex align-middle text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle aria-hidden="true" className="size-3.5" />
              </span>
            )}
          </span>
          {editing && row.kind !== "variable" && (
            <span className="flex shrink-0 gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                disabled={disabled}
                aria-label={`${row.label} bearbeiten`}
                data-finance-row-id={row.id}
                data-finance-row-action="edit"
                onClick={() => onEdit(row)}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8 text-muted-foreground hover:text-destructive"
                disabled={disabled}
                aria-label={`${row.label} löschen`}
                data-finance-row-id={row.id}
                data-finance-row-action="delete"
                onClick={() => onDelete(row)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </span>
          )}
        </div>
      </th>
      {months.map((month) => {
        const editable =
          editing &&
          (row.kind !== "variable" || month < dashboard.currentMonth);
        const automatic = financeRowValue(
          row,
          month,
          dashboard.plan,
          holidayRanges,
        );
        return (
          <td key={month} data-current={month === dashboard.currentMonth}>
            {editable ? (
              <fieldset disabled={disabled} className="min-w-0">
                <MoneyInput
                  label={`${row.label} ${monthLabel(month)}`}
                  value={
                    row.values[month] ?? (row.kind === "variable" ? null : 0)
                  }
                  nullable={row.kind === "variable"}
                  className={focused ? "w-full min-w-0! text-xs" : "w-28"}
                  onCommit={(value) => onCommit(row, month, value)}
                />
                {row.kind === "variable" && row.values[month] == null && (
                  <p className="mt-1 text-right text-2xs text-muted-foreground tabular-nums">
                    {number(automatic)}
                  </p>
                )}
              </fieldset>
            ) : (
              <PlanValueCell
                row={row}
                month={month}
                value={automatic}
                currentMonth={dashboard.currentMonth}
                actual={actuals.rows[row.id]?.[month]}
                status={month === dashboard.currentMonth ? actuals.status[row.id] : undefined}
                budget={actuals.budgets[row.id]}
                covered={timeline.find((item) => item.month === month)?.actualCoverage !== "none"}
              />
            )}
          </td>
        );
      })}
    </tr>
  );
}

export function MonthPlanGrid(props: MonthPlanGridProps) {
  const { months, area, dashboard, focused } = props;
  const compact = useCompactLayout();
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentColumn = useRef<HTMLTableCellElement>(null);
  const { locked } = useSecurityMode();
  useEffect(() => {
    const scroller = scrollRef.current;
    const column = currentColumn.current;
    if (focused || locked || !scroller || !scroller.clientWidth) return;
    if (!column) {
      scroller.scrollLeft = 0;
      return;
    }
    const label = scroller.querySelector<HTMLTableCellElement>(
      "thead .sticky-label",
    );
    scroller.scrollLeft +=
      column.getBoundingClientRect().left -
      scroller.getBoundingClientRect().left -
      (label?.getBoundingClientRect().width ?? 0) -
      16;
  }, [focused, months, dashboard.currentMonth, locked]);
  if (focused && !compact) return <FocusedMonthPlan {...props} />;
  return (
    <div
      ref={scrollRef}
      className={cn("overflow-auto", !focused && "max-h-[70vh]")}
      tabIndex={focused ? undefined : 0}
      aria-label={
        focused ? undefined : "Jahresraster horizontal und vertikal scrollen"
      }
    >
      <table
        className="month-grid data-table w-full"
        data-view={focused ? "month" : "year"}
        aria-label="Monatsplanung"
      >
        <thead>
          <tr>
            <th scope="col" className="sticky-label">
              Position{" "}
              <span className="font-normal text-muted-foreground">· EUR</span>
            </th>
            {months.map((month) => (
              <th
                scope="col"
                key={month}
                ref={
                  month === dashboard.currentMonth ? currentColumn : undefined
                }
                data-current={month === dashboard.currentMonth}
                className={cn(
                  "text-right",
                  !focused && "min-w-32",
                  month === dashboard.currentMonth && "text-primary",
                )}
              >
                {monthLabel(month, true)}
                {month === dashboard.currentMonth && (
                  <span className="ml-1" aria-label="Aktueller Monat">
                    •
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        {groups
          .filter((group) => area === "all" || area === group.kind)
          .map((group) => (
            <Fragment key={group.kind}>
              <tbody>
                <tr className="section-row">
                  <th scope="colgroup" colSpan={months.length + 1}>
                    <span className="sticky left-4 inline-block">
                      {group.label}
                    </span>
                  </th>
                </tr>
              </tbody>
              <FinancialData as="tbody">
                <MonthGroupRows {...props} group={group} />
              </FinancialData>
            </Fragment>
          ))}
        <FinancialData as="tbody">
          <MonthResultRows {...props} />
        </FinancialData>
      </table>
    </div>
  );
}
