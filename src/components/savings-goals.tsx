"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { CalendarDays, Check, MoreHorizontal, Pencil, Plus, Target, Trash2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { GoalSave } from "@/components/savings-goal-wizard";
import type { SavingsGoal } from "@/lib/types";
import { goalBalanceStatus, pocketKey, preserveGoalOpeningBalances, savingsGoals, vacationSavingPaused } from "@/lib/goals";
import { withGoalPlan } from "@/lib/goal-planner";
import { currency, dateLabel } from "@/lib/format";

const SavingsGoalWizard = dynamic(() => import("@/components/savings-goal-wizard"), { ssr: false });

export function SavingsGoals() {
  const { state, dashboard, update, storageError } = useFinance();
  const [editing, setEditing] = useState<{ goal: SavingsGoal; isNew: boolean; open: boolean; session: number } | null>(null);
  const [removing, setRemoving] = useState<SavingsGoal | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnTarget = useRef<{ id: string; action: "edit" | "menu" } | null>(null);
  const goals = savingsGoals(state);
  const pauseVacation = vacationSavingPaused(state.settings.asOf.slice(0, 7));
  const allocationBlocked = "allocationBlocked" in dashboard.current && dashboard.current.allocationBlocked === true;
  function edit(goal: SavingsGoal, origin: "add" | "edit" | "menu" = "edit") {
    returnTarget.current = origin === "add" ? null : { id: goal.id, action: origin };
    setEditing((current) => ({ goal: { ...goal }, isNew: origin === "add", open: true, session: (current?.session ?? 0) + 1 }));
  }
  const closeEditor = () => setEditing((current) => current && { ...current, open: false });
  function save({ goal, opening }: GoalSave) {
    if (storageError || !editing) return;
    const value = { ...goal };
    const status = goalBalanceStatus(state, value, dashboard.actual);
    if (status.amount !== null && value.target > status.amount && value.target !== goals.find((item) => item.id === value.id)?.target) delete value.completedAt;
    // A documented start keeps a new pocket's balance known, so the plan can fund every goal (as with goals from the assistant).
    if (editing.isNew && status.status === "unknown" && !value.openingBalance) value.openingBalance = { date: state.settings.asOf, amount: opening };
    update((current) => {
      const booked = withGoalPlan(current, value, savingsGoals(current).find((item) => item.id === value.id));
      return { ...preserveGoalOpeningBalances(current), months: booked.months,
        savingsGoals: [...savingsGoals(current).filter((item) => item.id !== value.id), booked.goal],
        settings: pocketKey(booked.goal.pocket) === "motorrad" ? { ...current.settings, bikeTarget: booked.goal.target, bikePurchaseDate: booked.goal.date } : current.settings,
      };
    });
    closeEditor();
    toast.success("Sparziel gespeichert");
  }
  function restoreFocus() {
    const target = returnTarget.current;
    const trigger = Array.from(sectionRef.current?.querySelectorAll<HTMLButtonElement>("[data-goal-action]") ?? [])
      .find((button) => button.dataset.goalId === target?.id && button.dataset.goalAction === target?.action);
    const fallback = addButton.current?.disabled
      ? sectionRef.current?.querySelector<HTMLButtonElement>('[data-goal-action="edit"]')
      : addButton.current;
    (trigger ?? fallback)?.focus();
  }
  return (
    <SettingsSection sectionRef={sectionRef} id="sparziele" title="Sparziele" icon={Target}
      description={pauseVacation ? "Rest ins Sparkonto · Urlaub ab März 2027" : "Sparkonto → Ziele nach Termin → Urlaub"}
      action={<Button ref={addButton} type="button" variant="outline" size="sm" className="min-h-11" disabled={goals.length >= 50}
          onClick={() => edit({ id: crypto.randomUUID(), name: "", pocket: "", target: 0, date: state.settings.asOf }, "add")}>
          <Plus aria-hidden="true" className="size-4" />Sparziel hinzufügen
        </Button>}>
      {allocationBlocked && <FinancialData as="p" role="status" className="mb-4 text-xs text-muted-foreground">
        Automatische Sparempfehlung pausiert: Kontostand oder Pocket-Zuordnung eines Ziels klären.
      </FinancialData>}
      <FinancialData className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {goals.map((goal) => {
          const basis = goalBalanceStatus(state, goal, dashboard.actual);
          const balance = basis.amount;
          const progress = balance === null ? null : Math.max(0, Math.min(100, balance / goal.target * 100));
          const unavailable = basis.status === "conflict" ? "Zuordnung offen" : "Kontostand unbekannt";
          return <article className="min-w-0 rounded-2xl border border-border/70 bg-background/40 p-4 sm:p-5" key={goal.id} aria-label={`Sparziel ${goal.name}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Target aria-hidden="true" className="size-4" /></span>
                <h3 className="min-w-0 break-words text-sm font-semibold">{goal.name}</h3>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button type="button" variant="ghost" size="icon" className="size-11 text-muted-foreground" data-goal-id={goal.id} data-goal-action="edit" aria-label={`${goal.name} bearbeiten`} onClick={() => edit(goal)}><Pencil aria-hidden="true" className="size-4" /></Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="size-11 text-muted-foreground" data-goal-id={goal.id} data-goal-action="menu" aria-label={`${goal.name} Menü`}><MoreHorizontal aria-hidden="true" className="size-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent onCloseAutoFocus={(event) => { if (editing || removing) event.preventDefault(); }}>
                    <DropdownMenuItem onSelect={() => edit(goal, "menu")}><Pencil />Bearbeiten</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive data-[highlighted]:bg-destructive/10" onSelect={() => { returnTarget.current = { id: goal.id, action: "menu" }; setRemoving(goal); }}><Trash2 />Entfernen</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <p className="mt-5 text-xs text-muted-foreground"><span className="text-xl font-semibold tracking-tight text-foreground tabular-nums">{balance === null ? unavailable : currency(balance)}</span> von {currency(goal.target)}</p>
            <div className="mb-2 mt-4 flex items-center justify-between text-2xs text-muted-foreground"><span>Pocket-Guthaben</span><span className="font-medium tabular-nums text-primary">{progress === null ? "—" : `${Math.round(progress)} %`}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${goal.name} Fortschritt`} aria-valuenow={progress ?? undefined} aria-valuetext={progress === null ? unavailable : undefined} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-primary transition-[width] duration-700 ease-soft motion-reduce:transition-none" style={{ width: `${progress ?? 0}%` }} />
            </div>
            {basis.status === "conflict" && <p className="mt-3 text-xs text-muted-foreground">Pocket-Zuordnung oder widersprüchliche Salden klären. Das Guthaben ist nicht mehrfach verfügbar.</p>}
            {basis.status === "unknown" && <p className="mt-3 text-xs text-muted-foreground">Ohne belegten Startstand oder Auszugssaldo ist der Fortschritt nicht bekannt.</p>}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-2xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><CalendarDays aria-hidden="true" className="size-3.5 shrink-0" />Bis {dateLabel(goal.date)}</span>
              <span className="inline-flex min-w-0 items-center gap-1.5"><Wallet aria-hidden="true" className="size-3.5 shrink-0" /><span className="break-all">{goal.pocket}</span></span>
            </div>
            {goal.completedAt && <p className="mt-3 flex items-center gap-1.5 text-xs text-primary"><Check aria-hidden="true" className="size-3.5" />Ziel erreicht · keine weitere Rate</p>}
          </article>;
        })}
      </FinancialData>
      {!goals.length && <FinancialData className="flex flex-col items-center rounded-2xl border border-dashed bg-muted/10 px-4 py-8 text-center">
        <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary/5 text-primary"><Target aria-hidden="true" className="size-6" /></span>
        <h3 className="text-sm font-medium">Platz für dein nächstes Ziel</h3>
        <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">{pauseVacation
        ? "Keine Sparziele. Überschuss ins Sparkonto."
        : "Keine Sparziele. Nach dem Sparkonto-Sockel geht der Rest an Urlaub."}</p>
      </FinancialData>}
      {editing && (
        <SavingsGoalWizard key={editing.session} open={editing.open} goal={editing.goal} isNew={editing.isNew} goals={goals} state={state} dashboard={dashboard}
          disabled={!!storageError} storageError={storageError} onClose={closeEditor} onSave={save}
          onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }} />
      )}
      <Dialog open={!!removing} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <DialogContent variant="confirmation" onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
          <DialogHeader><DialogTitle>Sparziel entfernen?</DialogTitle><DialogDescription>Buchungen und Kontostände bleiben erhalten.</DialogDescription></DialogHeader>
          <DialogBody className="space-y-3">
            <p className="text-sm">{removing?.name}: Ziel und künftige Raten entfernen.</p>
            {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
          </DialogBody>
          <DialogFooter><Button variant="outline" onClick={() => setRemoving(null)}>Abbrechen</Button><Button variant="destructive" disabled={!!storageError} onClick={() => {
            update((current) => ({ ...preserveGoalOpeningBalances(current), savingsGoals: savingsGoals(current).filter((goal) => goal.id !== removing?.id) }));
            setRemoving(null);
          }}>Entfernen</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
