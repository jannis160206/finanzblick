"use client";

import { useMemo, useState } from "react";
import { Ban, Check, Lock, RotateCcw, TriangleAlert } from "lucide-react";
import { BankLogo } from "@/components/bank-logo";
import { FinancialData } from "@/components/financial-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChoiceCards, DialogStep, DialogSteps, Field, MoneyField, PremiumDialog, PremiumDialogContent, PremiumDialogHeader, ToggleRow,
  moneyText, moneyValue, type ChoiceOption,
} from "@/components/ui/premium-dialog";
import { daysInMonth, round, type Dashboard } from "@/lib/calc";
import { currency, dateLabel, monthLabel, percent } from "@/lib/format";
import { forgoneInterest, GOAL_SURPLUS, goalPlanningContext, planGoal, sourceAllowed, type PlanResult, type PlanSource } from "@/lib/goal-planner";
import { pocketKey } from "@/lib/goals";
import type { AppState, GoalPlanRow, SavingsGoal } from "@/lib/types";
import { cn } from "@/lib/utils";

export type GoalSave = { goal: SavingsGoal; opening: number };

export type SavingsGoalWizardProps = {
  open: boolean;
  goal: SavingsGoal;
  isNew: boolean;
  goals: SavingsGoal[];
  state: AppState;
  dashboard: Dashboard;
  disabled: boolean;
  storageError: string | null;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  onSave: (save: GoalSave) => void;
};

type Form = {
  name: string;
  target: string;
  date: string;
  asap: boolean;
  startAmount: string;
  /** "pocket": already on the goal's pocket; otherwise the account it is moved from. */
  startSource: string;
  sources: string[];
  auto: boolean;
  monthly: string;
  locked: GoalPlanRow[];
  excludedMonths: string[];
  /** Trade Republic (Notgroschen) included for this goal despite its account rule. */
  exception: boolean;
  keep: string;
};

type ErrorKey = "name" | "target" | "date" | "startAmount" | "sources" | "monthly";
type Errors = Partial<Record<ErrorKey, string>>;

