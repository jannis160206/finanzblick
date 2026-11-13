"use client";

import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, type Transition } from "motion/react";
import { CalendarClock, Check, ChevronDown, Clock, CreditCard, PiggyBank } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { MotionBox, useMotionMode, type MotionMode } from "@/components/ui/premium-dialog/motion";
import type { AmexStatement } from "@/lib/amex-statement";
import { currency } from "@/lib/format";
import { shiftCalendarDate } from "@/lib/holidays-at-kaernten";
import { bookingDescription } from "@/lib/import/merchant-description";
import { cleanMerchantName } from "@/lib/merchant-display";
import { cn } from "@/lib/utils";

const openSpring: Transition = { type: "spring", stiffness: 320, damping: 32, mass: 0.9 };
const closeSpring: Transition = { type: "spring", stiffness: 420, damping: 40 };
const fade: Transition = { duration: 0.12, ease: "easeOut" };

function reveal(mode: MotionMode) {
  if (mode === "full") return {
    initial: { height: 0, opacity: 0 },
    animate: { height: "auto", opacity: 1, transition: openSpring },
    exit: { height: 0, opacity: 0, transition: closeSpring },
  };
  return { initial: { opacity: 0 }, animate: { opacity: 1, transition: fade }, exit: { opacity: 0, transition: fade } };
}

