"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, CalendarClock, Check, CircleHelp, MessageSquareText, Pencil, PiggyBank, Send, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { PageHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { lastDay, mergeDraft, missingQuestion, parseAssistantMessage } from "@/lib/assistant/intent";
import { buildPlannedOneOff, buildSavingsGoal, checkAffordability, planSavingsGoal, type Affordability } from "@/lib/assistant/plan";
import type { Dashboard } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { preserveGoalOpeningBalances, savingsGoals } from "@/lib/goals";
import { assistantDraftSchema, MAX_ASSISTANT_MESSAGES, type AppState, type AssistantDraft, type AssistantMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

const examples = [
  "Ich will bis Juli 2027 3.000 € für Japan sparen, 500 € liegen schon am Sparkonto.",
  "Im März kommt das Pickerl, ca. 400 €.",
  "Laptop 1.200 € in 6 Raten ab Jänner.",
  "Kann ich mir im Mai einen Fernseher um 900 € leisten?",
  "Was wäre, wenn ich 200 € im Monat für ein Auto um 6.000 € spare?",
];
const intro = "Erzähl mir von einem Sparziel, einer geplanten Ausgabe oder frag, ob du dir etwas leisten kannst. " +
  "Ich rechne mit deinem Monatsplan und speichere erst, wenn du auf „Anlegen“ klickst.";
const lights = {
  green: { label: "Geht sich aus", dot: "🟢", tone: "border-emerald-500/40 bg-emerald-500/5" },
  yellow: { label: "Knapp", dot: "🟡", tone: "border-amber-500/40 bg-amber-500/5" },
  red: { label: "Geht sich nicht aus", dot: "🔴", tone: "border-red-500/40 bg-red-500/5" },
  unknown: { label: "Nicht prüfbar", dot: "⚪", tone: "border-border/70" },
} as const;
const monthOf = (date: string) => monthLabel(date.slice(0, 7));
const listMonths = (months: string[]) => {
  const names = months.slice(0, 4).map((month) => monthLabel(month));
  const text = names.length > 1 ? `${names.slice(0, -1).join(", ")} und ${names.at(-1)}` : names[0];
  return `Im ${text}${months.length > 4 ? ` und ${months.length - 4} weiteren Monaten` : ""}`;
};
const newId = () => crypto.randomUUID();

function previewText(draft: AssistantDraft) {
  const prefix = draft.whatIf ? "Was-wäre-wenn, nichts wird gespeichert. " : "";
  if (draft.action === "savings_goal") return `${prefix}So würde das Sparziel aussehen:`;
  if (draft.action === "expense") return `${prefix}So würde ich die Ausgabe einplanen:`;
  return `${prefix}Ich habe das mit deinem Monatsplan durchgerechnet:`;
}

function affordabilityText(result: Affordability) {
  const month = result.tightest ? monthOf(`${result.tightest.month}-01`) : "";
  if (result.error) return result.error;
  if (result.light === "green") return `Geht, danach bleiben dir im ${month} noch ${currency(result.tightest!.after)} über den Sparsockel hinaus.`;
  if (result.light === "yellow") {
    const goals = [...new Set(result.pause.map((item) => item.name))].join(" und ");
    return `Geht nur, wenn du die Rate für ${goals} im ${month} aussetzt oder kürzt.`;
  }
  return `Im ${month} fehlen ${currency(result.shortfall)}.`;
}

export function FinanceAssistant() {
  const { state, dashboard, update, storageError } = useFinance();
  const messages = state.assistantChat ?? [];
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string>();
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length]);

  const save = (change: (items: AssistantMessage[]) => AssistantMessage[], also?: (current: AppState) => AppState) =>
    update((current) => {
      const next = also ? also(current) : current;
      return { ...next, assistantChat: change(current.assistantChat ?? []).slice(-MAX_ASSISTANT_MESSAGES) };
    });
  const setMessage = (id: string, patch: Partial<AssistantMessage>, reply?: string, also?: (current: AppState) => AppState) =>
    save((items) => [...items.map((item) => item.id === id ? { ...item, ...patch } : item),
      ...(reply ? [{ id: newId(), role: "assistant" as const, text: reply, at: Date.now() }] : [])], also);
  const addDraftMessage = (draft: AssistantDraft, source: AssistantMessage["source"] = "Regel") => {
    const question = missingQuestion(draft);
    save((items) => [...items.map((item) => item.status === "question" || item.status === "preview" ? { ...item, status: "dismissed" as const } : item),
      { id: newId(), role: "assistant", text: question ?? previewText(draft), at: Date.now(), draft, status: question ? "question" : "preview", source }]);
  };

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim().slice(0, 1000);
    if (!text || busy || storageError) return;
    const pending = [...messages].reverse().find((item) => item.role === "assistant" && (item.status === "question" || item.status === "preview"))?.draft;
    const asOf = state.settings.asOf;
    const history = messages.slice(-6).map((item) => ({ role: item.role, text: item.text.slice(0, 500) }));
    setInput("");
    setBusy(true);
    save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
    let reply: { draft?: AssistantDraft; question?: string; source: "KI" | "Regel" };
    try {
      const response = await fetch("/api/ai/assistant", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ message: text, asOf, ...(pending ? { pending } : {}), history }),
      });
      if (!response.ok) throw new Error();
      reply = await response.json();
    } catch {
      // Same rules as the server, without the model.
      const draft = mergeDraft(pending, parseAssistantMessage(text, asOf), {}, text, asOf);
      reply = { draft, question: draft ? missingQuestion(draft) : undefined, source: "Regel" };
    }
    const parsed = reply.draft ? assistantDraftSchema.safeParse(reply.draft) : undefined;
    if (parsed?.success) addDraftMessage(parsed.data, reply.source);
    else save((items) => [...items, { id: newId(), role: "assistant", at: Date.now(),
      text: "Das habe ich nicht verstanden. Sag mir zum Beispiel, wofür du sparen willst, was du kaufen möchtest und wann, oder frag: „Kann ich mir im Mai 900 € für einen Fernseher leisten?“" }]);
    setBusy(false);
    inputRef.current?.focus();
  }

  function createGoal(message: AssistantMessage) {
    const draft = message.draft!;
    const plan = planSavingsGoal(state, dashboard, draft);
    if (!plan.ok) { toast.error(plan.error); return; }
    const goal = buildSavingsGoal(state, { ...draft, date: plan.date }, plan.monthly);
    setMessage(message.id, { status: "created" }, `Das Sparziel „${goal.name}“ ist angelegt: ${currency(goal.target)} bis ${dateLabel(goal.date)}, ${currency(plan.monthly)} pro Monat.`,
      (current) => ({ ...preserveGoalOpeningBalances(current), savingsGoals: [...savingsGoals(current), goal] }));
    toast.success("Sparziel angelegt");
  }
  function createExpense(message: AssistantMessage) {
    const draft = message.draft!;
    if (!draft.amount || !draft.date) return;
    const item = buildPlannedOneOff(draft);
    setMessage(message.id, { status: "created" }, `„${item.name}“ ist als geplante Ausgabe im ${monthOf(item.date)} eingetragen.`,
      (current) => ({ ...current, plannedOneOffs: [...(current.plannedOneOffs ?? []), item] }));
    toast.success("Geplante Ausgabe angelegt");
  }

  return <div className="mx-auto flex max-w-4xl flex-col">
    <PageHeading eyebrow="KI-Assistent · lokal auf der NPU" title="Finanz-Assistent" description="Sparziele anlegen, Ausgaben planen und prüfen, ob es sich ausgeht.">
      {messages.length > 0 && <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => {
        if (window.confirm("Den gesamten Chatverlauf löschen? Angelegte Ziele und Ausgaben bleiben erhalten.")) update((current) => ({ ...current, assistantChat: [] }));
      }}><Trash2 aria-hidden="true" className="size-4" />Verlauf löschen</Button>}
    </PageHeading>
    <section className="panel flex min-h-[60vh] flex-col p-4 sm:p-6" aria-label="Chat mit dem Finanz-Assistenten">
      <FinancialData className="flex flex-1 flex-col gap-4" aria-live="polite">
        <Bubble role="assistant" text={intro} />
        {!messages.length && <div className="flex flex-wrap gap-2 pl-11">
          {examples.map((example) => <button key={example} type="button" onClick={() => { setInput(example); inputRef.current?.focus(); }}
            className="rounded-full border border-border/70 bg-background/40 px-3 py-1.5 text-left text-xs text-muted-foreground transition hover:border-primary/50 hover:text-foreground">{example}</button>)}
        </div>}
        {messages.map((message) => <div key={message.id} className="flex flex-col gap-2">
          <Bubble role={message.role} text={message.text} source={message.source} faded={message.status === "dismissed"} />
          {message.draft && message.status !== "question" && <div className="pl-11">
            {editing === message.id
              ? <DraftEditor draft={message.draft} onCancel={() => setEditing(undefined)} onSave={(draft) => {
                setEditing(undefined);
                const question = missingQuestion(draft);
                setMessage(message.id, { draft, status: question ? "question" : "preview", text: question ?? previewText(draft) });
              }} />
              : <DraftCard message={message} state={state} dashboard={dashboard} disabled={!!storageError}
                onEdit={() => setEditing(message.id)}
                onDismiss={() => setMessage(message.id, { status: "dismissed" }, "Alles klar, ich habe nichts gespeichert.")}
                onCreateGoal={() => createGoal(message)} onCreateExpense={() => createExpense(message)}
                onVariant={(draft) => addDraftMessage(draft)} />}
          </div>}
        </div>)}
        {busy && <Bubble role="assistant" text="Ich rechne …" />}
        <div ref={endRef} />
      </FinancialData>
      <form onSubmit={send} className="mt-5 flex items-end gap-2 border-t border-border/60 pt-4">
        <Label htmlFor="assistant-input" className="sr-only">Nachricht an den Finanz-Assistenten</Label>
        <textarea id="assistant-input" ref={inputRef} value={input} rows={2} maxLength={1000} disabled={busy}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
          placeholder="z. B. „Ich will bis Juli 2027 3.000 € für Japan sparen“"
          className="min-h-11 flex-1 resize-none rounded-xl border border-input bg-background/60 px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button type="submit" className="min-h-11" disabled={busy || !input.trim() || !!storageError}><Send aria-hidden="true" className="size-4" />Senden</Button>
      </form>
      <p className="mt-2 text-2xs text-muted-foreground">Die KI liest nur deine Angaben heraus. Alle Beträge rechnet der Monatsplan. Der Verlauf bleibt in deiner lokalen Datenbank.</p>
    </section>
  </div>;
}

