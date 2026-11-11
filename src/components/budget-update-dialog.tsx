"use client";

import { useMemo, useState } from "react";
import { Check, ListChecks, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DialogEmpty, PremiumDialog, PremiumDialogBody, PremiumDialogClose, PremiumDialogContent, PremiumDialogFooter, PremiumDialogHeader,
} from "@/components/ui/premium-dialog";
import { addMonths } from "@/lib/calc";
import { groupCorrections, type BudgetCorrection, type BudgetCorrectionGroup } from "@/lib/budget-corrections";
import { autoBudgetCorrections, reviewPayrollBudget } from "@/lib/payroll-budget";
import { currency, monthLabel, percent } from "@/lib/format";
import { salaryForecast, type SalaryForecast } from "@/lib/salary-forecast";
import { cn } from "@/lib/utils";

const cents = (value: number) => Math.round(value * 100);

/** Consecutive months of a row with the same change, shown and selected as one line. */
type Run = { key: string; items: BudgetCorrection[]; from: number; to: number; reason: string };

function runs(items: BudgetCorrection[]): Run[] {
  const result: Run[] = [];
  for (const item of items) {
    const last = result.at(-1);
    const previous = last?.items.at(-1);
    if (last && previous && addMonths(previous.month, 1) === item.month && cents(previous.from) === cents(item.from) &&
      cents(previous.to) === cents(item.to) && previous.reason === item.reason) last.items.push(item);
    else result.push({ key: item.id, items: [item], from: item.from, to: item.to, reason: item.reason });
  }
  return result;
}