const ON_POCKET = "pocket";
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const monthEnd = (month: string) => `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
const reservedNames = ["sparkonto", "urlaub", "notgroschen", "giro", "girokonto"];

const stepFields: Record<string, ErrorKey[]> = {
  goal: ["name", "target", "date"],
  start: ["startAmount"],
  sources: ["sources"],
  plan: ["monthly"],
};

/** Create or edit a savings goal in five steps with a distribution the user can adjust row by row. */
export default function SavingsGoalWizard(props: SavingsGoalWizardProps) {
  return (
    <PremiumDialog open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
      <WizardSurface {...props} />
    </PremiumDialog>
  );
}

function WizardSurface({ goal, isNew, goals, state, dashboard, disabled, storageError, onCloseAutoFocus, onSave }: SavingsGoalWizardProps) {
  const today = state.settings.asOf;
  const context = useMemo(() => goalPlanningContext(state, dashboard, today, isNew ? undefined : goal), [state, dashboard, today, goal, isNew]);
  const [initial] = useState<Form>(() => {
    const plan = goal.funding?.plan;
    const start = goal.start;
    const excludedAccounts = new Set(goal.funding?.excluded?.accounts ?? []);
    const exceptional = context.sources.find((source) => source.exception);
    const saved = goal.funding?.exceptions?.find((entry) => entry.account === exceptional?.id);
    return {
      name: goal.name,
      target: goal.target ? moneyText(goal.target) : "",
      date: isNew ? "" : goal.date,
      asap: !!goal.asap,
      startAmount: start ? moneyText(start.amount) : "",
      startSource: start?.account ?? (context.balance === null ? ON_POCKET : GOAL_SURPLUS),
      sources: plan
        ? context.sources.filter((source) => !excludedAccounts.has(source.id) &&
          (sourceAllowed(source, goal.name, goal.pocket || goal.name) || (!!source.exception && !!saved))).map((source) => source.id)
        : [GOAL_SURPLUS],
      auto: isNew || !!goal.funding?.auto,
      monthly: goal.funding ? moneyText(goal.funding.monthly) : "",
      locked: plan?.filter((row) => row.locked && !(start && row.account === start.account && row.amount === start.amount && row.month === start.date.slice(0, 7))) ?? [],
      excludedMonths: goal.funding?.excluded?.months ?? [],
      exception: !!saved,
      keep: moneyText(saved?.keep ?? exceptional?.keep ?? 0),
    };
  });
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});

  const name = form.name.trim();
  const pocket = goal.pocket || name;
  const target = moneyValue(form.target);
  const startAmount = moneyValue(form.startAmount) ?? 0;
  const startOnPocket = form.startSource === ON_POCKET ? startAmount : 0;
  const balance = context.balance ?? 0;
  const need = round(Math.max(0, (target ?? 0) - balance - startOnPocket));
  const goalMonth = form.asap || !isDate(form.date) ? undefined : form.date.slice(0, 7);
  const ruleName = name || goal.name;
  const keep = Math.max(0, moneyValue(form.keep) ?? 0);
  const sources = useMemo(() => context.sources.map((source) => ({
    ...source, allowed: sourceAllowed(source, ruleName, pocket) || (!!source.exception && form.exception),
  })), [context.sources, ruleName, pocket, form.exception]);
  // What a source can give: an exception account keeps its minimum.
  const room = (source: PlanSource) => source.kind === "surplus" ? context.capacity[context.months[0]] ?? 0
    : Math.max(0, source.available - (source.exception ? keep : 0));
  const selected = useMemo(() => sources.filter((source) => source.allowed && form.sources.includes(source.id)), [sources, form.sources]);
  const firstMonth = context.months[0];
  const startRow = useMemo<GoalPlanRow | undefined>(() => startAmount > 0 && form.startSource !== ON_POCKET && firstMonth
    ? { month: firstMonth, account: form.startSource, amount: startAmount, locked: true } : undefined, [startAmount, form.startSource, firstMonth]);
  const plan = useMemo<PlanResult>(() => planGoal({
    need, months: context.months, goalMonth, capacity: context.capacity, continuation: context.continuation,
    accounts: selected.filter((source) => source.kind === "pocket")
      .sort((a, b) => Number(a.id === "Notgroschen") - Number(b.id === "Notgroschen") || b.available - a.available)
      .map((source) => ({
        id: source.id, late: !!source.exception,
        available: Math.max(0, source.available - (source.exception ? keep : 0) - (startRow?.account === source.id ? startRow.amount : 0)),
      })),
    surplus: selected.some((source) => source.id === GOAL_SURPLUS),
    // An edited start-capital row replaces the one from the start step.
    locked: [...startRow && !form.locked.some((row) => row.month === startRow.month && row.account === startRow.account) ? [startRow] : [], ...form.locked],
    excludedMonths: form.excludedMonths,
  }), [need, context, goalMonth, selected, startRow, form.locked, form.excludedMonths, keep]);
  const fastest = useMemo(() => goalMonth && plan.missing > 0 ? planGoal({
    need, months: context.months, capacity: context.capacity, continuation: context.continuation,
    accounts: selected.filter((source) => source.kind === "pocket")
      .map((source) => ({ id: source.id, late: !!source.exception, available: Math.max(0, source.available - (source.exception ? keep : 0)) })),
    surplus: selected.some((source) => source.id === GOAL_SURPLUS), locked: startRow ? [startRow] : [], excludedMonths: form.excludedMonths,
  }).reached : undefined, [goalMonth, plan.missing, need, context, selected, startRow, form.excludedMonths, keep]);
  const labels = useMemo(() => Object.fromEntries(context.sources.map((source) => [source.id, {
    label: source.kind === "surplus" ? "Girokonto" : source.bank === "Trade Republic" ? "Trade Republic" : source.label, bank: source.bank,
  }])), [context.sources]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  function patch(update: Partial<Form>, cleared: ErrorKey[] = []) {
    setForm((current) => ({ ...current, ...update }));
    if (cleared.length) setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !cleared.includes(key as ErrorKey))));
  }

  function validate(): Errors {
    const found: Errors = {};
    const key = pocketKey(name);
    if (!name || name.length > 80) found.name = "Bitte einen Zielnamen mit 1 bis 80 Zeichen eingeben.";
    else if (reservedNames.includes(key) || goals.some((other) => other.id !== goal.id &&
      [pocketKey(other.name), pocketKey(other.pocket)].some((value) => value === key || value === pocketKey(pocket)))) {
      found.name = "Bitte einen eindeutigen Zielnamen verwenden, nicht Sparkonto, Urlaub, Notgroschen oder Giro.";
    }
    if (target === null || target <= 0 || target > 1_000_000_000) found.target = "Bitte einen Betrag größer als 0 und höchstens 1.000.000.000 € eingeben.";
    if (!form.asap) {
      if (!isDate(form.date)) found.date = "Bitte ein gültiges Zieldatum angeben – oder „So schnell wie möglich“ wählen.";
      else if (form.date < today && (isNew || form.date !== goal.date)) found.date = "Das Zieldatum liegt in der Vergangenheit.";
    }
    const start = moneyValue(form.startAmount);
    if (form.startAmount.trim() && (start === null || start < 0)) found.startAmount = "Bitte einen gültigen Betrag eingeben.";
    else if (start && target && start >= target) found.startAmount = "Das Startkapital deckt das Ziel schon – dafür braucht es kein Sparziel.";
    else if (start && form.startSource !== ON_POCKET) {
      const source = sources.find((item) => item.id === form.startSource);
      const free = source ? room(source) : 0;
      if (start > free + 0.005) found.startAmount = `Vom ${labels[form.startSource]?.label ?? form.startSource} sind jetzt nur ${currency(free)} frei.`;
    }
    if (form.auto && !selected.length) found.sources = "Bitte mindestens ein Konto auswählen.";
    if (!form.auto && form.monthly.trim() && (moneyValue(form.monthly) === null || moneyValue(form.monthly)! < 0)) found.monthly = "Bitte eine gültige Monatsrate eingeben.";
    return found;
  }

  function check(step: string) {
    const keys = stepFields[step] ?? [];
    const found = validate();
    const relevant = Object.fromEntries(keys.flatMap((key) => found[key] ? [[key, found[key]]] : []));
    setErrors((current) => ({ ...Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key as ErrorKey))), ...relevant }));
    return !Object.keys(relevant).length;
  }

  function complete() {
    if (disabled || target === null) return;
    const value: SavingsGoal = { ...goal, name, pocket, target, date: form.asap ? monthEnd(plan.reached ?? context.months.at(-1)!) : form.date };
    if (form.asap) value.asap = true; else delete value.asap;
    if (form.auto) {
      const from = context.months[0];
      const horizon = context.months.at(-1)!;
      const until = (form.asap ? plan.reached ?? horizon : goalMonth ?? horizon);
      const surplusRows = plan.rows.filter((row) => row.account === GOAL_SURPLUS && row.amount > 0);
      const monthly = plan.continuation?.monthly ?? (surplusRows.length ? Math.round(surplusRows.reduce((sum, row) => sum + row.amount, 0) / surplusRows.length) : 0);
      const exception = form.exception ? sources.find((source) => source.exception) : undefined;
      const excludedAccounts = sources.filter((source) => source.allowed && !source.exception && !form.sources.includes(source.id)).map((source) => source.id);
      value.funding = {
        monthly, extras: { ...goal.funding?.extras ?? {} },
        ...(goal.funding?.paused ? { paused: goal.funding.paused } : {}),
        plan: plan.rows.map((row) => ({ month: row.month, account: row.account, amount: row.amount, ...(row.locked ? { locked: true } : {}) })),
        window: { from, to: until < from ? from : until > horizon ? horizon : until },
        ...(form.excludedMonths.length || excludedAccounts.length ? { excluded: {
          ...(form.excludedMonths.length ? { months: [...form.excludedMonths].sort() } : {}),
          ...(excludedAccounts.length ? { accounts: excludedAccounts } : {}),
        } } : {}),
        auto: true,
        ...(exception && form.sources.includes(exception.id) ? { exceptions: [{ account: exception.id, keep }] } : {}),
      };
      if (startRow && startRow.account !== GOAL_SURPLUS) value.start = { amount: startRow.amount, account: startRow.account, date: today };
      else delete value.start;
    } else {
      const monthly = moneyValue(form.monthly);
      const kept = goal.funding && !goal.funding.auto && form.monthly === initial.monthly;
      if (kept) value.funding = goal.funding;
      else if (monthly === null && !Object.keys(goal.funding?.extras ?? {}).length) delete value.funding;
      else value.funding = { monthly: monthly ?? 0, extras: { ...goal.funding?.extras ?? {} }, ...(goal.funding?.paused ? { paused: goal.funding.paused } : {}) };
      delete value.start;
    }
    onSave({ goal: value, opening: startOnPocket });
  }

  const startOptions: ChoiceOption<string>[] = [
    ...(context.balance === null ? [{ value: ON_POCKET, label: "Liegt schon bereit", description: `auf dem Pocket ${pocket || "des Ziels"}` }] : []),
    ...sources.filter((source) => source.allowed).map((source) => {
      const free = room(source);
      return {
        value: source.id, label: source.kind === "surplus" ? "Vom Girokonto" : `Vom ${labels[source.id]?.label ?? source.label}`,
        description: source.kind === "surplus" ? "aus dem Überschuss dieses Monats" : source.exception ? "Ausnahme · Umbuchung diesen Monat" : "Umbuchung diesen Monat",
        meta: <FinancialData as="span">{free > 0 ? `${currency(free)} frei` : "diesen Monat nichts frei"}</FinancialData>,
        disabled: free <= 0 && form.startSource !== source.id,
      };
    }),
  ];
  const title = isNew ? "Sparziel hinzufügen" : "Sparziel bearbeiten";

  return (
    <PremiumDialogContent size="lg" dirty={dirty} onCloseAutoFocus={onCloseAutoFocus}>
      <PremiumDialogHeader title={title} description={isNew ? "Was möchtest du bis wann ansparen – und woher kommt das Geld?" : "Ziel, Konten und Verteilung anpassen."} />
      <DialogSteps mode="always" editing={!isNew} disabled={disabled} onComplete={complete}
        submitLabel={isNew ? "Sparziel anlegen" : "Speichern"}
        message={storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}>
        <DialogStep id="goal" title="Ziel" validate={() => check("goal")}>
          <Field label="Name" error={errors.name}>
            <Input autoFocus value={form.name} maxLength={80} autoComplete="off" placeholder="z. B. Kamera oder Reise"
              onChange={(event) => patch({ name: event.target.value }, ["name"])} />
          </Field>
          <Field label="Zielbetrag" error={errors.target}>
            <MoneyField value={form.target} onValueChange={(value) => patch({ target: value }, ["target", "startAmount"])} />
          </Field>
          <ToggleRow checked={form.asap} onCheckedChange={(asap) => patch({ asap }, ["date"])}
            label="So schnell wie möglich" description="Finanzblick plant mit dem vollen freien Betrag und berechnet das Datum." />
          {!form.asap && (
            <Field label="Zieldatum" error={errors.date}>
              <Input type="date" value={form.date} min={today} className="sm:max-w-56" onChange={(event) => patch({ date: event.target.value }, ["date"])} />
            </Field>
          )}
        </DialogStep>
        <DialogStep id="start" title="Startkapital" validate={() => check("start")}>
          {context.balance !== null && (
            <p className="rounded-xl bg-muted/50 px-4 py-3 text-sm">
              Auf dem Pocket {pocket} liegen schon <FinancialData as="span" className="font-semibold tabular-nums">{currency(context.balance)}</FinancialData>; das zählt bereits.
            </p>
          )}
          <Field label="Startkapital" optional error={errors.startAmount} hint="Ein Betrag, der gleich zu Beginn ins Ziel fließt.">
            <MoneyField value={form.startAmount} onValueChange={(value) => patch({ startAmount: value }, ["startAmount"])} />
          </Field>
          {startAmount > 0 && (
            <Field label="Woher kommt es?" group>
              <ChoiceCards value={form.startSource} options={startOptions} onValueChange={(startSource) => patch({ startSource }, ["startAmount"])} />
            </Field>
          )}
        </DialogStep>
        <DialogStep id="sources" title="Konten" validate={() => check("sources")}>
          <SourcePicker sources={sources} selected={form.sources} error={errors.sources} months={context.months.length}
            exception={form.exception} keep={form.keep} onKeep={(value) => patch({ keep: value })}
            onException={(id, on) => patch({ exception: on, sources: on ? [...new Set([...form.sources, id])] : form.sources.filter((item) => item !== id),
              ...(!on && form.startSource === id ? { startSource: initial.startSource === id ? GOAL_SURPLUS : initial.startSource } : {}) }, ["sources", "startAmount"])}
            onToggle={(id, on) => patch({ sources: on ? [...new Set([...form.sources, id])] : form.sources.filter((item) => item !== id) }, ["sources"])} />
        </DialogStep>
        <DialogStep id="plan" title="Verteilung" validate={() => check("plan")}>
          <ToggleRow checked={form.auto} onCheckedChange={(auto) => patch({ auto }, ["monthly", "sources"])}
            label="Automatisch planen" description="Verteilt den Rest auf Monate und Konten – mit Fixkosten, Verträgen, Einnahmen und der aktuellen Prognose." />
          {form.auto ? (
            <PlanEditor plan={plan} need={need} goalMonth={goalMonth} asap={form.asap} fastest={fastest} excludedMonths={form.excludedMonths}
              labels={labels} months={context.months.filter((month) => month <= (goalMonth ?? plan.reached ?? context.months.at(-1)!))}
              startKey={startRow ? `${startRow.month}-${startRow.account}` : undefined}
              rate={sources.find((source) => source.exception)?.rate} endMonth={goalMonth ?? plan.reached}
              onMove={(row, month) => patch({ locked: [...form.locked.filter((item) => item.month !== row.month || item.account !== row.account), { month, account: row.account, amount: row.amount, locked: true }] })}
              onAmount={(row, amount) => patch({ locked: [...form.locked.filter((item) => item.month !== row.month || item.account !== row.account), { month: row.month, account: row.account, amount, locked: true }] })}
              onReset={(row) => patch({ locked: form.locked.filter((item) => item.month !== row.month || item.account !== row.account) })}
              onExclude={(month) => patch({ excludedMonths: [...new Set([...form.excludedMonths, month])], locked: form.locked.filter((item) => item.month !== month) })}
              onInclude={(month) => patch({ excludedMonths: form.excludedMonths.filter((item) => item !== month) })}
              onMoveDate={(month) => patch({ date: monthEnd(month) }, ["date"])} />
          ) : (
            <>
              <Field label="Monatliche Rate" optional error={errors.monthly}
                hint={form.monthly.trim() ? "Fester Betrag pro Monat aus dem Überschuss." : "Leer lassen: der Überschuss füllt das Ziel nach Termin, wie bisher."}>
                <MoneyField value={form.monthly} onValueChange={(monthly) => patch({ monthly }, ["monthly"])} />
              </Field>
              {goalMonth && need > 0 && (
                <p className="text-xs text-muted-foreground">
                  Für {dateLabel(form.date)} nötig: etwa <FinancialData as="span" className="font-medium tabular-nums">{currency(Math.ceil(need / Math.max(1, context.months.filter((month) => month <= goalMonth).length)))}</FinancialData> pro Monat.
                </p>
              )}
              {startRow && startRow.account !== GOAL_SURPLUS && (
                <p className="flex gap-2 text-xs text-muted-foreground"><TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
                  Ohne automatische Planung entfällt die Umbuchung vom {startRow.account}.</p>
              )}
            </>
          )}
        </DialogStep>
        <DialogStep id="overview" title="Übersicht">
          <GoalOverview name={name || "Neues Ziel"} target={target ?? 0} saved={round(balance + startOnPocket)} plan={form.auto ? plan : null}
            date={form.asap ? plan.reached && monthEnd(plan.reached) : isDate(form.date) ? form.date : undefined} asap={form.asap}
            monthly={moneyValue(form.monthly)} months={context.months.filter((month) => month <= (goalMonth ?? plan.reached ?? context.months.at(-1)!))}
            excludedMonths={form.excludedMonths} exceptionAccount={form.exception ? sources.find((source) => source.exception)?.id : undefined} />
        </DialogStep>
      </DialogSteps>
    </PremiumDialogContent>
  );
}

function SourcePicker({ sources, selected, error, months, exception, keep, onKeep, onException, onToggle }: {
  sources: (PlanSource & { allowed: boolean })[];
  selected: string[];
  error?: string;
  months: number;
  exception: boolean;
  keep: string;
  onKeep: (value: string) => void;
  onException: (id: string, on: boolean) => void;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <>
      <p className="text-sm leading-relaxed text-muted-foreground">Woher darf das Geld kommen? Der Monatsüberschuss zuerst, Guthaben nur, wenn er nicht reicht.</p>
      {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
      <ul className="space-y-2">
        {sources.map((source) => {
          if (source.exception) return <ExceptionSource key={source.id} source={source} on={exception} keep={keep} onKeep={onKeep} onChange={(on) => onException(source.id, on)} />;
          const checked = source.allowed && selected.includes(source.id);
          return (
            <li key={source.id}>
              <label className={cn("grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border px-4 py-3 transition-colors",
                source.allowed ? "cursor-pointer hover:bg-muted/40" : "cursor-not-allowed opacity-60",
                checked ? "border-primary/60 bg-accent-muted/40" : "border-border/70")}>
                <input type="checkbox" className="peer sr-only" checked={checked} disabled={!source.allowed}
                  onChange={(event) => onToggle(source.id, event.target.checked)} />
                <span aria-hidden="true" className={cn("flex size-5 items-center justify-center rounded-md border border-input bg-background transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
                  checked && "border-primary bg-primary text-primary-foreground")}>
                  {checked && <Check className="size-3.5" strokeWidth={3} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{source.kind === "surplus" ? "Girokonto · Monatsüberschuss" : source.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {source.allowed
                      ? source.kind === "surplus" ? `frei in den nächsten ${months} Monaten`
                        : source.detail && /vorgemerkt/.test(source.detail) ? source.detail : "einmalige Umbuchung"
                      : ruleNote(source)}
                  </span>
                </span>
                <FinancialData as="span" className="text-right">
                  <span className="block text-sm font-semibold tabular-nums">{currency(source.kind === "surplus" ? source.perMonth ?? 0 : source.available)}</span>
                  <span className="block text-2xs text-muted-foreground">{source.kind === "surplus" ? "Ø pro Monat" : "verfügbar"}</span>
                </FinancialData>
              </label>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const ruleNote = (source: PlanSource) =>
  source.use === "never" ? "Kontoregel: nie angreifen" : `Kontoregel: nur für ${source.purposes.join(", ") || source.label}`;

/** Trade Republic: blocked by the Notgroschen rule, usable for this goal only as a deliberate exception. */
function ExceptionSource({ source, on, keep, onKeep, onChange }: {
  source: PlanSource; on: boolean; keep: string; onKeep: (value: string) => void; onChange: (on: boolean) => void;
}) {
  const kept = Math.max(0, moneyValue(keep) ?? 0);
  const usable = Math.max(0, source.available - kept);
  return (
    <li className={cn("rounded-2xl border transition-colors", on ? "border-primary/60 bg-accent-muted/40" : "border-border/70")}>
      <div className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
        <BankLogo bank={source.bank} size="md" />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{source.label}</span>
          <span className="block text-xs text-muted-foreground">
            {on ? "Ausnahme · wird zuletzt und so spät wie möglich genutzt" : ruleNote(source)}
            {source.rate ? ` · ${percent(source.rate)} Zinsen` : ""}
          </span>
        </span>
        <FinancialData as="span" className="text-right">
          <span className="block text-sm font-semibold tabular-nums">{currency(on ? usable : source.available)}</span>
          <span className="block text-2xs text-muted-foreground">{on ? "verplanbar" : "Guthaben"}</span>
        </FinancialData>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-border/60 px-4 py-3">
        <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
          className="group inline-flex min-h-11 items-center gap-3 rounded-lg text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span aria-hidden="true" className={cn("relative inline-flex h-6 w-10 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")}>
            <span className={cn("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200", on && "translate-x-4")} />
          </span>
          Als Ausnahme einbeziehen
        </button>
        {on && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Mindestens behalten
            <MoneyField aria-label="Mindestens behalten" className="h-9 w-32" value={keep} onValueChange={onKeep} />
          </label>
        )}
      </div>
    </li>
  );
}

function PlanEditor({ plan, need, goalMonth, asap, fastest, excludedMonths, labels, months, startKey, rate, endMonth, onAmount, onMove, onReset, onExclude, onInclude, onMoveDate }: {
  plan: PlanResult;
  labels: Record<string, { label: string; bank?: string }>;
  /** Months a transfer may be moved to. */
  months: string[];
  /** The start-capital row stays in the first month. */
  startKey?: string;
  /** Interest rate of the exception account, for the hint on earlier transfers. */
  rate?: number;
  endMonth?: string;
  onMove: (row: GoalPlanRow, month: string) => void;
  need: number;
  goalMonth?: string;
  asap: boolean;
  fastest?: string;
  excludedMonths: string[];
  onAmount: (row: GoalPlanRow, amount: number) => void;
  onReset: (row: GoalPlanRow) => void;
  onExclude: (month: string) => void;
  onInclude: (month: string) => void;
  onMoveDate: (month: string) => void;
}) {
  if (need <= 0) {
    return <p className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success">Das Ziel ist mit dem vorhandenen Geld schon erreicht.</p>;
  }
  const visible = plan.rows.filter((row) => row.amount > 0 || row.locked);
  return (
    <div className="space-y-3">
      <div aria-live="polite" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3 text-sm",
        plan.missing > 0 ? "bg-warning-soft text-warning" : "bg-success-soft text-success")}>
        {plan.missing > 0 ? <TriangleAlert aria-hidden="true" className="size-4 shrink-0" /> : <Check aria-hidden="true" className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1">
          {plan.missing > 0
            ? <>Es fehlen <FinancialData as="span" className="font-semibold tabular-nums">{currency(plan.missing)}</FinancialData>{goalMonth ? ` bis ${monthLabel(goalMonth)}` : ""}. Datum verschieben oder unter „Konten“ ein Konto ergänzen.</>
            : asap ? <>Ziel erreicht voraussichtlich im <strong>{plan.reached ? monthLabel(plan.reached) : "–"}</strong>.</>
              : <>Ziel erreicht im <strong>{plan.reached ? monthLabel(plan.reached) : "–"}</strong>{goalMonth && plan.reached && plan.reached < goalMonth ? " – früher als nötig" : ""}.</>}
        </span>
        {plan.missing > 0 && fastest && <Button type="button" size="sm" variant="outline" onClick={() => onMoveDate(fastest)}>Auf {monthLabel(fastest, true)} verschieben</Button>}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border/70">
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">Geplante Einzahlungen je Monat und Konto</caption>
          <thead className="bg-muted/40 text-left text-2xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium sm:w-[27%]"><span className="sm:hidden">Monat · Konto</span><span className="hidden sm:inline">Monat</span></th>
              <th scope="col" className="hidden px-2 py-2 font-medium sm:table-cell sm:w-[30%]">Konto</th>
              <th scope="col" className="w-28 px-2 py-2 text-right font-medium sm:w-auto">Betrag</th>
              <th scope="col" className="w-11"><span className="sr-only">Anpassen</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visible.map((row, index) => {
              const first = visible[index - 1]?.month !== row.month;
              const account = labels[row.account] ?? { label: row.account };
              const label = `${monthLabel(row.month)}, ${account.label}`;
              const movable = row.account !== GOAL_SURPLUS && `${row.month}-${row.account}` !== startKey && months.length > 1;
              return (
                <tr key={`${row.month}-${row.account}`} className={cn(row.locked && "bg-accent-muted/30")}>
                  <td className="px-3 py-1.5 text-xs tabular-nums">
                    {movable
                      ? <select aria-label={`Monat ${account.label}`} value={row.month} onChange={(event) => onMove(row, event.target.value)}
                        className="select-input h-9 w-full min-w-0 px-2 text-xs whitespace-nowrap">
                        {[...new Set([...months, row.month])].sort().map((month) => <option key={month} value={month}>{monthLabel(month, true)}</option>)}
                      </select>
                      : first ? monthLabel(row.month, true) : ""}
                    <span className="mt-1 flex max-w-full items-center gap-1.5 text-2xs text-muted-foreground sm:hidden">
                      {account.bank && <BankLogo bank={account.bank} size="xs" />}
                      <span className="truncate">{account.label}</span>
                      {row.locked && <Lock aria-label="fixiert" className="size-3 shrink-0 text-primary" />}
                    </span>
                  </td>
                  <td className="hidden truncate px-2 py-1.5 text-xs sm:table-cell">
                    <span className="inline-flex max-w-full items-center gap-1.5">
                      {account.bank && <BankLogo bank={account.bank} size="xs" />}
                      <span className="truncate">{account.label}</span>
                      {row.locked && <Lock aria-label="fixiert" className="size-3 shrink-0 text-primary" />}
                    </span>
                  </td>
                  <td className="px-1 py-1">
                    <AmountCell key={`${row.month}-${row.account}-${row.amount}`} amount={row.amount} label={`Betrag ${label}`} onCommit={(amount) => onAmount(row, amount)} />
                  </td>
                  <td className="py-1 pr-1">
                    {row.locked
                      ? <Button type="button" size="icon" variant="ghost" className="size-9" aria-label={`${label} zurücksetzen`} onClick={() => onReset(row)}><RotateCcw aria-hidden="true" /></Button>
                      : <Button type="button" size="icon" variant="ghost" className="size-9 text-muted-foreground" aria-label={`${monthLabel(row.month)} ausschließen`} onClick={() => onExclude(row.month)}><Ban aria-hidden="true" /></Button>}
                  </td>
                </tr>
              );
            })}
            {!visible.length && (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-xs text-muted-foreground">Keine Einzahlungen geplant – ein Konto auswählen oder Monate wieder aufnehmen.</td></tr>
            )}
          </tbody>
          <tfoot className="border-t border-border/70 bg-muted/20">
            <tr>
              <th scope="row" className="px-3 py-2 text-left text-xs font-medium sm:hidden">Summe{plan.continuation ? " im Planungszeitraum" : ""}</th>
              <th scope="row" colSpan={2} className="hidden px-3 py-2 text-left text-xs font-medium sm:table-cell">Summe{plan.continuation ? " im Planungszeitraum" : ""}</th>
              <td className="px-2 py-2 text-right text-sm font-semibold tabular-nums">
                <FinancialData as="span">{currency(round(plan.rows.reduce((sum, row) => sum + row.amount, 0)))}</FinancialData>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <InterestHint rows={plan.rows.filter((row) => labels[row.account]?.bank === "Trade Republic")} rate={rate} endMonth={endMonth} />
      {plan.continuation && (
        <p className="text-xs text-muted-foreground">
          Danach <FinancialData as="span" className="font-medium tabular-nums">{currency(plan.continuation.monthly)}</FinancialData> pro Monat
          {plan.continuation.from === plan.continuation.to ? ` im ${monthLabel(plan.continuation.from)}` : ` von ${monthLabel(plan.continuation.from, true)} bis ${monthLabel(plan.continuation.to, true)}`} als laufende Rate.
        </p>
      )}
      {excludedMonths.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Ausgeschlossen:</span>
          {[...excludedMonths].sort().map((month) => (
            <button key={month} type="button" onClick={() => onInclude(month)} aria-label={`${monthLabel(month)} wieder einplanen`}
              className="inline-flex min-h-8 items-center gap-1 rounded-full border border-border px-2.5 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {monthLabel(month, true)}<RotateCcw aria-hidden="true" className="size-3 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Beträge überschreiben fixiert die Zeile; der Rest wird neu verteilt. Überwiesen wird nichts automatisch.</p>
    </div>
  );
}

function InterestHint({ rows, rate, endMonth }: { rows: GoalPlanRow[]; rate?: number; endMonth?: string }) {
  if (!rows.length || !endMonth) return null;
  const lost = round(rows.reduce((sum, row) => sum + forgoneInterest(row.amount, rate, row.month, endMonth), 0));
  const month = rows.map((row) => row.month).sort()[0];
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <BankLogo bank="Trade Republic" size="xs" />
      {lost >= 0.5
        ? <span>Umbuchung von Trade Republic im {monthLabel(month)}: ca. <FinancialData as="span" className="font-medium tabular-nums">{currency(lost)}</FinancialData> weniger Zinsen als zum Zieltermin.</span>
        : <span>Trade Republic wird erst im {monthLabel(month)} gebraucht – bis dahin laufen die Zinsen weiter.</span>}
    </p>
  );
}

function AmountCell({ amount, label, onCommit }: { amount: number; label: string; onCommit: (amount: number) => void }) {
  const [text, setText] = useState(() => moneyText(amount));
  function commit() {
    const value = moneyValue(text);
    if (value === null || value < 0 || value > 1_000_000) { setText(moneyText(amount)); return; }
    if (round(value) !== amount) onCommit(round(value)); else setText(moneyText(amount));
  }
  return (
    <Input aria-label={label} inputMode="decimal" autoComplete="off" value={text} className="h-9 w-full px-2 text-right tabular-nums"
      onChange={(event) => setText(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />
  );
}

function GoalOverview({ name, target, saved, plan, date, asap, monthly, months, excludedMonths, exceptionAccount }: {
  name: string; target: number; saved: number; plan: PlanResult | null; date?: string; asap: boolean; monthly: number | null;
  months: string[]; excludedMonths: string[]; exceptionAccount?: string;
}) {
  const transfers = plan ? round(plan.rows.filter((row) => row.account !== GOAL_SURPLUS && row.account !== exceptionAccount).reduce((sum, row) => sum + row.amount, 0)) : 0;
  const exceptional = plan && exceptionAccount ? round(plan.rows.filter((row) => row.account === exceptionAccount).reduce((sum, row) => sum + row.amount, 0)) : 0;
  const rates = plan ? round(plan.rows.filter((row) => row.account === GOAL_SURPLUS).reduce((sum, row) => sum + row.amount, 0)) : 0;
  const later = plan?.continuation ? round(plan.continuation.monthly * (monthsBetween(plan.continuation.from, plan.continuation.to) + 1)) : 0;
  const scale = Math.max(target, saved + transfers + exceptional + rates + later, 1);
  const parts = [
    { label: "Vorhanden", value: saved, className: "bg-primary" },
    { label: "Umbuchungen", value: transfers, className: "bg-chart-2" },
    { label: "Trade Republic", value: exceptional, className: "bg-chart-4" },
    { label: "Monatsraten", value: rates, className: "bg-primary/45" },
    { label: "Danach", value: later, className: "bg-primary/20" },
  ].filter((part) => part.value > 0);
  const byMonth = plan ? [...new Set([...months, ...plan.rows.map((row) => row.month)])].sort().map((month) => ({
    month,
    surplus: plan.rows.filter((row) => row.month === month && row.account === GOAL_SURPLUS).reduce((sum, row) => sum + row.amount, 0),
    pockets: plan.rows.filter((row) => row.month === month && row.account !== GOAL_SURPLUS && row.account !== exceptionAccount).reduce((sum, row) => sum + row.amount, 0),
    exception: plan.rows.filter((row) => row.month === month && row.account === exceptionAccount).reduce((sum, row) => sum + row.amount, 0),
  })) : [];
  const peak = Math.max(1, ...byMonth.map((entry) => entry.surplus + entry.pockets + entry.exception));
  const funded = byMonth.filter((entry) => entry.surplus > 0);
  const covered = round(saved + transfers + exceptional + rates + later);
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold">{name}</h3>
          <FinancialData as="p" className="text-sm text-muted-foreground"><span className="font-semibold text-foreground tabular-nums">{currency(Math.min(covered, target))}</span> von {currency(target)}</FinancialData>
        </div>
        <div role="img" aria-label={`${currency(Math.min(covered, target))} von ${currency(target)} vorhanden oder geplant`}
          className="flex h-3 overflow-hidden rounded-full bg-muted">
          {parts.map((part) => <span key={part.label} className={cn("h-full first:rounded-l-full", part.className)} style={{ width: `${part.value / scale * 100}%` }} />)}
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
          {parts.map((part) => (
            <li key={part.label} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={cn("size-2 rounded-full", part.className)} />{part.label} <FinancialData as="span" className="tabular-nums">{currency(part.value)}</FinancialData>
            </li>
          ))}
        </ul>
      </div>
      {byMonth.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">Geplante Einzahlungen</h4>
          <div aria-hidden="true" className="flex h-28 items-end gap-1 rounded-2xl border border-border/70 px-3 pt-3 pb-2">
            {byMonth.map((entry) => {
              const amount = entry.surplus + entry.pockets + entry.exception;
              return (
                <div key={entry.month} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                  {amount > 0 ? (
                    <div className="flex w-full max-w-6 flex-col justify-end overflow-hidden rounded-t-md" style={{ height: `${Math.max(4, amount / peak * 100)}%` }}>
                      {entry.exception > 0 && <span className="w-full bg-chart-4" style={{ height: `${entry.exception / amount * 100}%` }} />}
                      {entry.pockets > 0 && <span className="w-full bg-chart-2" style={{ height: `${entry.pockets / amount * 100}%` }} />}
                      {entry.surplus > 0 && <span className="w-full flex-1 bg-primary/70" />}
                    </div>
                  ) : (
                    <span className={cn("h-0.5 w-full max-w-6 rounded-full", excludedMonths.includes(entry.month) ? "bg-warning/50" : "bg-border")} />
                  )}
                  <span className="text-2xs leading-none text-muted-foreground">{monthLabel(entry.month, true).slice(0, byMonth.length > 9 ? 1 : 3)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-xl bg-muted/40 px-4 py-3">
          <dt className="text-2xs text-muted-foreground">{asap ? "Erreicht voraussichtlich" : "Zieldatum"}</dt>
          <dd className="font-semibold">{date ? dateLabel(date) : "–"}</dd>
        </div>
        {plan && !asap && (
          <div className="rounded-xl bg-muted/40 px-4 py-3">
            <dt className="text-2xs text-muted-foreground">Laut Plan erreicht</dt>
            <dd className="font-semibold">{plan.reached ? monthLabel(plan.reached) : "noch nicht"}</dd>
          </div>
        )}
        <div className="rounded-xl bg-muted/40 px-4 py-3">
          <dt className="text-2xs text-muted-foreground">Monatlich vom Girokonto</dt>
          <dd className="font-semibold tabular-nums"><FinancialData as="span">
            {plan ? funded.length ? `Ø ${currency(round(rates / funded.length))}` : "–"
              : monthly !== null ? currency(monthly) : "nach Termin aus dem Überschuss"}
          </FinancialData></dd>
        </div>
      </dl>
      {plan && plan.missing > 0 && (
        <p className="flex gap-2 text-xs text-muted-foreground"><TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
          Es fehlen noch {currency(plan.missing)}. Du kannst trotzdem speichern und später anpassen.</p>
      )}
    </div>
  );
}

const monthsBetween = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
