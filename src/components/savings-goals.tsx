"use client";

import { useRef, useState } from "react";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { SectionHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogForm, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { savingsGoalSchema, type SavingsGoal } from "@/lib/types";
import { pocketKey, savingsGoals } from "@/lib/goals";
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
    <section ref={sectionRef} id="sparziele" className="panel p-4" aria-label="Sparziele">
      <SectionHeading title="Sparziele" subtitle="Sparkonto → Ziele nach Termin → Urlaub">
        <Button ref={addButton} type="button" variant="outline" size="icon" aria-label="Sparziel hinzufügen" disabled={goals.length >= 50}
          onClick={() => edit({ id: crypto.randomUUID(), name: "", pocket: "", target: 0, date: state.settings.asOf }, "add")}>
          <Plus className="size-4" />
        </Button>
      </SectionHeading>
      <div className="grid gap-3 sm:grid-cols-2">
        {goals.map((goal) => {
          const balance = Math.max(0, dashboard.actualGoals[goal.id] ?? 0);
          const progress = Math.min(100, balance / goal.target * 100);
          return <article className="rounded-lg border p-3" key={goal.id} aria-label={`Sparziel ${goal.name}`}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="truncate text-sm font-medium">{goal.name}</h3>
              <div className="flex shrink-0 items-center gap-1">
                <Button type="button" variant="ghost" size="sm" data-goal-id={goal.id} data-goal-action="edit" aria-label={`${goal.name} bearbeiten`} onClick={() => edit(goal)}>Bearbeiten</Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" data-goal-id={goal.id} data-goal-action="menu" aria-label={`${goal.name} Menü`}><MoreHorizontal className="size-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent onCloseAutoFocus={(event) => { if (editing || removing) event.preventDefault(); }}>
                    <DropdownMenuItem onSelect={() => edit(goal, "menu")}><Pencil />Bearbeiten</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive data-[highlighted]:bg-destructive/10" onSelect={() => { returnTarget.current = { id: goal.id, action: "menu" }; setRemoving(goal); }}><Trash2 />Entfernen</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{currency(balance)} von {currency(goal.target)} · bis {dateLabel(goal.date)}</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${goal.name} Fortschritt`} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
            </div>
            {goal.completedAt && <p className="mt-2 text-xs text-muted-foreground">Ziel erreicht · keine weitere Rate</p>}
          </article>;
        })}
      </div>
      {!goals.length && <p className="text-xs text-muted-foreground">Keine Sparziele. Nach dem Sparkonto-Sockel geht der Rest an Urlaub.</p>}
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
            if (value.target > (dashboard.actualGoals[value.id] ?? 0) && value.target !== goals.find((goal) => goal.id === value.id)?.target) delete value.completedAt;
            update((current) => ({ ...current,
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
            update((current) => ({ ...current, savingsGoals: savingsGoals(current).filter((goal) => goal.id !== removing?.id) }));
            setRemoving(null);
          }}>Entfernen</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