function Bubble({ role, text, source, faded }: { role: "user" | "assistant"; text: string; source?: "KI" | "Regel"; faded?: boolean }) {
  const mine = role === "user";
  return <div className={cn("flex items-start gap-3", mine && "flex-row-reverse", faded && "opacity-60")}>
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl", mine ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}>
      {mine ? <MessageSquareText aria-hidden="true" className="size-4" /> : <Bot aria-hidden="true" className="size-4" />}
    </span>
    <div className={cn("max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed", mine ? "bg-primary text-primary-foreground" : "bg-muted/50")}>
      <span className="sr-only">{mine ? "Du: " : "Assistent: "}</span>{text}
      {source === "KI" && <span className="ml-2 inline-flex items-center gap-1 text-2xs text-muted-foreground"><Sparkles aria-hidden="true" className="size-3" />KI</span>}
    </div>
  </div>;
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className="flex justify-between gap-4 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className={cn("tabular-nums", strong && "font-semibold text-primary")}>{value}</dd></div>;
}

type CardProps = {
  message: AssistantMessage; state: AppState; dashboard: Dashboard; disabled: boolean;
  onEdit: () => void; onDismiss: () => void; onCreateGoal: () => void; onCreateExpense: () => void; onVariant: (draft: AssistantDraft) => void;
};

