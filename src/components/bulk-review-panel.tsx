"use client";

import { useId, useMemo, useState } from "react";
import { AnimatePresence, type Transition } from "motion/react";
import { ChevronRight, CopyCheck } from "lucide-react";
import { toast } from "sonner";
import { CategorySelect } from "@/components/category-select";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { Button } from "@/components/ui/button";
import { MotionBox, useMotionMode, type MotionMode } from "@/components/ui/premium-dialog/motion";
import { accountLabel } from "@/lib/accounts";
import { round } from "@/lib/calc";
import type { Category } from "@/lib/categories";
import { currency, dateLabel } from "@/lib/format";
import { applyBulkReview, bulkReviewGroups, type BulkReviewGroup } from "@/lib/import/bulk-review";
import type { AppState } from "@/lib/types";
import { DrawnCheckbox } from "@/components/ui/drawn-checkbox";
import { cn } from "@/lib/utils";

type GroupBooking = { id: string; date: string; amount: number; account: string; text: string };

// Critically damped: settles softly without overshooting the content height.
const openSpring: Transition = { type: "spring", stiffness: 380, damping: 38, mass: 0.9 };
const closeSpring: Transition = { type: "spring", stiffness: 460, damping: 44, mass: 0.8 };
const fade: Transition = { duration: 0.12, ease: "easeOut" };

function reveal(mode: MotionMode) {
  if (mode === "full") return {
    initial: { height: 0, opacity: 0 },
    animate: { height: "auto", opacity: 1, transition: openSpring },
    exit: { height: 0, opacity: 0, transition: closeSpring },
  };
  return { initial: { opacity: 0 }, animate: { opacity: 1, transition: fade }, exit: { opacity: 0, transition: fade } };
}

function groupBookings(state: AppState, ids: readonly string[]): GroupBooking[] {
  const drafts = new Map((state.reviewQueue ?? []).flatMap((item) => item.kind === "booking" ? [[item.id, item.draft] as const] : []));
  return ids.flatMap((id) => {
    const draft = drafts.get(id);
    return draft && typeof draft.amount === "number"
      ? [{ id, date: draft.date, amount: draft.amount, account: accountLabel(draft), text: draft.description }]
      : [];
  }).sort((a, b) => b.date.localeCompare(a.date));
}

function applyLabel(selected: number, count: number) {
  if (!selected) return { full: "Übernehmen", short: "Übernehmen" };
  if (selected < count) return { full: `${selected} von ${count} übernehmen`, short: `${selected}/${count} übernehmen` };
  return count === 2
    ? { full: "Beide übernehmen", short: "Übernehmen" }
    : { full: `Alle ${count} übernehmen`, short: "Übernehmen" };
}