const period = (run: Run) => run.items.length === 1 ? monthLabel(run.items[0].month)
  : `${monthLabel(run.items[0].month, true)} – ${monthLabel(run.items.at(-1)!.month, true)}`;
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${currency(Math.abs(value))}`;

/**
 * Budget values Finanzblick does not write on its own – changed by hand or possibly double – offered for review.
 * Everything else from payslips and the salary forecast goes into the budget automatically (PayrollBudgetSync).
 */
export function BudgetReview({ className }: { className?: string }) {
  const { state, update, storageError } = useFinance();
  const forecast = useMemo(() => salaryForecast(state), [state]);
  const items = useMemo(() => autoBudgetCorrections(state, forecast).review, [state, forecast]);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  if (!items.length && !open) return null;
  return (
    <>
      {items.length > 0 && (
        <Button type="button" variant="outline" size="sm" className={cn("min-h-11", className)} onClick={() => { setSession((current) => current + 1); setOpen(true); }}>
          <ListChecks aria-hidden="true" />{items.length === 1 ? "1 Budgetwert prüfen" : `${items.length} Budgetwerte prüfen`}
        </Button>
      )}
      <BudgetUpdateDialog key={session} open={open} items={items} forecast={forecast} disabled={!!storageError} onOpenChange={setOpen}
        onApply={(chosen) => {
          const ids = new Set(chosen.map((item) => item.id));
          const keep = items.filter((item) => !ids.has(item.id));
          update((current) => reviewPayrollBudget(current, chosen, keep));
          setOpen(false);
          toast.success([chosen.length ? `${chosen.length === 1 ? "1 Wert" : `${chosen.length} Werte`} übernommen` : "",
            keep.length ? `${keep.length === 1 ? "1 Wert" : `${keep.length} Werte`} beibehalten` : ""].filter(Boolean).join(" · "));
        }} />
    </>
  );
}

export function BudgetUpdateDialog({ open, onOpenChange, items, forecast, disabled, onApply }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: BudgetCorrection[];
  forecast: SalaryForecast;
  disabled: boolean;
  onApply: (items: BudgetCorrection[]) => void;
}) {
  const [chosen, setChosen] = useState(() => new Set(items.map((item) => item.id)));
  const groups = useMemo(() => groupCorrections(items), [items]);
  const selected = items.filter((item) => chosen.has(item.id));
  const change = selected.reduce((sum, item) => sum + cents(item.to) - cents(item.from), 0) / 100;
  const toggle = (ids: string[], on: boolean) => setChosen((current) => {
    const next = new Set(current);
    for (const id of ids) if (on) next.add(id); else next.delete(id);
    return next;
  });
  return (
    <PremiumDialog open={open} onOpenChange={onOpenChange}>
      <PremiumDialogContent size="lg" snapPoints={[0.92]}>
        <PremiumDialogHeader icon={ListChecks} title="Budgetwerte prüfen"
          description="Von Hand geänderte Werte und mögliche Doppelungen übernimmt Finanzblick nicht selbst. Ausgewählte werden übernommen, die übrigen bleiben, wie sie sind." />
        <PremiumDialogBody className="space-y-5">
          {forecast.level && (
            <FinancialData as="dl" className="grid grid-cols-2 gap-2 text-sm">
              <div className="min-w-0 rounded-xl bg-muted/40 px-4 py-3">
                <dt className="text-2xs text-muted-foreground">Laufendes Netto</dt>
                <dd className="text-lg font-semibold tabular-nums">{currency(forecast.level.amount)}</dd>
                <dd className="truncate text-2xs text-muted-foreground" title={forecast.level.reason}>{forecast.level.reason.replace(/^laufendes Netto /, "")}</dd>
              </div>
              <div className="min-w-0 rounded-xl bg-muted/40 px-4 py-3">
                <dt className="text-2xs text-muted-foreground">Erhöhung</dt>
                <dd className="flex items-center gap-1.5 text-lg font-semibold tabular-nums">
                  {forecast.raise ? <><TrendingUp aria-hidden="true" className="size-4 shrink-0 text-primary" />{forecast.raise.factor > 1 ? "+" : ""}{percent(forecast.raise.factor - 1)}</> : "–"}
                </dd>
                <dd className="truncate text-2xs text-muted-foreground">{forecast.raise ? `seit ${monthLabel(forecast.raise.since, true)}` : "keine erkannt"}</dd>
              </div>
            </FinancialData>
          )}
          {!items.length && <DialogEmpty icon={Check} title="Budget ist aktuell">Die Einnahmen entsprechen der Gehaltsprognose.</DialogEmpty>}
          {groups.map((group) => <CorrectionGroup key={group.rowId} group={group} chosen={chosen} onToggle={toggle} />)}
        </PremiumDialogBody>
        <PremiumDialogFooter>
          <FinancialData as="p" className="text-sm text-muted-foreground tabular-nums sm:mr-auto" aria-live="polite">
            {selected.length} {selected.length === 1 ? "Wert" : "Werte"} · <span className="font-semibold text-foreground">{signed(change)}</span>
            {items.length > selected.length && <> · {items.length - selected.length} bleiben</>}
          </FinancialData>
          <PremiumDialogClose asChild><Button type="button" variant="outline">Abbrechen</Button></PremiumDialogClose>
          <Button type="button" disabled={disabled || !items.length} onClick={() => onApply(selected)}>
            <Check aria-hidden="true" />{selected.length ? "Übernehmen" : "Alle beibehalten"}
          </Button>
        </PremiumDialogFooter>
      </PremiumDialogContent>
    </PremiumDialog>
  );
}

function CorrectionGroup({ group, chosen, onToggle }: {
  group: BudgetCorrectionGroup; chosen: Set<string>; onToggle: (ids: string[], on: boolean) => void;
}) {
  const lines = runs(group.items);
  const ids = group.items.map((item) => item.id);
  const count = ids.filter((id) => chosen.has(id)).length;
  const shared = lines.every((line) => line.reason === lines[0].reason) ? lines[0].reason : undefined;
  const titleId = `budget-update-${group.rowId}`;
  return (
    <section aria-labelledby={titleId} className="rounded-2xl border border-border/70">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border/60 px-4 py-2">
        <div className="min-w-0">
          <h3 id={titleId} className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            {group.label}
            {group.create && <Badge variant="info">neu</Badge>}
            {group.kind === "duplicate" && <Badge variant="warning">doppelt</Badge>}
          </h3>
          {shared && <p className="text-2xs text-muted-foreground">{shared}</p>}
        </div>
        <Button type="button" variant="ghost" size="sm" className="min-h-11 text-xs text-muted-foreground pointer-fine:min-h-9"
          aria-label={`${group.label}: ${count === ids.length ? "alle abwählen" : "alle auswählen"}`}
          onClick={() => onToggle(ids, count !== ids.length)}>
          {count === ids.length ? "Keine" : "Alle"}
        </Button>
      </header>
      <ul className="divide-y divide-border/50">
        {lines.map((line) => {
          const on = line.items.every((item) => chosen.has(item.id));
          const months = line.items.length;
          return (
            <li key={line.key}>
              <label className={cn("grid min-h-14 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/40",
                !on && "text-muted-foreground")}>
                <input type="checkbox" className="peer sr-only" checked={on}
                  aria-label={`${group.label}, ${period(line)}: ${currency(line.to)} statt ${currency(line.from)}`}
                  onChange={(event) => onToggle(line.items.map((item) => item.id), event.target.checked)} />
                <span aria-hidden="true" className={cn("flex size-5 items-center justify-center rounded-md border border-input bg-background transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
                  on && "border-primary bg-primary text-primary-foreground")}>
                  {on && <Check className="size-3.5" strokeWidth={3} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{period(line)}{months > 1 && <span className="font-normal text-muted-foreground"> · {months} Monate</span>}</span>
                  {!shared && <span className="block break-words text-2xs text-muted-foreground">{line.reason}</span>}
                </span>
                <FinancialData as="span" className="text-right tabular-nums">
                  <span className={cn("block text-sm font-semibold", on && "text-foreground")}>{currency(line.to)}</span>
                  <span className="block text-2xs text-muted-foreground line-through decoration-muted-foreground/60">{currency(line.from)}</span>
                </FinancialData>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
