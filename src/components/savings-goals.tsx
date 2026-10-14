"use client";

import { useRef, useState } from "react";
import { CalendarDays, Check, MoreHorizontal, Pencil, Plus, Target, Trash2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogForm, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { savingsGoalSchema, type SavingsGoal } from "@/lib/types";
import { goalBalanceStatus, pocketKey, preserveGoalOpeningBalances, savingsGoals, vacationSavingPaused } from "@/lib/goals";
import { currency, dateLabel } from "@/lib/format";

export function SavingsGoals() {
  const { state, dashboard, update, storageError } = useFinance();
  const [editing, setEditing] = useState<SavingsGoal | null>(null);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SavingsGoal | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnTarget = useRef<{ id: string; action: "edit" | "menu" } | null>(null);
  const goals = savingsGoals(state);
  const pauseVacation = vacationSavingPaused(state.settings.asOf.slice(0, 7));
  const allocationBlocked = "allocationBlocked" in dashboard.current && dashboard.current.allocationBlocked === true;
  function edit(goal: SavingsGoal, origin: "add" | "edit" | "menu" = "edit") {
    returnTarget.current = origin === "add" ? null : { id: goal.id, action: origin };
    setError(""); setErrorField(null); setEditing({ ...goal });
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
      action={<Button ref={addButton} type="button" variant="outline" size="sm" className="min-h-11" aria-label="Sparziel hinzufügen" disabled={goals.length >= 50}
          onClick={() => edit({ id: crypto.randomUUID(), name: "", pocket: "", target: 0, date: state.settings.asOf }, "add")}>
          <Plus aria-hidden="true" className="size-4" />Neues Ziel
        </Button>}>
      {allocationBlocked && <FinancialData as="p" role="status" className="mb-4 text-xs text-muted-foreground">
        Automatische Sparempfehlung pausiert: Kontostand oder Pocket-Zuordnung eines Ziels klären.
      </FinancialData>}
      <FinancialData className="grid gap-3 sm:grid-cols-2">
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
              <div className="h-full rounded-full bg-primary" style={{ width: `${progress ?? 0}%` }} />
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
      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
          <DialogHeader><DialogTitle>Sparziel {goals.some((goal) => goal.id === editing?.id) ? "bearbeiten" : "hinzufügen"}</DialogTitle><DialogDescription>Was möchtest du bis wann ansparen?</DialogDescription></DialogHeader>
          {editing && <DialogForm noValidate onSubmit={(event) => {
            event.preventDefault();
            if (storageError) return;
            const amountInput = event.currentTarget.elements.namedItem("target");
            if (amountInput instanceof HTMLInputElement && amountInput.validity.stepMismatch) {
              setErrorField("target");
              setError("Bitte den Betrag mit höchstens zwei Nachkommastellen eingeben.");
              amountInput.focus();
              return;
            }
            const candidate = { ...editing, pocket: editing.pocket || editing.name.trim() };
            const parsed = savingsGoalSchema.safeParse(candidate);
            const taken = goals.some((goal) => goal.id !== candidate.id &&
              [pocketKey(goal.name), pocketKey(goal.pocket)].some((key) => key === pocketKey(candidate.name) || key === pocketKey(candidate.pocket)));
            if (!parsed.success || taken || ["sparkonto", "urlaub", "notgroschen"].includes(pocketKey(candidate.name))) {
              const field = parsed.success ? "name" : String(parsed.error.issues[0].path[0]);
              setErrorField(field);
              setError(parsed.success
                ? "Bitte einen eindeutigen Zielnamen verwenden, nicht Sparkonto, Urlaub oder Notgroschen."
                : field === "date" ? "Bitte ein gültiges Bis-Datum angeben."
                  : field === "target" ? "Bitte einen Betrag größer als 0 und höchstens 1.000.000.000 € eingeben."
                    : "Bitte einen Zielnamen mit 1 bis 80 Zeichen eingeben.");
              const input = event.currentTarget.elements.namedItem(field);
              if (input instanceof HTMLElement) input.focus();
              return;
            }
            setError("");
            setErrorField(null);
            const value = { ...parsed.data };
            const balance = goalBalanceStatus(state, value, dashboard.actual).amount;
            if (balance !== null && value.target > balance && value.target !== goals.find((goal) => goal.id === value.id)?.target) delete value.completedAt;
            update((current) => ({ ...preserveGoalOpeningBalances(current),
              savingsGoals: [...savingsGoals(current).filter((goal) => goal.id !== value.id), value],
              settings: pocketKey(value.pocket) === "motorrad" ? { ...current.settings, bikeTarget: value.target, bikePurchaseDate: value.date } : current.settings,
            }));
            setEditing(null); toast.success("Sparziel gespeichert");
          }}>
            <DialogBody className="space-y-5">
              <label className="block text-sm font-medium">Name<Input name="name" aria-label="Name" className="mt-2" autoFocus value={editing.name} maxLength={80} aria-invalid={errorField === "name"} aria-describedby={errorField === "name" ? "savings-goal-error" : undefined} onChange={(event) => { setEditing({ ...editing, name: event.target.value }); if (errorField === "name") { setError(""); setErrorField(null); } }} required /></label>
              <div className="grid gap-5 sm:grid-cols-2">
                <label className="block text-sm font-medium">Betrag (€)<Input name="target" aria-label="Betrag" className="mt-2" type="number" inputMode="decimal" min="0.01" max="1000000000" step="0.01" value={editing.target || ""} aria-invalid={errorField === "target"} aria-describedby={errorField === "target" ? "savings-goal-error" : undefined} onChange={(event) => { setEditing({ ...editing, target: Number(event.target.value) }); if (errorField === "target") { setError(""); setErrorField(null); } }} required /></label>
                <label className="block text-sm font-medium">Bis-Datum<Input name="date" aria-label="Bis-Datum" className="mt-2" type="date" value={editing.date} aria-invalid={errorField === "date"} aria-describedby={errorField === "date" ? "savings-goal-error" : undefined} onChange={(event) => { setEditing({ ...editing, date: event.target.value }); if (errorField === "date") { setError(""); setErrorField(null); } }} required /></label>
              </div>
              {error && <p id="savings-goal-error" role="alert" className="text-sm text-destructive">{error}</p>}
              {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
            </DialogBody>
            <DialogFooter><Button type="button" variant="outline" onClick={() => setEditing(null)}>Abbrechen</Button><Button type="submit" disabled={!!storageError}>Speichern</Button></DialogFooter>
          </DialogForm>}
        </DialogContent>
      </Dialog>
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
