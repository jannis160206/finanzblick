"use client";

import { useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { SectionHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { savingsGoalSchema, type SavingsGoal } from "@/lib/types";
import { pocketKey, savingsGoals } from "@/lib/goals";
import { currency, dateLabel } from "@/lib/format";

export function SavingsGoals() {
  const { state, dashboard, update } = useFinance();
  const [editing, setEditing] = useState<SavingsGoal | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<SavingsGoal | null>(null);
  const goals = savingsGoals(state);
  function edit(goal: SavingsGoal) { setError(""); setEditing({ ...goal }); }
  return (
    <section id="sparziele" className="panel p-4" aria-label="Sparziele">
      <SectionHeading title="Sparziele" subtitle="Sparkonto zuerst, dann Ziele nach Termin und zuletzt Urlaub.">
        <Button type="button" variant="outline" size="icon" aria-label="Sparziel hinzufügen" disabled={goals.length >= 50}
          onClick={() => edit({ id: crypto.randomUUID(), name: "", pocket: "", target: 0, date: state.settings.asOf })}>
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
                <Button type="button" variant="ghost" size="sm" aria-label={`${goal.name} bearbeiten`} onClick={() => edit(goal)}>Bearbeiten</Button>
                <details className="relative">
                  <summary className="cursor-pointer list-none rounded p-1" aria-label={`${goal.name} Menü`}><MoreHorizontal className="size-4" /></summary>
                  <div className="absolute right-0 z-10 rounded-md border bg-card p-1 shadow-sm">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(goal)}>Entfernen</Button>
                  </div>
                </details>
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
      {!goals.length && <p className="text-xs text-muted-foreground">Kein offenes Sparziel. Überschuss geht nach dem Sparkonto-Sockel an Urlaub.</p>}
      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Sparziel {goals.some((goal) => goal.id === editing?.id) ? "bearbeiten" : "hinzufügen"}</DialogTitle><DialogDescription>Was möchtest du bis wann ansparen?</DialogDescription></DialogHeader>
          {editing && <form className="space-y-4" onSubmit={(event) => {
            event.preventDefault();
            const candidate = { ...editing, pocket: editing.pocket || editing.name.trim() };
            const parsed = savingsGoalSchema.safeParse(candidate);
            const taken = goals.some((goal) => goal.id !== candidate.id &&
              [pocketKey(goal.name), pocketKey(goal.pocket)].some((key) => key === pocketKey(candidate.name) || key === pocketKey(candidate.pocket)));
            if (!parsed.success || taken || ["sparkonto", "urlaub", "notgroschen"].includes(pocketKey(candidate.name))) {
              setError(parsed.success ? "Bitte einen eindeutigen Zielnamen verwenden, nicht Sparkonto, Urlaub oder Notgroschen." : parsed.error.issues[0].message); return;
            }
            const value = { ...parsed.data };
            if (value.target > (dashboard.actualGoals[value.id] ?? 0) && value.target !== goals.find((goal) => goal.id === value.id)?.target) delete value.completedAt;
            update((current) => ({ ...current,
              savingsGoals: [...savingsGoals(current).filter((goal) => goal.id !== value.id), value],
              settings: pocketKey(value.pocket) === "motorrad" ? { ...current.settings, bikeTarget: value.target, bikePurchaseDate: value.date } : current.settings,
            }));
            setEditing(null); toast.success("Sparziel gespeichert");
          }}>
            <label className="block text-xs">Name<Input aria-label="Name" className="editable mt-1" value={editing.name} maxLength={80} onChange={(event) => setEditing({ ...editing, name: event.target.value })} required /></label>
            <label className="block text-xs">Betrag (€)<Input aria-label="Betrag" className="editable mt-1" type="number" min="0.01" max="1000000000" step="0.01" value={editing.target || ""} onChange={(event) => setEditing({ ...editing, target: Number(event.target.value) })} required /></label>
            <label className="block text-xs">Bis-Datum<Input aria-label="Bis-Datum" className="editable mt-1" type="date" value={editing.date} onChange={(event) => setEditing({ ...editing, date: event.target.value })} required /></label>
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setEditing(null)}>Abbrechen</Button><Button type="submit">Speichern</Button></div>
          </form>}
        </DialogContent>
      </Dialog>
      <Dialog open={!!removing} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Sparziel entfernen?</DialogTitle><DialogDescription>{removing?.name}: Nur das Ziel und seine künftigen Raten entfallen. Buchungen und Kontostände bleiben erhalten.</DialogDescription></DialogHeader>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setRemoving(null)}>Abbrechen</Button><Button onClick={() => {
            update((current) => ({ ...current, savingsGoals: savingsGoals(current).filter((goal) => goal.id !== removing?.id) }));
            setRemoving(null);
          }}>Entfernen</Button></div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