function DraftCard({ message, state, dashboard, disabled, onEdit, onDismiss, onCreateGoal, onCreateExpense, onVariant }: CardProps) {
  const draft = message.draft!;
  const open = message.status === "preview";
  const actions = (create?: { label: string; run: () => void }) => open && <div className="mt-4 flex flex-wrap gap-2">
    {create && <Button type="button" size="sm" className="min-h-10" disabled={disabled} onClick={create.run}><Check aria-hidden="true" className="size-4" />{create.label}</Button>}
    <Button type="button" size="sm" variant="outline" className="min-h-10" onClick={onEdit}><Pencil aria-hidden="true" className="size-4" />Ändern</Button>
    <Button type="button" size="sm" variant="ghost" className="min-h-10" onClick={onDismiss}><X aria-hidden="true" className="size-4" />Verwerfen</Button>
  </div>;
  const badge = draft.whatIf && <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-2xs text-muted-foreground"><CircleHelp aria-hidden="true" className="size-3" />Was-wäre-wenn · nichts gespeichert</p>;
  const shell = "rounded-2xl border bg-background/40 p-4";
  if (message.status === "created") return <p className="inline-flex items-center gap-1.5 text-xs text-primary"><Check aria-hidden="true" className="size-3.5" />Angelegt</p>;
  if (message.status === "dismissed") return null;

  if (draft.action === "savings_goal") {
    const plan = planSavingsGoal(state, dashboard, draft);
    return <article className={cn(shell, "border-border/70")} aria-label={`Vorschau Sparziel ${plan.name}`}>
      {badge}
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><PiggyBank aria-hidden="true" className="size-4 text-primary" />Sparziel {plan.name}</h3>
      {plan.error ? <p className="text-sm text-destructive">{plan.error}</p> : <>
        <dl className="space-y-1.5">
          <Row label="Ziel" value={currency(plan.target)} />
          <Row label="Bis" value={dateLabel(plan.date)} />
          {plan.start > 0 && <Row label={`Startkapital${draft.fromAccount ? ` (${draft.fromAccount})` : ""}`} value={currency(plan.start)} />}
          <Row label={`Monatsrate · ${plan.months} ${plan.months === 1 ? "Monat" : "Monate"}`} value={`${currency(plan.monthly)} / Monat`} strong />
        </dl>
        {plan.offered && plan.reachableWithOffered && <div className="mt-3 rounded-xl bg-muted/40 p-3 text-xs">
          Mit {currency(plan.offered)} im Monat erreichst du das Ziel erst bis {dateLabel(plan.reachableWithOffered)}.
          {open && <Button type="button" size="sm" variant="link" className="h-auto p-0 pl-1 text-xs"
            onClick={() => onVariant({ ...draft, date: plan.reachableWithOffered })}>Datum übernehmen</Button>}
        </div>}
        {plan.conflicts.length > 0 && <ul className="mt-3 space-y-1 text-xs text-amber-700 dark:text-amber-400">
          {plan.conflicts.map((item) => <li key={item.goalId}>⚠ {item.name} bekommt dadurch bis {dateLabel(item.date)} {currency(item.loss)} weniger
            {item.late ? " und wird nicht mehr rechtzeitig fertig." : ", schafft es aber noch."}</li>)}
        </ul>}
        {plan.fundedInPlan + 0.5 < plan.planned && plan.checkedUntil >= plan.date.slice(0, 7) && <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
          ⚠ {plan.shortMonths.length > 0 && `${listMonths(plan.shortMonths)} reicht der Überschuss nicht für die volle Rate. `}
          Laut Monatsplan kommen bis {dateLabel(plan.date)} nur {currency(plan.fundedInPlan)} von {currency(plan.planned)} zusammen.</p>}
        {plan.warnings.map((warning) => <p key={warning} className="mt-2 text-xs text-muted-foreground">{warning}</p>)}
      </>}
      {actions(plan.ok ? { label: draft.whatIf ? "Doch anlegen" : "Anlegen", run: onCreateGoal } : undefined)}
    </article>;
  }

  const check = draft.amount && draft.date ? checkAffordability(state, dashboard, draft) : undefined;
  const light = lights[check?.light ?? "unknown"];
  const installments = draft.installments ?? 1;
  const item = draft.amount && draft.date ? buildPlannedOneOff(draft, "preview") : undefined;
  return <article className={cn(shell, light.tone)} aria-label={draft.action === "expense" ? "Vorschau geplante Ausgabe" : "Leistbarkeit"}>
    {badge}
    <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><CalendarClock aria-hidden="true" className="size-4 text-primary" />{draft.name ?? (draft.action === "expense" ? "Geplante Ausgabe" : "Ausgabe")}</h3>
    {item && <dl className="space-y-1.5">
      <Row label="Betrag" value={currency(draft.amount!)} />
      <Row label={installments > 1 ? "Erste Rate" : "Fällig"} value={monthOf(item.date)} />
      {installments > 1 && <Row label="Raten" value={`${installments} × ${currency(item.amount)}`} />}
      {draft.shared && <Row label="Geteilt mit Raphael" value="ja, du zahlst die Hälfte" />}
      <Row label="Konto" value={item.pocket} />
    </dl>}
    {check && <div className="mt-3 rounded-xl bg-background/60 p-3 text-sm" role="status">
      <p className="font-medium">{light.dot} {light.label}</p>
      <p className="mt-1 text-muted-foreground">{affordabilityText(check)}</p>
      {check.light === "red" && check.alternatives.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Möglich wäre:</p>}
      {check.light !== "green" && check.alternatives.length > 0 && open && <div className="mt-2 flex flex-wrap gap-2">
        {check.alternatives.map((option) => option.kind === "installments"
          ? <Button key="installments" type="button" size="sm" variant="outline" onClick={() => onVariant({ ...draft, installments: option.installments })}>{option.installments} Raten à {currency(option.rate!)}</Button>
          : option.kind === "later"
            ? <Button key="later" type="button" size="sm" variant="outline" onClick={() => onVariant({ ...draft, date: `${option.month}-01` })}>Im {monthOf(`${option.month}-01`)} statt</Button>
            : <span key="reserve" className="self-center text-xs text-muted-foreground">oder aus dem Sparkonto ({currency(option.balance!)} verfügbar)</span>)}
      </div>}
    </div>}
    {actions(item && !draft.whatIf
      ? { label: draft.action === "expense" ? "Anlegen" : "Als geplante Ausgabe anlegen", run: onCreateExpense }
      : item ? { label: "Doch als Ausgabe anlegen", run: onCreateExpense } : undefined)}
  </article>;
}