function BulkReviewRow({ group, disabled }: { group: BulkReviewGroup; disabled: boolean }) {
  const { state, update } = useFinance();
  const mode = useMotionMode();
  const panelId = useId();
  const [category, setCategory] = useState<Category>(group.category);
  const [expanded, setExpanded] = useState(false);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const bookings = useMemo(() => groupBookings(state, group.ids), [state, group.ids]);
  const selected = bookings.filter((booking) => !excluded.has(booking.id));
  const total = round(selected.reduce((sum, booking) => sum + booking.amount, 0));
  const count = bookings.length;
  const all = selected.length === count;
  const label = applyLabel(selected.length, count);

  function choose(ids: readonly string[], on: boolean) {
    setExcluded((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (on) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function apply() {
    const ids = selected.map((booking) => booking.id);
    if (category === "Prüfen" || !ids.length) return;
    const result = applyBulkReview(state, ids, category);
    if (!result.applied.length) {
      toast.error("Diese Buchungen konnten nicht gesammelt übernommen werden – bitte einzeln prüfen.");
      return;
    }
    update((current) => applyBulkReview(current, ids, category).state);
    const left = count - ids.length;
    toast.success(`${result.applied.length} ${result.applied.length === 1 ? "Buchung" : "Buchungen"} als ${category} übernommen` +
      (result.skipped.length ? ` · ${result.skipped.length} bitte einzeln prüfen` : "") +
      (left ? ` · ${left} ${left === 1 ? "bleibt" : "bleiben"} offen` : ""));
  }

  const list = (
    <div className="border-t border-border/70 px-2 pt-1 pb-2 @2xl:px-3">
      <div className="flex items-center justify-between gap-3 px-2">
        <p aria-live="polite" className="text-xs text-muted-foreground tabular-nums">{selected.length} von {count} ausgewählt</p>
        <Button type="button" variant="link" size="xs" disabled={disabled}
          className="min-h-11 px-0 text-xs pointer-fine:min-h-8"
          aria-label={`${group.label}: ${all ? "alle abwählen" : "alle auswählen"}`}
          onClick={() => choose(bookings.map((booking) => booking.id), !all)}>
          {all ? "Alle abwählen" : "Alle auswählen"}
        </Button>
      </div>
      <ul className="divide-y divide-border/50">
        {bookings.map((booking) => {
          const on = !excluded.has(booking.id);
          const date = booking.date ? dateLabel(booking.date) : "ohne Datum";
          return (
            <li key={booking.id}>
              <label className={cn("grid min-h-12 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none",
                !on && "text-muted-foreground")}>
                <DrawnCheckbox checked={on} disabled={disabled} label={`${date}, ${currency(booking.amount)}, ${booking.text}`}
                  onChange={(next) => choose([booking.id], next)} />
                <span className="min-w-0">
                  <span className="block text-sm break-words">{booking.text}</span>
                  <span className="block text-2xs text-muted-foreground">{date} · {booking.account}</span>
                </span>
                <span className={cn("text-sm font-medium tabular-nums", !on && "line-through decoration-muted-foreground/60")}>
                  {currency(booking.amount)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <li data-expanded={expanded || undefined}
      className="@container rounded-2xl border border-border/80 bg-card shadow-card transition-[box-shadow,border-color] duration-200 ease-soft data-expanded:border-border data-expanded:shadow-raised motion-reduce:transition-none">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-2 @2xl:flex-nowrap">
        <button type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)}
          className="flex min-h-11 min-w-0 basis-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors duration-150 hover:bg-muted/50 motion-reduce:transition-none @2xl:flex-1 @2xl:basis-auto">
          <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <ChevronRight className={cn("size-4 transition-transform duration-200 ease-soft motion-reduce:transition-none", expanded && "rotate-90")} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{group.label}</span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-full bg-muted px-1.5 font-medium text-foreground/80 tabular-nums">{all ? `${count} ×` : `${selected.length} von ${count}`}</span>
              <span className="tabular-nums">{currency(total)}</span>
            </span>
          </span>
        </button>
        <div className="flex w-full min-w-0 items-center gap-2 px-1 pb-1 @2xl:w-auto @2xl:p-0">
          <CategorySelect label={`Kategorie für ${group.label}`} value={category} onValueChange={setCategory} excludeReview disabled={disabled}
            className="min-w-0 flex-1 @2xl:w-60 @2xl:flex-none [&_select]:whitespace-nowrap" searchClassName="hidden @md:inline-flex" />
          <Button type="button" className="shrink-0" disabled={disabled || category === "Prüfen" || !selected.length} onClick={apply}>
            <span aria-hidden="true" className="@md:hidden">{label.short}</span>
            <span className="sr-only @md:not-sr-only">{label.full}</span>
          </Button>
        </div>
      </div>
      {mode === "none"
        ? expanded && <div id={panelId} role="region" aria-label={`Buchungen von ${group.label}`}>{list}</div>
        : <AnimatePresence initial={false}>
            {expanded && <MotionBox key="bookings" mode={mode} {...reveal(mode)} id={panelId} role="region"
              aria-label={`Buchungen von ${group.label}`} className="overflow-hidden">{list}</MotionBox>}
          </AnimatePresence>}
    </li>
  );
}

/** "3 Buchungen von X → gemeinsam korrigieren", with the option to leave single bookings out. */
export function BulkReviewPanel({ disabled }: { disabled: boolean }) {
  const { state } = useFinance();
  const groups = useMemo(() => bulkReviewGroups(state), [state]);
  if (!groups.length) return null;
  return (
    <section aria-labelledby="bulk-review-title" aria-describedby="bulk-review-hint" className="mb-4 space-y-2.5">
      <div className="px-1">
        <h2 id="bulk-review-title" className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-lg bg-warning-soft text-warning">
            <CopyCheck className="size-3.5" />
          </span>
          Sammel-Korrekturen
        </h2>
        <p id="bulk-review-hint" className="mt-1 text-xs text-muted-foreground">
          Gleiche Händler mit offener Prüfung – Kategorie wählen und gemeinsam übernehmen. Aufklappen, um einzelne Buchungen abzuwählen.
        </p>
      </div>
      <FinancialData as="ul" className="space-y-2">
        {groups.slice(0, 8).map((group) => <BulkReviewRow key={`${group.key}|${group.ids.join(",")}`} group={group} disabled={disabled} />)}
      </FinancialData>
    </section>
  );
}