const dayMonth = (date: string) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}.`;
const calendarDate = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("de-AT", { ...options, timeZone: "UTC" });
const weekdayDate = (date: string) => calendarDate(date, { weekday: "short", day: "numeric", month: "short" });
const longDate = (date: string) => calendarDate(date, { day: "numeric", month: "long" });

function relative(days: number) {
  if (days === 0) return "heute";
  if (days === 1) return "morgen";
  if (days > 1) return `in ${days} Tagen`;
  return `seit ${-days} ${days === -1 ? "Tag" : "Tagen"} fällig`;
}

/** Due statement, pocket share and the date the pocket money has to be on the giro – on the overview. */
export function AmexStatementCard({ className }: { className?: string }) {
  const { dashboard } = useFinance();
  if (!dashboard.amexStatement) return null;
  return <AmexStatementView statement={dashboard.amexStatement} className={className} />;
}

export function AmexStatementView({ statement: s, className }: { statement: AmexStatement; className?: string }) {
  const [open, setOpen] = useState(false);
  const mode = useMotionMode();
  const panelId = useId();
  const titleId = useId();
  const quiet = s.status !== "due";
  const urgency = quiet ? "quiet" : s.daysLeft < 0 ? "late" : s.daysLeft <= 3 ? "soon" : "calm";
  const share = s.total > 0 ? Math.min(1, s.fromPocket / s.total) : 0;
  const reserved = s.rows.filter((row) => row.reserved).length;
  const details = (
    <div className="space-y-3 border-t border-border/60 px-4 py-3 sm:px-5">
      <FinancialData as="ul" className="space-y-1 text-xs leading-relaxed text-muted-foreground">
        {s.missing > 0.005 && s.snapshotDate && (
          <li>{currency(s.missing)} laut Amex-Saldo vom {dayMonth(s.snapshotDate)} – Einzelbuchungen noch nicht importiert.</li>
        )}
        {s.nextReserved > 0.005 && (
          <li>{currency(s.nextReserved)} im Pocket gehören zu Buchungen ab dem {dayMonth(shiftCalendarDate(s.cycle.closing, 1))} und bleiben für die nächste Abrechnung.</li>
        )}
        {s.partner > 0.005 && <li>Davon Karte Raphael: {currency(s.partner)}.</li>}
        <li>
          {s.schedule.basedOn
            ? `Amex bucht meist ${s.schedule.offsetDays} Tage nach dem 10. ab (zuletzt ${s.schedule.recent.slice(-2).map(dayMonth).join(" und ")}).`
            : "Abbuchungstermin geschätzt – noch keine Amex-Abbuchung im Giro gefunden."}
        </li>
      </FinancialData>
      {s.rows.length > 0 && (
        <div>
          <p className="mb-1 text-2xs font-medium text-muted-foreground">
            {reserved > 0 ? `${reserved} von ${s.rows.length} Buchungen schon im Pocket zurückgelegt` : `${s.rows.length} Buchungen bis ${dayMonth(s.cycle.closing)}`}
          </p>
          <FinancialData as="ul" className="max-h-72 divide-y divide-border/50 overflow-y-auto overscroll-contain pr-1">
            {s.rows.map(({ booking, amount, partner, reserved: inPocket }) => {
              const description = bookingDescription(booking);
              const name = booking.merchantAlias ? description : cleanMerchantName(description);
              return (
                <li key={booking.id} className="flex items-center gap-3 py-1.5 text-sm">
                  <span className="w-11 shrink-0 text-xs tabular-nums text-muted-foreground">{dayMonth(booking.date)}</span>
                  <span className="min-w-0 flex-1 truncate" title={description}>{name}</span>
                  {partner && <span className="shrink-0 rounded-full bg-muted px-1.5 text-2xs text-muted-foreground">Raphael</span>}
                  {inPocket && (
                    <span title="Im Pocket zurückgelegt" className="shrink-0 text-primary">
                      <PiggyBank aria-hidden="true" className="size-3.5" />
                      <span className="sr-only">im Pocket zurückgelegt</span>
                    </span>
                  )}
                  <span className={cn("w-24 shrink-0 text-right tabular-nums", amount < 0 && "text-money-in")}>{currency(-amount)}</span>
                </li>
              );
            })}
          </FinancialData>
        </div>
      )}
    </div>
  );
  return (
    <section
      aria-labelledby={titleId}
      data-status={s.status}
      className={cn("min-w-0 overflow-hidden rounded-2xl border bg-card transition-[border-color,box-shadow] duration-200 ease-soft motion-reduce:transition-none",
        quiet ? "border-border/60" : "border-border/80 shadow-card", className)}
    >
      <div className="lg:flex lg:items-center lg:gap-6 lg:pr-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-4 sm:px-5 lg:flex-1">
        <span aria-hidden="true" className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl",
          quiet ? "bg-muted text-muted-foreground" : "bg-violet-500/10 text-violet-600 dark:text-violet-400")}>
          <CreditCard className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">Amex-Abrechnung</h2>
          <p className="text-xs text-muted-foreground">
            {s.status === "open"
              ? `Läuft bis ${longDate(s.cycle.closing)} · Buchungen ab ${dayMonth(s.cycle.start)}`
              : `Buchungen ${dayMonth(s.cycle.start)}–${dayMonth(s.cycle.closing)} · Abbuchung ca. ${weekdayDate(s.expectedDebit)}`}
          </p>
        </div>
      </div>
      <FinancialData as="dl" className={cn("grid items-end gap-3 px-4 pt-3 sm:px-5 lg:shrink-0 lg:px-0 lg:pt-4", s.hasPocket && "grid-cols-2 lg:w-[30rem]")}>
        {s.hasPocket && (
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Aus Amex-Rückzahlung nehmen</dt>
            <dd className={cn("amount truncate", quiet ? "text-lg" : "text-xl sm:text-2xl")}>{currency(s.fromPocket)}</dd>
            <dd className="text-2xs text-muted-foreground">{s.status === "open" ? "bisher, Buchungen" : "nur Buchungen"} bis {dayMonth(s.cycle.closing)}</dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{s.hasPocket ? "Zusätzlich noch zahlen" : "Abbuchung gesamt"}</dt>
          <dd className={cn("amount truncate", quiet ? "text-lg" : "text-xl sm:text-2xl")}>
            {currency(s.hasPocket ? s.additional : s.total)}
          </dd>
          <dd className="text-2xs text-muted-foreground">{s.hasPocket ? `von ${currency(s.total)} gesamt` : `Buchungen bis ${dayMonth(s.cycle.closing)}`}</dd>
        </div>
      </FinancialData>
      </div>
      {s.hasPocket && s.total > 0 && (
        <div aria-hidden="true" className="mx-4 mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-muted sm:mx-5">
          {share > 0 && <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />}
          {share < 1 && <div className={cn("h-full flex-1 rounded-full", quiet ? "bg-muted-foreground/30" : "bg-violet-400/80 dark:bg-violet-400/70")} />}
        </div>
      )}
      <DeadlineLine statement={s} urgency={urgency} />
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-4 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none sm:px-5"
      >
        <span>Details und Buchungen ({s.rows.length})</span>
        <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform duration-200 ease-soft motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {mode === "none"
        ? open && <div id={panelId} role="region" aria-label="Details zur Amex-Abrechnung">{details}</div>
        : <AnimatePresence initial={false}>
            {open && <MotionBox key="details" mode={mode} {...reveal(mode)} id={panelId} role="region" aria-label="Details zur Amex-Abrechnung"
              className="overflow-hidden">{details}</MotionBox>}
          </AnimatePresence>}
    </section>
  );
}

function DeadlineLine({ statement: s, urgency }: { statement: AmexStatement; urgency: "quiet" | "calm" | "soon" | "late" }) {
  const tone = {
    quiet: "bg-muted/50 text-muted-foreground",
    calm: "bg-accent-muted text-foreground",
    soon: "bg-warning-soft text-foreground",
    late: "bg-destructive-soft text-foreground",
  }[urgency];
  const iconTone = { quiet: "text-muted-foreground", calm: "text-primary", soon: "text-warning", late: "text-destructive" }[urgency];
  const Icon = s.status === "transferred" ? Check : s.status === "open" ? Clock : CalendarClock;
  let text: ReactNode;
  if (s.status === "open") {
    text = <>Schließt am {longDate(s.cycle.closing)} – dann bis ca. {weekdayDate(s.deadline)} aufs Giro überweisen.</>;
  } else if (s.status === "transferred") {
    text = <>
      {currency(s.transferred)} am {dayMonth(s.transferredOn ?? s.cycle.closing)} vom Pocket aufs Giro überwiesen
      {s.additional > 0.005 ? <> · {currency(s.additional)} kommen zusätzlich vom Giro.</> : "."}
    </>;
  } else if (s.toTransfer > 0.005) {
    text = <>
      <strong className="font-semibold">Bis {weekdayDate(s.deadline)}</strong> {currency(s.toTransfer)} von Revolut „{s.pocketName}“ aufs Giro überweisen
      <span className="text-muted-foreground"> · {relative(s.daysLeft)}{s.transferred > 0.005 ? ` · ${currency(s.transferred)} schon überwiesen` : ""}</span>
    </>;
  } else {
    text = <>
      <strong className="font-semibold">Bis {weekdayDate(s.deadline)}</strong> {currency(s.additional)} auf dem Giro bereithalten
      <span className="text-muted-foreground"> · {relative(s.daysLeft)}</span>
    </>;
  }
  return (
    <div className={cn("mx-4 mt-3 mb-1 flex items-start gap-2 rounded-xl px-3 py-2 text-xs leading-relaxed sm:mx-5", tone)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0", iconTone)} />
      <FinancialData as="span" className="min-w-0">{text}</FinancialData>
    </div>
  );
}
