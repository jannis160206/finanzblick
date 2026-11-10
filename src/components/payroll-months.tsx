"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { notOnPayslip } from "@/components/payroll-focus";
import {
  payrollEstimate,
  payrollMoney,
  payrollMonthTiles,
  payrollStatusLabel,
  payrollWholeMoney,
  type PayrollMonthStatus,
  type PayrollMonthTile,
  type PayrollPresentation,
} from "@/components/payroll-presentation";
import { PayrollStatusBadge, PayrollStatusDot } from "@/components/payroll-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { currency } from "@/lib/format";
import type { Payslip } from "@/lib/payslip-schema";
import { cn } from "@/lib/utils";

const monthDate = (month: number) => new Date(Date.UTC(2026, month - 1, 15));
const monthNameFormat = new Intl.DateTimeFormat("de-AT", { month: "long", timeZone: "UTC" });
const monthShortFormat = new Intl.DateTimeFormat("de-AT", { month: "short", timeZone: "UTC" });
export const payrollMonthName = (month: number) => monthNameFormat.format(monthDate(month));
const payrollMonthShort = (month: number) => monthShortFormat.format(monthDate(month)).replace(/\.$/, "");

const tileTone: Record<PayrollMonthStatus, string> = {
  actual: "border-border/80 bg-card",
  forecast: "border-dashed border-muted-foreground/45 bg-card",
  missing: "border-warning/30 bg-warning-soft",
  open: "border-dashed border-border bg-transparent",
};

function tileText(tile: PayrollMonthTile) {
  if (tile.status === "missing") return `${tile.label}, Abrechnung fehlt`;
  if (!tile.headline) return `${tile.label}, ${tile.status === "open" ? "noch keine Abrechnung" : payrollStatusLabel[tile.status]}`;
  const metric = tile.headline.metric === "net" ? "netto" : "brutto";
  return `${tile.label}, ${metric} ${payrollWholeMoney(tile.headline.value)}, ${payrollStatusLabel[tile.status]}${
    tile.special ? ", mit Sonderzahlung" : ""
  }`;
}

/** Visible tile content; screen readers get the same facts as one sentence. */
function TileBody({ tile }: { tile: PayrollMonthTile }) {
  return (
    <>
      <span className="sr-only">{tileText(tile)}</span>
      <span aria-hidden="true" className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-1.5 max-[359px]:gap-x-1">
        <span className={cn("inline-flex items-center gap-1 text-xs font-medium", tile.status === "open" && "text-muted-foreground")}>
          <span className="@lg/months:hidden">{payrollMonthShort(tile.month)}</span>
          <span className="hidden @lg/months:inline">{payrollMonthName(tile.month)}</span>
          {tile.special && <span className="size-1.5 shrink-0 rounded-full bg-chart-4" />}
        </span>
        {tile.headline && (
          <span className="text-2xs text-muted-foreground">
            {tile.headline.metric === "net" ? "netto" : "brutto"}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "[overflow-wrap:anywhere]",
          tile.headline ? "amount text-sm @lg/months:text-base" : "text-sm text-muted-foreground",
        )}
      >
        {tile.headline ? payrollWholeMoney(tile.headline.value) : "–"}
      </span>
      <span aria-hidden="true" className="mt-auto flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
        <PayrollStatusDot status={tile.status} className="size-1.5" />
        {payrollStatusLabel[tile.status]}
      </span>
    </>
  );
}

type Figure = { label: string; name?: string; value: string; known: boolean };

function detailFigures(tile: PayrollMonthTile): Figure[] {
  const details = tile.details;
  if (!details) return [];
  if (details.kind === "actual") {
    const printed = (label: string, value: number | undefined): Figure => ({
      label,
      value: value === undefined ? notOnPayslip : currency(value),
      known: value !== undefined,
    });
    return [
      printed("Netto", details.net),
      printed("Laufendes Brutto", details.regularGross),
      {
        label: "Sonderzahlung",
        value: details.specialGross > 0 ? currency(details.specialGross) : "Keine",
        known: details.specialGross > 0,
      },
      printed("Lohnsteuer", details.tax),
      printed("SV", details.sv),
      ...(details.sixth === undefined ? [] : [printed("Jahressechstel", details.sixth)]),
    ];
  }
  return [
    {
      label: "Laufendes Brutto",
      value: payrollMoney(details.regularGross),
      known: details.regularGross !== undefined,
    },
    {
      label: "Sonderzahlung",
      value: details.specialGross === 0 ? "Keine geplant" : payrollMoney(details.specialGross),
      known: details.specialGross !== undefined && details.specialGross > 0,
    },
    {
      label: "Jahressechstel · Schätzung",
      name: "Jahressechstel",
      value: payrollEstimate(details.sixth),
      known: details.sixth !== undefined,
    },
  ];
}

