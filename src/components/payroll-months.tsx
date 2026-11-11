"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CheckCheck, Trash2, TriangleAlert, X } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { notOnPayslip } from "@/components/payroll-focus";
import {
  payoutPartLabel,
  payrollEstimate,
  payrollMoney,
  payrollStatusLabel,
  payrollWholeMoney,
  type PayoutPartKey,
  type PayrollMonthStatus,
  type PayrollMonthTile,
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
  review: "border-warning/60 bg-card",
  forecast: "border-dashed border-muted-foreground/45 bg-card",
  missing: "border-warning/30 bg-warning-soft",
  open: "border-dashed border-border bg-transparent",
};

const partTone: Record<PayoutPartKey, string> = {
  salary: "bg-chart-1",
  onCall: "bg-chart-2",
  overtime: "bg-chart-3",
  holidayWork: "bg-chart-5",
  special: "bg-chart-4",
};

const statusText = (tile: PayrollMonthTile) => tile.reference ? "Referenz" : payrollStatusLabel[tile.status];

function tileText(tile: PayrollMonthTile) {
  const source = `Abrechnung ${tile.payroll.label}${tile.status === "review" ? ", nicht im Budget" : ""}`;
  if (tile.status === "missing") return `${tile.label}, ${source} fehlt`;
  if (!tile.headline) return `${tile.label}, ${tile.status === "open" ? "noch keine Abrechnung" : payrollStatusLabel[tile.status]}`;
  const metric = tile.headline.metric === "net" ? "netto" : "brutto";
  return `${tile.label}, ${metric} ${payrollWholeMoney(tile.headline.value)}, ${statusText(tile)}${
    tile.special ? ", mit Sonderzahlung" : ""
  }, ${source}`;
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
          tile.reference && "text-muted-foreground",
        )}
      >
        {tile.headline ? payrollWholeMoney(tile.headline.value) : "–"}
      </span>
      <span aria-hidden="true" className="mt-auto flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
        {tile.reference
          ? <span className="inline-block size-1.5 shrink-0 rounded-full border border-muted-foreground" />
          : <PayrollStatusDot status={tile.status} className="size-1.5" />}
        {statusText(tile)}
      </span>
    </>
  );
}

type Figure = { label: string; name?: string; value: string; known: boolean };

