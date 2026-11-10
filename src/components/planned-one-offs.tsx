"use client";

import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogFooter, DialogForm, DialogTrigger } from "@/components/ui/dialog";
import { DialogStep, DialogSteps, Field, MoneyField, PremiumDialogContent, PremiumDialogHeader, ToggleRow } from "@/components/ui/premium-dialog";
import { addMonths, calculateMonthTotals, daysInMonth } from "@/lib/calc";
import { dateLabel, monthLabel } from "@/lib/format";
import { parseStatementAmount } from "@/lib/import/statements";
import { plannedOccurrences } from "@/lib/planned-one-offs";
import { dateSchema, plannedOneOffSchema, type PlannedOneOff } from "@/lib/types";
import { cn } from "@/lib/utils";

const amountLabel = (value: number) => `${new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 }).format(value)} €`;
const shortMonthLabel = (date: string) => new Intl.DateTimeFormat("de-AT", { month: "short", timeZone: "UTC" })
  .format(new Date(`${date}T12:00:00Z`)).replace(/\.$/, "");

export function PlannedOneOffLines() {
  const { state, dashboard } = useFinance();
  const open = dashboard.plannedOneOffs.filter((item) => !item.bookingId);
  const current = open.filter((item) => item.date.startsWith(dashboard.currentMonth));
  const horizon = new Date(`${state.settings.asOf}T12:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 30);
  const upcoming = open.filter((item) => !item.date.startsWith(dashboard.currentMonth) &&
    item.date > state.settings.asOf && item.date <= horizon.toISOString().slice(0, 10));
  if (!current.length && !upcoming.length) return null;
  const groups = new Map<string, typeof current>();
  if (current.length) groups.set(dashboard.currentMonth, current);
  for (const item of upcoming) {
    const month = item.date.slice(0, 7);
    const group = groups.get(month);
    if (group) group.push(item);
    else groups.set(month, [item]);
  }
  return <section className="panel min-w-0 p-4 sm:p-5" aria-label="Geplante Ausgaben">
    <h2 className="mb-4 flex items-center gap-2 text-sm font-medium"><CalendarDays aria-hidden="true" className="size-4 text-muted-foreground" />Geplant</h2>
    <FinancialData className="space-y-4">
      {[...groups].map(([month, items]) => <div key={month} className="flex items-start gap-3">
        <time dateTime={month} title={monthLabel(month)} className="inline-flex min-w-10 shrink-0 justify-center rounded-lg bg-muted/60 px-2 py-1 text-2xs font-medium text-muted-foreground">
          {shortMonthLabel(`${month}-01`)}
        </time>
        <ul className="min-w-0 flex-1 space-y-2" aria-label={`Geplant ${monthLabel(month)}`}>
          {items.map((item) => <li key={item.id} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 break-words text-foreground/80">{item.name}</span>{" "}
            <span className="shrink-0 whitespace-nowrap font-medium tabular-nums">{amountLabel(item.ownAmount)}</span>
          </li>)}
        </ul>
      </div>)}
    </FinancialData>
  </section>;
}

export function PlannedOneOffs({ className }: { className?: string } = {}) {
  const finance = useFinance();
  const { state, update, storageError } = finance;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [name, setName] = useState("");
  const [date, setDate] = useState(state.settings.asOf);
  const [month, setMonth] = useState(state.settings.asOf.slice(0, 7));
  const [amount, setAmount] = useState("");
  const [pocket, setPocket] = useState<PlannedOneOff["pocket"]>("Giro");
  const [installments, setInstallments] = useState("1");
  const [total, setTotal] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<string>();
  const items = state.plannedOneOffs ?? [];
  const reset = () => {
    setEditing(undefined); setDeleting(undefined); setName(""); setDate(state.settings.asOf);
    setMonth(state.settings.asOf.slice(0, 7)); setAmount(""); setPocket("Giro");
    setInstallments("1"); setTotal(""); setShared(false); setError(""); setInvalid(undefined);
  };
  const changeOpen = (value: boolean) => { setOpen(value); reset(); };
  const draft = {
    id: editing ?? "preview", name, date, amount: parseStatementAmount(amount),
    pocket, installments: Number(installments || "1"), sharedWithRaphael: shared,
    ...(total ? { total: parseStatementAmount(total) } : {}),
    ...(editing ? { paidOccurrences: items.find((item) => item.id === editing)?.paidOccurrences } : {}),
  };
  const preview = plannedOneOffSchema.safeParse({ ...draft, name: name || "Vorschau" });
  let remaining: number | undefined;
  if (open && preview.success) {
    const month = date.slice(0, 7);
    const dashboard = finance.dashboard;
    const totals = dashboard.timeline.find((row) => row.month === month) ??
      calculateMonthTotals(state, month, { currentMonth: dashboard.currentMonth });
    const previous = dashboard.plannedOneOffs.filter((item) => item.itemId === editing && item.date.startsWith(month))
      .reduce((sum, item) => sum + item.ownAmount, 0);
    remaining = Math.round((totals.surplus + previous - plannedOccurrences([preview.data])[0].ownAmount) * 100) / 100;
  }
  const marked = new Set(plannedOccurrences(items).map((item) => item.date));
  const offset = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
  const edit = (item: PlannedOneOff) => {
    setEditing(item.id); setDeleting(undefined); setName(item.name); setDate(item.date);
    setMonth(item.date.slice(0, 7)); setAmount(String(item.amount).replace(".", ","));
    setPocket(item.pocket); setInstallments(String(item.installments));
    setTotal(item.total === undefined ? "" : String(item.total).replace(".", ","));
    setShared(item.sharedWithRaphael === true); setError("");
  };
  const save = () => {
    if (storageError) { setError(storageError); return; }
    const parsed = plannedOneOffSchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    const item = { ...parsed.data, id: editing ?? crypto.randomUUID() };
    update((current) => ({ ...current,
      plannedOneOffs: [...(current.plannedOneOffs ?? []).filter((row) => row.id !== editing), item],
    }));
    reset();
  };
  // Each step reports the first schema problem of its own fields.
  const stepValid = (fields: string[]) => {
    const parsed = plannedOneOffSchema.safeParse(draft);
    const issue = parsed.success ? undefined : parsed.error.issues.find((item) => fields.includes(String(item.path[0])));
    setError(issue?.message ?? "");
    setInvalid(issue ? String(issue.path[0]) : undefined);
    return !issue;
  };
  const fieldError = (field: string) => invalid === field || undefined;
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><Button size="sm" variant="outline" className={className} disabled={!!storageError}>Geplante Ausgaben</Button></DialogTrigger>
    <PremiumDialogContent size="md">
      <PremiumDialogHeader title="Geplante Ausgaben" description="Einmalig oder in Raten." />
      {deleting ? <DialogForm noValidate onSubmit={(event) => {
        event.preventDefault();
        if (storageError) { setError(storageError); return; }
        update((current) => ({ ...current, plannedOneOffs: current.plannedOneOffs?.filter((item) => item.id !== deleting) }));
        reset();
      }}>
        <DialogBody className="space-y-3">
          <p className="text-sm">„{items.find((item) => item.id === deleting)?.name}“ wirklich löschen?</p>
          {(error || storageError) && <p role="alert" className="text-sm text-destructive">{error || storageError}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setDeleting(undefined)}>Abbrechen</Button>
          <Button type="submit" variant="destructive" disabled={!!storageError}>Löschen bestätigen</Button>
        </DialogFooter>
      </DialogForm> : <DialogSteps key={editing ?? "new"} mode="auto" editing={!!editing} submitLabel={editing ? "Änderung speichern" : "Ausgabe speichern"}
        submitDisabled={!!storageError} onComplete={save}
        message={(error || storageError) && <p role="alert" className="text-sm text-destructive">{error || storageError}</p>}>
        <DialogStep id="what" title="Was & wann" validate={() => stepValid(["name", "date", "pocket"])}>
          {items.length > 0 && <section aria-label="Bereits geplant" className="space-y-1 rounded-2xl border border-border/70 p-2">
            {items.map((item) => {
              const booked = finance.dashboard.plannedOneOffs.filter((occurrence) => occurrence.itemId === item.id && occurrence.bookingId).length;
              return <div key={item.id} className={cn("flex flex-wrap items-center gap-1 rounded-xl py-1 pr-1 pl-3 text-xs", item.id === editing && "bg-accent-muted/50")}>
                <span className="min-w-0 flex-1">{item.name} · {dateLabel(item.date)} · {amountLabel(item.amount)}{item.installments > 1 ? ` · ${item.installments}×` : ""}{booked ? item.installments === 1 ? " · Gebucht" : ` · ${booked}/${item.installments} gebucht` : ""}</span>
                <Button type="button" size="sm" variant="ghost" aria-label={`Bearbeiten: ${item.name}`} onClick={() => edit(item)}>Bearbeiten</Button>
                <Button type="button" size="sm" variant="ghost" disabled={!!storageError} aria-label={`Löschen: ${item.name}`} onClick={() => { setDeleting(item.id); setError(""); }}>Löschen</Button>
              </div>;
            })}
          </section>}
          <Field label="Name">
            <Input value={name} maxLength={100} aria-invalid={fieldError("name")} onChange={(event) => { setName(event.target.value); setInvalid(undefined); }} />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Datum">
              <Input type="date" value={date} aria-invalid={fieldError("date")} onChange={(event) => {
                setDate(event.target.value);
                setInvalid(undefined);
                if (dateSchema.safeParse(event.target.value).success) setMonth(event.target.value.slice(0, 7));
              }} />
            </Field>
            <Field label="Pocket">
              <select className="select-input w-full" value={pocket}
                onChange={(event) => setPocket(event.target.value === "Sparkonto" ? "Sparkonto" : "Giro")}><option>Giro</option><option>Sparkonto</option></select>
            </Field>
          </div>
          <div className="max-w-72 rounded-2xl border border-border/70 p-3" aria-label="Monatskalender">
            <div className="mb-2 flex items-center justify-between">
              <Button type="button" size="icon" variant="ghost" aria-label="Voriger Monat" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft className="size-4" /></Button>
              <span className="text-xs font-medium">{monthLabel(month)}</span>
              <Button type="button" size="icon" variant="ghost" aria-label="Nächster Monat" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight className="size-4" /></Button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-xs">
              {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((day) => <span key={day} className="text-muted-foreground">{day}</span>)}
              {Array.from({ length: offset }, (_, index) => <span key={`space-${index}`} />)}
              {Array.from({ length: daysInMonth(month) }, (_, index) => {
                const day = `${month}-${String(index + 1).padStart(2, "0")}`;
                return <button key={day} type="button" aria-pressed={day === date}
                  className={cn("relative rounded-lg py-2 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring", day === date && "bg-primary text-primary-foreground hover:bg-primary")}
                  aria-label={`${dateLabel(day)}${marked.has(day) ? " · Geplante Ausgabe" : ""}`}
                  onClick={() => { setDate(day); setInvalid(undefined); }}>{index + 1}{marked.has(day) && <span aria-hidden="true" className={cn("absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full", day === date ? "bg-primary-foreground" : "bg-primary")} />}</button>;
              })}
            </div>
          </div>
        </DialogStep>
        <DialogStep id="amount" title="Betrag & Raten" validate={() => stepValid(["amount", "installments", "total"])}>
          <Field label="Betrag" hint={remaining !== undefined ? undefined : "Pro Rate, bei geteilten Kosten der Gesamtbetrag."}>
            <MoneyField value={amount} aria-invalid={fieldError("amount")} onValueChange={(value) => { setAmount(value); setInvalid(undefined); }} />
          </Field>
          {remaining !== undefined && <p role="status" className={`-mt-3 text-xs ${remaining < 0 ? "text-destructive" : "text-muted-foreground"}`}>
            {remaining < 0 ? `Fehlen ${amountLabel(-remaining)}` : `Danach ${amountLabel(remaining)}`}
          </p>}
          <ToggleRow checked={shared} onCheckedChange={setShared} label="Mit Raphael teilen" description="Nur dein Anteil belastet den Monatsplan." />
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="N × ab Datum">
              <Input type="number" min={1} max={120} value={installments} aria-invalid={fieldError("installments")}
                onChange={(event) => { setInstallments(event.target.value); setTotal(""); setInvalid(undefined); }} />
            </Field>
            {Number(installments) > 1 && <Field label="Gesamtbetrag" optional>
              <MoneyField value={total} aria-invalid={fieldError("total")} onValueChange={(value) => { setTotal(value); setInvalid(undefined); }} />
            </Field>}
          </div>
        </DialogStep>
      </DialogSteps>}
    </PremiumDialogContent>
  </Dialog>;
}