function MonthDetail({ tile, onClose }: { tile: PayrollMonthTile; onClose: () => void }) {
  return (
    <FinancialData
      as="section"
      aria-label={tile.label}
      className="mt-4 border-t border-border/70 pt-4 duration-200 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold tracking-tight">{tile.label}</h4>
          <PayrollStatusBadge status={tile.status} />
          {tile.special && (
            <Badge variant="outline" className="gap-1.5">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-chart-4" />
              Sonderzahlung
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1.5" aria-label="Monatsdetails schließen" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 @lg/months:grid-cols-3 @3xl/months:grid-cols-6">
        {detailFigures(tile).map((figure) => (
          <div key={figure.label} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{figure.label}</dt>
            <dd
              aria-label={`${tile.label} ${figure.name ?? figure.label}`}
              className={cn(
                "mt-0.5 [overflow-wrap:anywhere]",
                figure.known ? "amount text-sm sm:text-base" : "text-xs text-muted-foreground",
              )}
            >
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>
      {tile.details?.kind === "forecast" && (
        <p className="mt-3 text-2xs text-muted-foreground">Lohnsteuer und SV erst mit der Abrechnung.</p>
      )}
    </FinancialData>
  );
}

export function PayrollMonths({
  view,
  entries,
  selectedMonth,
}: {
  view: PayrollPresentation;
  entries: readonly Payslip[];
  selectedMonth?: number;
}) {
  const tiles = payrollMonthTiles(view, entries);
  const [openMonth, setOpenMonth] = useState<number | null>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const panel = useRef<HTMLDivElement>(null);
  const open = tiles.find((tile) => tile.month === openMonth && tile.details);
  const panelId = `payroll-month-detail-${view.year}`;
  const statuses = (["actual", "forecast", "missing", "open"] as const).filter((status) =>
    tiles.some((tile) => tile.status === status),
  );
  // Phones show the panel below four rows of tiles: bring it into view without animating the scroll.
  useEffect(() => {
    if (openMonth !== null) panel.current?.scrollIntoView?.({ block: "nearest" });
  }, [openMonth]);
  const close = () => {
    const month = open?.month;
    setOpenMonth(null);
    if (month !== undefined) buttons.current.get(month)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    close();
  };
  return (
    <Card as="section" aria-labelledby="payroll-months-title" className="min-w-0">
      <CardHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <h3 id="payroll-months-title" className="text-sm leading-snug font-semibold tracking-tight">
            Monatsübersicht
          </h3>
          <CardDescription className="mt-0.5">Monat wählen für Details</CardDescription>
        </div>
        <ul
          aria-label="Legende Monatsübersicht"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground sm:justify-end"
        >
          {statuses.map((status) => (
            <li key={status} className="flex items-center gap-1">
              <PayrollStatusDot status={status} className="size-1.5" />
              {payrollStatusLabel[status]}
            </li>
          ))}
          {tiles.some((tile) => tile.special) && (
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-chart-4" />
              Sonderzahlung
            </li>
          )}
        </ul>
      </CardHeader>
      <CardContent className="@container/months pt-4" onKeyDown={onKeyDown}>
        <FinancialData
          as="ul"
          aria-label={`Monate ${view.year}`}
          className="grid grid-cols-3 gap-1.5 @lg/months:grid-cols-4 @lg/months:gap-2 @3xl/months:grid-cols-6"
        >
          {tiles.map((tile) => {
            const current = tile.status === "actual" && tile.month === selectedMonth;
            const expanded = open?.month === tile.month;
            const base = cn(
              "relative flex h-full min-h-[4.5rem] w-full min-w-0 flex-col gap-1 rounded-xl border px-2 pt-2.5 pb-2 text-left max-[359px]:px-1.5 @lg/months:px-3",
              tileTone[tile.status],
              current && "border-primary/50 bg-accent-muted",
            );
            return (
              <li key={tile.month} aria-current={current || undefined} className="flex min-w-0">
                {tile.details ? (
                  <button
                    ref={(node) => {
                      if (node) buttons.current.set(tile.month, node);
                      else buttons.current.delete(tile.month);
                    }}
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    onClick={() => setOpenMonth(expanded ? null : tile.month)}
                    className={cn(
                      base,
                      "cursor-pointer transition-[background-color,border-color,box-shadow] duration-150 ease-soft hover:border-ring/50 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      expanded && "border-solid border-ring shadow-raised ring-1 ring-ring",
                    )}
                  >
                    <TileBody tile={tile} />
                  </button>
                ) : (
                  <div className={base}>
                    <TileBody tile={tile} />
                  </div>
                )}
              </li>
            );
          })}
        </FinancialData>
        <div ref={panel} id={panelId} className="scroll-mt-24">
          {open && <MonthDetail key={open.month} tile={open} onClose={close} />}
        </div>
      </CardContent>
    </Card>
  );
}