function grossFigures(tile: PayrollMonthTile): Figure[] {
  const details = tile.details;
  if (!details) return [];
  if (details.kind === "actual") {
    const printed = (label: string, value: number | undefined): Figure => ({
      label,
      value: value === undefined ? notOnPayslip : currency(value),
      known: value !== undefined,
    });
    return [
      printed("Laufendes Brutto", details.regularGross),
      {
        label: "Sonderzahlung brutto",
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
      label: "Sonderzahlung brutto",
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

function PayoutSplit({ tile }: { tile: PayrollMonthTile }) {
  const details = tile.details;
  if (!details?.parts.length || details.net === undefined) return null;
  const total = details.parts.reduce((sum, part) => sum + Math.max(0, part.amount), 0);
  return (
    <div className="mt-4 space-y-3">
      {total > 0 && (
        <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-muted">
          {details.parts.map((part) => part.amount > 0 && (
            <span
              key={part.key}
              className={cn("h-full first:rounded-l-full last:rounded-r-full", partTone[part.key])}
              style={{ width: `${(part.amount / total) * 100}%` }}
            />
          ))}
        </div>
      )}
      <dl className="grid gap-x-6 gap-y-2 @lg/months:grid-cols-2">
        {details.parts.map((part) => (
          <div key={part.key} className="flex min-w-0 items-baseline gap-2">
            <span aria-hidden="true" className={cn("size-2 shrink-0 translate-y-[-1px] rounded-full", partTone[part.key])} />
            <dt className="min-w-0 flex-1 text-sm">
              {payoutPartLabel[part.key]}
              {part.reason && <span className="block text-2xs text-muted-foreground">{part.reason}</span>}
            </dt>
            <dd aria-label={`${tile.label} ${payoutPartLabel[part.key]}`} className="amount shrink-0 text-sm">
              {currency(part.amount)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function MonthDetail({ tile, onClose, onRemove, onConfirm }: {
  tile: PayrollMonthTile;
  onClose: () => void;
  onRemove?: (entry: Payslip, trigger: HTMLButtonElement) => void;
  onConfirm?: (entry: Payslip) => void;
}) {
  const details = tile.details;
  const entry = details?.kind === "actual" ? details.entry : undefined;
  return (
    <FinancialData
      as="section"
      aria-label={tile.label}
      className="mt-4 border-t border-border/70 pt-4 duration-200 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold tracking-tight">{tile.label}</h4>
            {tile.reference ? <Badge variant="secondary">Referenz</Badge> : <PayrollStatusBadge status={tile.status} />}
            {tile.special && (
              <Badge variant="outline" className="gap-1.5">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-chart-4" />
                Sonderzahlung
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">Abrechnung {tile.payroll.label}</p>
        </div>
        <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1.5" aria-label="Monatsdetails schließen" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      {details?.net !== undefined && (
        <p className="mt-4">
          <span className="block text-xs text-muted-foreground">{details.kind === "actual" ? "Ausgezahlt" : "Erwartet"}</span>
          <span aria-label={`${tile.label} Netto`} className="amount text-2xl font-semibold tracking-tight">{currency(details.net)}</span>
        </p>
      )}
      {tile.review && (
        <div role="note" className="mt-4 rounded-xl border border-warning/50 bg-warning-soft px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
            Nicht im Budget – die Zahlen passen nicht zusammen
          </p>
          <ul className="mt-1.5 space-y-1 pl-5.5 text-xs leading-relaxed">
            {tile.review.slice(0, 3).map((check) => <li key={check.id}>{check.message}</li>)}
          </ul>
        </div>
      )}
      <PayoutSplit tile={tile} />
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-muted/40 p-3 @lg/months:grid-cols-3 @3xl/months:grid-cols-5">
        {grossFigures(tile).map((figure) => (
          <div key={figure.label} className="min-w-0">
            <dt className="text-2xs text-muted-foreground">{figure.label}</dt>
            <dd
              aria-label={`${tile.label} ${figure.name ?? figure.label}`}
              className={cn(
                "mt-0.5 [overflow-wrap:anywhere]",
                figure.known ? "amount text-sm" : "text-xs text-muted-foreground",
              )}
            >
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground">
        <p>
          {tile.reference
            ? "Nur Muster für die Prognose – nicht im Budget."
            : tile.review ? "Details im Import-Protokoll."
              : details?.kind === "forecast" ? "Lohnsteuer und SV erst mit der Abrechnung." : null}
        </p>
        {entry && (onRemove || (tile.review && onConfirm)) && <span className="-mr-2 flex flex-wrap items-center gap-1">
        {entry && tile.review && onConfirm && (
          <Button variant="outline" size="sm" onClick={() => onConfirm(entry)}>
            <CheckCheck aria-hidden="true" />Ins Budget übernehmen
          </Button>
        )}
        {entry && onRemove && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Abrechnung ${tile.payroll.label} entfernen`}
            onClick={(event) => onRemove(entry, event.currentTarget)}
          >
            <Trash2 aria-hidden="true" />Entfernen
          </Button>
        )}
        </span>}
      </div>
    </FinancialData>
  );
}

export function PayrollMonths({
  year,
  tiles,
  selectedMonth,
  onRemove,
  onConfirm,
  openRequest,
  onOpened,
}: {
  year: number;
  tiles: PayrollMonthTile[];
  /** Abrechnungsmonat of the shown year that the page currently focuses. */
  selectedMonth?: number;
  onRemove?: (entry: Payslip, trigger: HTMLButtonElement) => void;
  /** Takes a payslip held for review into the budget. */
  onConfirm?: (entry: Payslip) => void;
  /** Opens a payout month from outside (e.g. "Abrechnung prüfen" in the summary); `seq` makes repeated requests distinct. */
  openRequest?: { month: number; seq: number } | null;
  onOpened?: () => void;
}) {
  const [openMonth, setOpenMonth] = useState<number | null>(null);
  const [handledRequest, setHandledRequest] = useState<number | null>(null);
  if (openRequest && openRequest.seq !== handledRequest) {
    setHandledRequest(openRequest.seq);
    setOpenMonth(openRequest.month);
  }
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const panel = useRef<HTMLDivElement>(null);
  const open = tiles.find((tile) => tile.month === openMonth && tile.details);
  const panelId = `payroll-month-detail-${year}`;
  const statuses = (["actual", "review", "forecast", "missing", "open"] as const).filter((status) =>
    tiles.some((tile) => tile.status === status && !tile.reference),
  );
  // Phones show the panel below four rows of tiles: bring it into view without animating the scroll.
  useEffect(() => {
    if (openMonth !== null) panel.current?.scrollIntoView?.({ block: "nearest" });
  }, [openMonth]);
  // A month opened from outside also gets the focus, so keyboard and screen reader users land on it.
  const focusedRequest = useRef<number | null>(null);
  useEffect(() => {
    if (handledRequest === null || focusedRequest.current === handledRequest) return;
    focusedRequest.current = handledRequest;
    if (openMonth !== null) buttons.current.get(openMonth)?.focus({ preventScroll: true });
    onOpened?.();
  }, [handledRequest, openMonth, onOpened]);
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
    <Card as="section" id="payroll-months" tabIndex={-1} aria-labelledby="payroll-months-title"
      className="min-w-0 scroll-mt-24 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <CardHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <h3 id="payroll-months-title" className="text-sm leading-snug font-semibold tracking-tight">
            Monatsübersicht
          </h3>
          <CardDescription className="mt-0.5">Nach Auszahlung · Abrechnung des Vormonats</CardDescription>
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
          {tiles.some((tile) => tile.reference) && (
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="size-1.5 rounded-full border border-muted-foreground" />
              Referenz
            </li>
          )}
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
          aria-label={`Monate ${year}`}
          className="grid grid-cols-3 gap-1.5 @lg/months:grid-cols-4 @lg/months:gap-2 @3xl/months:grid-cols-6"
        >
          {tiles.map((tile) => {
            const current = (tile.status === "actual" || tile.status === "review") && tile.payroll.year === year && tile.payroll.month === selectedMonth;
            const expanded = open?.month === tile.month;
            const base = cn(
              "relative flex h-full min-h-[4.5rem] w-full min-w-0 flex-col gap-1 rounded-xl border px-2 pt-2.5 pb-2 text-left max-[359px]:px-1.5 @lg/months:px-3",
              tileTone[tile.status],
              tile.reference && "border-dashed",
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
          {open && <MonthDetail key={open.month} tile={open} onClose={close} onRemove={onRemove} onConfirm={onConfirm} />}
        </div>
      </CardContent>
    </Card>
  );
}
