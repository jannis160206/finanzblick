"use client";

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { Info, Pencil, Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/finance-ui";
import { FinancialData } from "@/components/financial-data";
import { useSecurityMode } from "@/components/security-mode-provider";
import { useCompactLayout } from "@/components/ui/use-compact-layout";
import { financeRowValue, type Dashboard } from "@/lib/calc";
import { currency, monthLabel, number } from "@/lib/format";
import type { AppState, FinanceRow } from "@/lib/types";
import type { MonthPlanArea } from "@/components/month-plan-toolbar";
import { cn } from "@/lib/utils";

type MonthForecast = Dashboard["timeline"][number];
const groups = [
  { kind: "income", label: "Einnahmen", total: "Einnahmen gesamt" },
  { kind: "fixed", label: "Fixkosten", total: "Fixkosten gesamt" },
  { kind: "variable", label: "Variable Ausgaben", total: "Variabel gesamt" },
] as const;

type MonthPlanGridProps = {
  months: string[];
  timeline: MonthForecast[];
  rows: FinanceRow[];
  area: MonthPlanArea;
  dashboard: Dashboard;
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
  return (
    <>
      {rows
        .filter((row) => row.kind === group.kind)
        .map((row) => (
          <MonthPositionRow key={row.id} {...props} row={row} />
        ))}
      {group.kind === "variable" && (
        <CalculatedMonthRow
          {...common}
          label="Amex offen"
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
}: {
  label: string;
  values: (number | null)[];
  months: string[];
  currentMonth: string;
  strong?: boolean;
  title?: string;
  surplus?: boolean;
}) {
  return (
    <tr className={cn(strong && "summary-row", surplus && "surplus-row")}>
      <th
        scope="row"
        className={cn("sticky-label", strong ? "font-semibold" : "font-normal")}
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
      {values.map((value, index) => (
        <td
          key={months[index]}
          data-current={months[index] === currentMonth}
          className={cn(
            "text-right tabular-nums",
            strong && "font-semibold",
            value !== null && value < 0 && "text-destructive",
          )}
        >
          {value === null ? "—" : number(value)}
        </td>
      ))}
    </tr>
  );
}

function MonthPositionRow({
  row,
  months,
  dashboard,
  holidayRanges,
  focused,
  editing,
  disabled,
  onEdit,
  onDelete,
  onCommit,
}: {
  row: FinanceRow;
  months: string[];
  dashboard: Dashboard;
  holidayRanges: AppState["holidayRanges"];
  focused: boolean;
  editing: boolean;
  disabled: boolean;
  onEdit: (row: FinanceRow) => void;
  onDelete: (row: FinanceRow) => void;
  onCommit: (row: FinanceRow, month: string, value: number | null) => void;
}) {
  return (
    <tr>
      <th scope="row" className="sticky-label">
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
              <span
                className="block text-right text-xs whitespace-nowrap tabular-nums"
                aria-label={`${row.label} ${monthLabel(month)}`}
              >
                {number(automatic)}
              </span>
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