function DraftEditor({ draft, onSave, onCancel }: { draft: AssistantDraft; onSave: (draft: AssistantDraft) => void; onCancel: () => void }) {
  const [error, setError] = useState("");
  const goal = draft.action === "savings_goal";
  return <form className="space-y-3 rounded-2xl border border-border/70 bg-background/40 p-4" onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const read = (key: string) => String(form.get(key) ?? "").trim();
    const money = (key: string) => read(key) ? Number(read(key).replace(/\./g, "").replace(",", ".")) : undefined;
    const month = read("month");
    const candidate = {
      action: draft.action, name: read("name") || undefined, amount: money("amount"),
      date: month ? (goal ? `${month}-${lastDay(month)}` : `${month}-01`) : undefined,
      ...(goal ? { monthly: money("monthly"), startCapital: money("startCapital"), fromAccount: read("fromAccount") || undefined }
        : { installments: read("installments") ? Number(read("installments")) : undefined, shared: form.get("shared") === "on" || undefined,
          fromAccount: read("fromAccount") || undefined }),
      ...(draft.whatIf ? { whatIf: true } : {}),
    };
    const parsed = assistantDraftSchema.safeParse(Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined)));
    if (!parsed.success) { setError("Bitte die Angaben prüfen: Beträge größer als 0, Raten zwischen 1 und 120."); return; }
    onSave(parsed.data);
  }}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field name="name" label="Name" value={draft.name} />
      <Field name="amount" label={goal ? "Zielbetrag (€)" : "Betrag gesamt (€)"} value={draft.amount} inputMode="decimal" />
      <Field name="month" label={goal ? "Bis (Monat)" : "Fällig (Monat)"} value={draft.date?.slice(0, 7)} type="month" />
      {goal ? <>
        <Field name="monthly" label="Oder: monatlich (€)" value={draft.monthly} inputMode="decimal" />
        <Field name="startCapital" label="Startkapital (€)" value={draft.startCapital} inputMode="decimal" />
        <Field name="fromAccount" label="Startkapital von Konto" value={draft.fromAccount} />
      </> : <>
        <Field name="installments" label="Raten" value={draft.installments ?? 1} inputMode="numeric" />
        <Field name="fromAccount" label="Konto (Giro oder Sparkonto)" value={draft.fromAccount} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="shared" defaultChecked={draft.shared} className="size-4" />Mit Raphael geteilt</label>
      </>}
    </div>
    {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    <div className="flex gap-2">
      <Button type="submit" size="sm"><Check aria-hidden="true" className="size-4" />Übernehmen</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Abbrechen</Button>
    </div>
  </form>;
}

function Field({ name, label, value, type = "text", inputMode }: { name: string; label: string; value?: string | number; type?: string; inputMode?: "decimal" | "numeric" }) {
  const id = `assistant-${name}`;
  return <div className="space-y-1.5">
    <Label htmlFor={id} className="text-xs">{label}</Label>
    <Input id={id} name={name} type={type} inputMode={inputMode} defaultValue={value === undefined ? "" : typeof value === "number" ? String(value).replace(".", ",") : value} />
  </div>;
}
