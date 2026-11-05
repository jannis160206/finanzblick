"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Brain, Bot, CalendarClock, Check, CircleHelp, Columns2, History, MessageSquareText, Pencil, PiggyBank, Send, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { ChangeCard, ChangesPanel, FreeChart, MemoryPanel, ResultCard } from "@/components/assistant-cards";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { HomeOfficeCard } from "@/components/homeoffice-card";
import { PageHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeTool, memoryValue, type AgentHints, type AgentResult } from "@/lib/assistant/agent";
import { weeklyBriefing } from "@/lib/assistant/answers";
import { lastDay, mergeDraft, missingQuestion, parseAssistantMessage } from "@/lib/assistant/intent";
import { applyOperations, OperationError, recordChange, recordCreation, undoChange } from "@/lib/assistant/operations";
import { buildPlannedOneOff, buildSavingsGoal, checkAffordability, goalExtraOperation, monthBasis, planningHorizon, planSavingsGoal, type Affordability } from "@/lib/assistant/plan";
import { detectTool, isAssistantTool, isDraftTool, type AssistantTool } from "@/lib/assistant/tools";
import { addMonths, type Dashboard } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { preserveGoalOpeningBalances, savingsGoals } from "@/lib/goals";
import { plannedOccurrences } from "@/lib/planned-one-offs";
import {
  appStateSchema, assistantDraftSchema, assistantMessageSchema, extraSourceSchema, MAX_ASSISTANT_MESSAGES,
  type AppState, type AssistantDraft, type AssistantMessage, type AssistantOperation,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const examples = [
  "Wie viel hab ich im Oktober fürs Essen ausgegeben?",
  "Ich will bis Juli 2027 3.000 € für Japan sparen, 500 € liegen schon am Sparkonto.",
  "Kann ich mir im Mai einen Fernseher um 900 € leisten?",
  "Erhöhe Japan auf 4.000 €",
  "Ich will 200 € mehr im Monat sparen.",
  "Lieferando ist immer Lieferdienste",
  "Merk dir: Puffer immer 500 €",
  "100 € im Monat in einen ETF, was habe ich nach 10 Jahren?",
  "Was kann ich bei der Arbeitnehmerveranlagung absetzen?",
  "Was bekomme ich für meine Home-Office-Sachen beim Steuerausgleich zurück?",
  "Ich will bis Dezember 2027 2.000 € für ein Auto sparen, die ersten 2 Monate je 60 € vom Sparkonto.",
  "Nimm für Japan die nächsten 3 Monate je 50 € extra aus dem Notgroschen.",
  "Was kann ich im Dashboard alles einstellen?",
  "Wie funktionieren die Sparziele?",
];
const extraSources: string[] = [...extraSourceSchema.options];
const intro = "Frag mich zu deinen Ausgaben, plane Sparziele und Ausgaben, ändere Bestehendes oder lass dir beim Sparen helfen. " +
  "Alle Beträge rechnet der Code nach. Geändert wird erst, wenn du bestätigst, und jede Änderung lässt sich rückgängig machen.";
const sameDay = (at: number, now: number) => new Date(at).toDateString() === new Date(now).toDateString();
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
const timestamp = () => Date.now();

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

const errorText = (error: unknown) => error instanceof OperationError ? error.message : "Das konnte ich nicht speichern. Bitte versuch es noch einmal.";
const monthDiff = (from: string, to: string) => {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + tm - fm;
};
const monthEnd = (month: string) => `${month}-${String(lastDay(month)).padStart(2, "0")}`;

export function FinanceAssistant() {
  const { state, dashboard, update, storageError, ready } = useFinance();
  const messages = state.assistantChat ?? [];
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [panel, setPanel] = useState<"changes" | "memory">();
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const briefed = useRef(false);
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
    save((items) => [...items.map((item) => item.draft && (item.status === "question" || item.status === "preview") ? { ...item, status: "dismissed" as const } : item),
      { id: newId(), role: "assistant", text: question ?? previewText(draft), at: Date.now(), draft, status: question ? "question" : "preview", source }]);
  };
  const addResult = (result: AgentResult, source: AssistantMessage["source"]) => {
    const message = {
      id: newId(), role: "assistant" as const, text: result.text.slice(0, 2000), at: Date.now(), source,
      ...(result.card ? { card: result.card } : {}), ...(result.change ? { change: result.change } : {}),
      ...(result.undoId ? { undoId: result.undoId } : {}), ...(result.change || result.undoId ? { status: "preview" as const } : {}),
    };
    const parsed = assistantMessageSchema.safeParse(message);
    save((items) => [...items, parsed.success ? parsed.data : { id: message.id, role: "assistant", text: message.text, at: message.at }]);
  };

  // Checks the change against the current snapshot first, so the provider never receives an invalid state.
  const commit = (run: (current: AppState) => AppState, chat?: (items: AssistantMessage[]) => AssistantMessage[]) => {
    try {
      if (!appStateSchema.safeParse(run(state)).success) throw new OperationError("Die Änderung passt nicht zu deinen Daten.");
    } catch (error) {
      toast.error(errorText(error));
      return false;
    }
    update((current) => {
      try {
        const next = run(current);
        return chat ? { ...next, assistantChat: chat(next.assistantChat ?? []).slice(-MAX_ASSISTANT_MESSAGES) } : next;
      } catch {
        return current;
      }
    });
    return true;
  };
  const markUndone = (logId: string) => (item: AssistantMessage): AssistantMessage =>
    item.change?.logId === logId || item.undoId === logId ? { ...item, status: "undone" } : item;

  function applyChange(message: AssistantMessage) {
    const change = message.change!;
    const logId = newId();
    const at = timestamp();
    if (commit((current) => recordChange(current, applyOperations(current, change.operations, { asOf: current.settings.asOf, now: at }), { id: logId, at, title: change.title }),
      (items) => items.map((item) => item.id === message.id ? { ...item, status: "applied", change: { ...change, logId } } : item))) toast.success("Übernommen");
  }
  function undo(logId: string) {
    const title = state.assistantChanges?.find((entry) => entry.id === logId)?.title ?? "Änderung";
    if (commit((current) => undoChange(current, logId), (items) => [...items.map(markUndone(logId)),
      { id: newId(), role: "assistant", text: `„${title}“ ist rückgängig gemacht.`.slice(0, 2000), at: Date.now() }])) toast.success("Rückgängig gemacht");
  }
  function forget(memoryId: string) {
    const entry = state.assistantMemory?.find((item) => item.id === memoryId);
    const operation: AssistantOperation = { op: "memory_delete", memoryId };
    const at = timestamp();
    if (commit((current) => recordChange(current, applyOperations(current, [operation], { now: at }), { id: newId(), at, title: `Vergessen: ${entry?.text ?? "Eintrag"}` }))) toast.success("Vergessen");
  }

  // Proactive start: one weekly overview per day, built only from your own data.
  useEffect(() => {
    if (briefed.current || !ready || storageError) return;
    briefed.current = true;
    const now = Date.now();
    if ((state.assistantChat ?? []).some((item) => item.card?.kind === "briefing" && sameDay(item.at, now))) return;
    try {
      addResult(weeklyBriefing(state, dashboard, state.settings.asOf, memoryValue(state, "salaryDay")), "Regel");
    } catch {
      // The overview is optional; the chat still works without it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, storageError]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim().slice(0, 1000);
    if (!text || busy || storageError) return;
    const pending = [...messages].reverse().find((item) => item.role === "assistant" && item.draft && (item.status === "question" || item.status === "preview"))?.draft;
    const asOf = state.settings.asOf;
    const history = messages.slice(-6).map((item) => ({ role: item.role, text: item.text.slice(0, 500) }));
    const goals = savingsGoals(state).filter((goal) => !goal.completedAt).map((goal) => goal.name.slice(0, 80)).slice(0, 50);
    const planned = [...new Set(plannedOccurrences(state.plannedOneOffs).filter((item) => item.date.slice(0, 7) >= dashboard.currentMonth)
      .map((item) => item.name.slice(0, 100)))].slice(0, 60);
    setInput("");
    setBusy(true);
    save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
    let reply: { tool?: unknown; hints?: AgentHints; draft?: AssistantDraft; question?: string; source: "KI" | "Regel" };
    try {
      const response = await fetch("/api/ai/assistant", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ message: text, asOf, ...(pending ? { pending } : {}), history, context: { goals, planned } }),
      });
      if (!response.ok) throw new Error();
      reply = await response.json();
    } catch {
      // Same rules as the server, without the model.
      const tool = detectTool(text, [...goals, ...planned]);
      if (tool && !isDraftTool(tool) && !(pending && tool === "help")) reply = { tool, source: "Regel" };
      else {
        const draft = mergeDraft(pending, parseAssistantMessage(text, asOf), {}, text, asOf);
        reply = { draft, question: draft ? missingQuestion(draft) : undefined, source: "Regel" };
      }
    }
    const tool: AssistantTool | undefined = isAssistantTool(reply.tool) && !isDraftTool(reply.tool) ? reply.tool : undefined;
    const parsed = !tool && reply.draft ? assistantDraftSchema.safeParse(reply.draft) : undefined;
    if (tool) {
      let result: AgentResult;
      try {
        result = executeTool(tool, text, { state, dashboard, asOf, hints: reply.hints });
      } catch {
        result = { text: "Dabei ist etwas schiefgegangen. Bitte formuliere es etwas anders." };
      }
      addResult(result, reply.source);
    } else if (parsed?.success) addDraftMessage(parsed.data, reply.source);
    else save((items) => [...items, { id: newId(), role: "assistant", at: Date.now(),
      text: "Das habe ich nicht verstanden. Frag mich zum Beispiel „Wie viel hab ich im Oktober fürs Essen ausgegeben?“, „Erhöhe Japan auf 4.000 €“ oder schreib „Hilfe“ für alles, was ich kann." }]);
    setBusy(false);
    inputRef.current?.focus();
  }

  function createGoal(message: AssistantMessage, draft: AssistantDraft) {
    const plan = planSavingsGoal(state, dashboard, draft);
    if (!plan.ok) { toast.error(plan.error); return; }
    const goal = buildSavingsGoal(state, { ...draft, date: plan.date }, plan.monthly);
    const extraOperation = goalExtraOperation(goal, draft, plan.firstMonth);
    const logId = newId();
    const summary = `${goal.name}: ${currency(goal.target)} bis ${dateLabel(goal.date)}, ${currency(plan.monthly)} / Monat` +
      (plan.extra ? `, dazu ${plan.extra.months} × ${currency(plan.extra.amount)}${plan.extra.from ? ` vom ${plan.extra.from}` : ""}` : "");
    let failed = "";
    if (commit((current) => {
      const next = { ...preserveGoalOpeningBalances(current), savingsGoals: [...savingsGoals(current), goal] };
      const created = recordCreation(current, next, { kind: "goal", itemId: goal.id, summary }, { id: logId, at: Date.now(), title: `Sparziel „${goal.name}“ angelegt` });
      if (!extraOperation) return created;
      try {
        // Goal and start extras form one change, so a single undo removes both.
        const applied = applyOperations(created, [extraOperation]);
        const log = created.assistantChanges!.at(-1)!;
        return { ...applied.state, assistantChanges: [...created.assistantChanges!.slice(0, -1),
          { ...log, summary: [...log.summary, ...applied.diffs.map((diff) => `${diff.label}: ${diff.before} → ${diff.after}`.slice(0, 300))].slice(0, 80),
            undo: { ...log.undo, ...(applied.undo.months ? { months: applied.undo.months } : {}) } }] };
      } catch (error) {
        failed = error instanceof Error ? error.message : "Die Extra-Beträge konnten nicht eingetragen werden.";
        return created;
      }
    }, (items) => [...items.map((item) => item.id === message.id ? { ...item, draft, status: "created" as const, undoId: logId } : item),
      { id: newId(), role: "assistant", text: `Das Sparziel „${goal.name}“ ist angelegt: ${currency(goal.target)} bis ${dateLabel(goal.date)}, ${currency(plan.monthly)} pro Monat` +
        (plan.extra ? `, dazu ${plan.extra.months === 1 ? "einmal" : `die ersten ${plan.extra.months} Monate je`} ${currency(plan.extra.amount)} extra${plan.extra.from ? ` vom ${plan.extra.from}` : ""}.` : "."), at: Date.now() }])) {
      toast.success("Sparziel angelegt");
      if (failed) toast.error(failed);
    }
  }
  function createExpense(message: AssistantMessage, draft: AssistantDraft) {
    if (!draft.amount || !draft.date) return;
    const item = buildPlannedOneOff(draft);
    const logId = newId();
    const summary = `${item.name}: ${currency(draft.amount)} ab ${monthOf(item.date)}${item.installments > 1 ? ` in ${item.installments} Raten` : ""}`;
    if (commit((current) => recordCreation(current, { ...current, plannedOneOffs: [...(current.plannedOneOffs ?? []), item] },
      { kind: "planned", itemId: item.id, summary }, { id: logId, at: Date.now(), title: `Geplante Ausgabe „${item.name}“ angelegt` }),
    (items) => [...items.map((entry) => entry.id === message.id ? { ...entry, draft, status: "created" as const, undoId: logId } : entry),
      { id: newId(), role: "assistant", text: `„${item.name}“ ist als geplante Ausgabe im ${monthOf(item.date)} eingetragen.`, at: Date.now() }]))
      toast.success("Geplante Ausgabe angelegt");
  }

  const changes = state.assistantChanges ?? [];
  const memory = state.assistantMemory ?? [];
  return <div className="mx-auto flex max-w-4xl flex-col">
    <PageHeading eyebrow="KI-Assistent · lokal auf der NPU" title="Finanz-Assistent"
      description="Fragen zu deinen Ausgaben, Sparziele und Ausgaben planen, Bestehendes ändern, Regeln, Spar-Coach, Depot-Rechner und Arbeitnehmerveranlagung.">
      <Button type="button" variant={panel === "memory" ? "secondary" : "outline"} size="sm" className="min-h-11" aria-pressed={panel === "memory"}
        onClick={() => setPanel(panel === "memory" ? undefined : "memory")}><Brain aria-hidden="true" className="size-4" />Gedächtnis{memory.length ? ` (${memory.length})` : ""}</Button>
      <Button type="button" variant={panel === "changes" ? "secondary" : "outline"} size="sm" className="min-h-11" aria-pressed={panel === "changes"}
        onClick={() => setPanel(panel === "changes" ? undefined : "changes")}><History aria-hidden="true" className="size-4" />Änderungen{changes.length ? ` (${changes.length})` : ""}</Button>
      {messages.length > 0 && <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => {
        if (window.confirm("Den gesamten Chatverlauf löschen? Angelegte Ziele, Ausgaben, das Gedächtnis und die Änderungsliste bleiben erhalten.")) update((current) => ({ ...current, assistantChat: [] }));
      }}><Trash2 aria-hidden="true" className="size-4" />Verlauf löschen</Button>}
    </PageHeading>
    {panel === "changes" && <ChangesPanel changes={changes} disabled={!!storageError} onUndo={undo} />}
    {panel === "memory" && <MemoryPanel memory={memory} disabled={!!storageError} onDelete={forget} />}
    <section className="panel flex min-h-[60vh] flex-col p-4 sm:p-6" aria-label="Chat mit dem Finanz-Assistenten">
      <FinancialData className="flex flex-1 flex-col gap-4" aria-live="polite">
        <Bubble role="assistant" text={intro} />
        {messages.length <= 1 && <div className="flex flex-wrap gap-2 pl-11">
          {examples.map((example) => <button key={example} type="button" onClick={() => { setInput(example); inputRef.current?.focus(); }}
            className="rounded-full border border-border/70 bg-background/40 px-3 py-1.5 text-left text-xs text-muted-foreground transition hover:border-primary/50 hover:text-foreground">{example}</button>)}
        </div>}
        {messages.map((message) => <div key={message.id} className="flex flex-col gap-2">
          <Bubble role={message.role} text={message.text} source={message.source} faded={message.status === "dismissed"} />
          {message.card && <div className="pl-11">{message.card.kind === "homeoffice"
            ? <HomeOfficeCard card={message.card} state={state} disabled={!!storageError} onResult={(result) => addResult(result, "Regel")} />
            : <ResultCard card={message.card} state={state} />}</div>}
          {message.change && message.status !== "dismissed" && <div className="pl-11">
            <ChangeCard message={message} disabled={!!storageError} onApply={() => applyChange(message)}
              onDismiss={() => setMessage(message.id, { status: "dismissed" }, "Alles klar, ich habe nichts geändert.")}
              onUndo={() => message.change?.logId && undo(message.change.logId)} />
          </div>}
          {message.undoId && !message.draft && !message.change && message.status !== "dismissed" && <div className="flex flex-wrap items-center gap-2 pl-11">
            {message.status === "preview" ? <>
              <Button type="button" size="sm" className="min-h-10" disabled={!!storageError} onClick={() => undo(message.undoId!)}><Undo2 aria-hidden="true" className="size-4" />Rückgängig machen</Button>
              <Button type="button" size="sm" variant="ghost" className="min-h-10" onClick={() => setMessage(message.id, { status: "dismissed" })}><X aria-hidden="true" className="size-4" />Doch nicht</Button>
            </> : message.status === "undone" && <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Undo2 aria-hidden="true" className="size-3.5" />Rückgängig gemacht</p>}
          </div>}
          {message.draft && message.status !== "question" && <div className="pl-11">
            {editing === message.id
              ? <DraftEditor draft={message.draft} onCancel={() => setEditing(undefined)} onSave={(draft) => {
                setEditing(undefined);
                const question = missingQuestion(draft);
                setMessage(message.id, { draft, status: question ? "question" : "preview", text: question ?? previewText(draft) });
              }} />
              : <DraftCard key={`${message.id}:${JSON.stringify(message.draft)}`} message={message} state={state} dashboard={dashboard} disabled={!!storageError}
                onEdit={() => setEditing(message.id)}
                onDismiss={() => setMessage(message.id, { status: "dismissed" }, "Alles klar, ich habe nichts gespeichert.")}
                onCreateGoal={(draft) => createGoal(message, draft)} onCreateExpense={(draft) => createExpense(message, draft)}
                onUndo={() => message.undoId && undo(message.undoId)} />}
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
          placeholder="z. B. „Was war meine größte Ausgabe dieses Jahr?“ oder „Schieb das Pickerl auf April“"
          className="min-h-11 flex-1 resize-none rounded-xl border border-input bg-background/60 px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button type="submit" className="min-h-11" disabled={busy || !input.trim() || !!storageError}><Send aria-hidden="true" className="size-4" />Senden</Button>
      </form>
      <p className="mt-2 text-2xs text-muted-foreground">Die KI wählt nur die passende Funktion und liest Namen und Beträge heraus. Alle Zahlen rechnet der Code. Gespeichert wird nur nach deinem Klick, der Verlauf bleibt in deiner lokalen Datenbank.</p>
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
  onEdit: () => void; onDismiss: () => void; onUndo: () => void;
  onCreateGoal: (draft: AssistantDraft) => void; onCreateExpense: (draft: AssistantDraft) => void;
};

function freeRows(state: AppState, dashboard: Dashboard, cost: (month: string) => number) {
  const end = planningHorizon(dashboard);
  const rows: { month: string; before: number; after: number }[] = [];
  for (let index = 0; index < 12; index += 1) {
    const month = addMonths(dashboard.currentMonth, index);
    if (month > end) break;
    const basis = monthBasis(state, dashboard, month);
    if (basis) rows.push({ month, before: basis.free, after: Math.round((basis.free - cost(month)) * 100) / 100 });
  }
  return rows;
}

function Slider({ label, value, min, max, step = 1, display, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; display: string; onChange: (value: number) => void;
}) {
  const id = useId();
  return <div className="space-y-1">
    <div className="flex justify-between gap-3 text-xs"><label htmlFor={id} className="text-muted-foreground">{label}</label><span className="font-medium tabular-nums">{display}</span></div>
    <input id={id} type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} aria-valuetext={display}
      onChange={(event) => onChange(Number(event.target.value))} className="h-6 w-full cursor-pointer accent-primary" />
  </div>;
}

function DraftCard({ message, state, dashboard, disabled, onEdit, onDismiss, onUndo, onCreateGoal, onCreateExpense }: CardProps) {
  const [draft, setDraft] = useState(message.draft!);
  const [variant, setVariant] = useState<AssistantDraft>();
  const open = message.status === "preview";
  const buffer = memoryValue(state, "buffer") ?? 0;
  if (message.status === "created") return <p className="flex flex-wrap items-center gap-3 text-xs text-primary">
    <span className="inline-flex items-center gap-1.5"><Check aria-hidden="true" className="size-3.5" />Angelegt</span>
    {message.undoId && <Button type="button" size="sm" variant="outline" className="min-h-9" disabled={disabled} onClick={onUndo}><Undo2 aria-hidden="true" className="size-4" />Rückgängig</Button>}
  </p>;
  if (message.status === "undone") return <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Undo2 aria-hidden="true" className="size-3.5" />Angelegt und wieder rückgängig gemacht</p>;
  if (message.status === "dismissed") return null;

  const goal = draft.action === "savings_goal";
  const createOk = goal ? planSavingsGoal(state, dashboard, draft).ok : !!(draft.amount && draft.date);
  const createLabel = goal ? (draft.whatIf ? "Doch anlegen" : "Anlegen")
    : draft.whatIf ? "Doch als Ausgabe anlegen" : draft.action === "expense" ? "Anlegen" : "Als geplante Ausgabe anlegen";
  const check = !goal && draft.amount && draft.date ? checkAffordability(state, dashboard, draft, buffer) : undefined;
  const body = (value: AssistantDraft, change: (draft: AssistantDraft) => void) =>
    <DraftBody draft={value} onChange={change} open={open} state={state} dashboard={dashboard} buffer={buffer} />;
  return <article className={cn("rounded-2xl border bg-background/40 p-4", variant || goal ? "border-border/70" : lights[check?.light ?? "unknown"].tone)}
    aria-label={goal ? "Vorschau Sparziel" : draft.action === "expense" ? "Vorschau geplante Ausgabe" : "Leistbarkeit"}>
    {draft.whatIf && <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-2xs text-muted-foreground"><CircleHelp aria-hidden="true" className="size-3" />Was-wäre-wenn · nichts gespeichert</p>}
    {variant ? <div className="grid gap-4 sm:grid-cols-2">
      <section aria-label="Variante A"><p className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Variante A</p>{body(draft, setDraft)}</section>
      <section aria-label="Variante B" className="border-t border-border/60 pt-4 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
        <p className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Variante B</p>{body(variant, setVariant)}
        {open && <Button type="button" size="sm" variant="secondary" className="mt-3 min-h-10" onClick={() => { setDraft(variant); setVariant(undefined); }}>
          <Check aria-hidden="true" className="size-4" />B übernehmen</Button>}
      </section>
    </div> : body(draft, setDraft)}
    {open && <div className="mt-4 flex flex-wrap gap-2">
      {createOk && <Button type="button" size="sm" className="min-h-10" disabled={disabled} onClick={() => goal ? onCreateGoal(draft) : onCreateExpense(draft)}>
        <Check aria-hidden="true" className="size-4" />{variant ? `A ${createLabel.toLowerCase()}` : createLabel}</Button>}
      <Button type="button" size="sm" variant="outline" className="min-h-10" aria-pressed={!!variant} onClick={() => setVariant(variant ? undefined : { ...draft })}>
        <Columns2 aria-hidden="true" className="size-4" />{variant ? "Vergleich schließen" : "Variante vergleichen"}</Button>
      <Button type="button" size="sm" variant="outline" className="min-h-10" onClick={onEdit}><Pencil aria-hidden="true" className="size-4" />Ändern</Button>
      <Button type="button" size="sm" variant="ghost" className="min-h-10" onClick={onDismiss}><X aria-hidden="true" className="size-4" />Verwerfen</Button>
    </div>}
  </article>;
}

function DraftBody({ draft, onChange, open, state, dashboard, buffer }: {
  draft: AssistantDraft; onChange: (draft: AssistantDraft) => void; open: boolean; state: AppState; dashboard: Dashboard; buffer: number;
}) {
  const current = dashboard.currentMonth;
  if (draft.action === "savings_goal") {
    const plan = planSavingsGoal(state, dashboard, draft);
    const months = plan.ok ? Math.max(1, monthDiff(plan.firstMonth, plan.date.slice(0, 7)) + 1) : 1;
    const rest = Math.max(10, Math.ceil((plan.target - plan.start) / 10) * 10);
    return <div>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><PiggyBank aria-hidden="true" className="size-4 text-primary" />Sparziel {plan.name}</h3>
      {plan.error ? <p className="text-sm text-destructive">{plan.error}</p> : <>
        <dl className="space-y-1.5">
          <Row label="Ziel" value={currency(plan.target)} />
          <Row label="Bis" value={dateLabel(plan.date)} />
          {plan.start > 0 && <Row label={`Startkapital${draft.fromAccount ? ` (${draft.fromAccount})` : ""}`} value={currency(plan.start)} />}
          <Row label={`Monatsrate · ${plan.months} ${plan.months === 1 ? "Monat" : "Monate"}`} value={`${currency(plan.monthly)} / Monat`} strong />
          {plan.extra && <Row label={`Extra ${plan.extra.months === 1 ? "im 1. Monat" : `die ersten ${plan.extra.months} Monate`}${plan.extra.from ? ` (vom ${plan.extra.from})` : ""}`}
            value={`${plan.extra.months} × ${currency(plan.extra.amount)} = ${currency(plan.extra.total)}`} />}
        </dl>
        {open && plan.ok && <div className="mt-3 space-y-2 rounded-xl bg-muted/30 p-3">
          <Slider label="Bis wann" value={months} min={1} max={60} display={monthLabel(plan.date.slice(0, 7))}
            onChange={(value) => { const { monthly: _monthly, ...rest } = draft; void _monthly; onChange({ ...rest, date: monthEnd(addMonths(plan.firstMonth, value - 1)) }); }} />
          <Slider label="Oder Rate pro Monat" value={Math.round(plan.monthly / 10) * 10} min={10} max={Math.min(rest, 100_000)} step={10} display={`${currency(plan.monthly)}`}
            onChange={(value) => { const { date: _date, ...rest } = draft; void _date; onChange({ ...rest, monthly: value }); }} />
        </div>}
        {plan.offered && plan.reachableWithOffered && <div className="mt-3 rounded-xl bg-muted/40 p-3 text-xs">
          Mit {currency(plan.offered)} im Monat erreichst du das Ziel erst bis {dateLabel(plan.reachableWithOffered)}.
          {open && <Button type="button" size="sm" variant="link" className="h-auto p-0 pl-1 text-xs"
            onClick={() => onChange({ ...draft, date: plan.reachableWithOffered })}>Datum übernehmen</Button>}
        </div>}
        {plan.conflicts.length > 0 && <ul className="mt-3 space-y-1 text-xs text-amber-700 dark:text-amber-400">
          {plan.conflicts.map((item) => <li key={item.goalId}>⚠ {item.name} bekommt dadurch bis {dateLabel(item.date)} {currency(item.loss)} weniger
            {item.late ? " und wird nicht mehr rechtzeitig fertig." : ", schafft es aber noch."}</li>)}
        </ul>}
        {plan.fundedInPlan + 0.5 < plan.planned && plan.checkedUntil >= plan.date.slice(0, 7) && <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
          ⚠ {plan.shortMonths.length > 0 && `${listMonths(plan.shortMonths)} reicht der Überschuss nicht für die volle Rate. `}
          Laut Monatsplan kommen bis {dateLabel(plan.date)} nur {currency(plan.fundedInPlan)} von {currency(plan.planned)} zusammen.</p>}
        {plan.warnings.map((warning) => <p key={warning} className="mt-2 text-xs text-muted-foreground">{warning}</p>)}
        {plan.ok && <FreeChart label={`mit ${currency(plan.monthly)} Sparrate`}
          rows={freeRows(state, dashboard, (month) => month >= plan.firstMonth && month <= plan.date.slice(0, 7) ? plan.monthly : 0)} />}
      </>}
    </div>;
  }

  const check = draft.amount && draft.date ? checkAffordability(state, dashboard, draft, buffer) : undefined;
  const light = lights[check?.light ?? "unknown"];
  const installments = draft.installments ?? 1;
  const item = draft.amount && draft.date ? buildPlannedOneOff(draft, "preview") : undefined;
  const costs = new Map<string, number>();
  if (item) for (const occurrence of plannedOccurrences([item])) costs.set(occurrence.date.slice(0, 7), (costs.get(occurrence.date.slice(0, 7)) ?? 0) + occurrence.ownAmount);
  const offset = draft.date ? monthDiff(current, draft.date.slice(0, 7)) : 0;
  return <div>
    <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><CalendarClock aria-hidden="true" className="size-4 text-primary" />{draft.name ?? (draft.action === "expense" ? "Geplante Ausgabe" : "Ausgabe")}</h3>
    {item && <dl className="space-y-1.5">
      <Row label="Betrag" value={currency(draft.amount!)} />
      <Row label={installments > 1 ? "Erste Rate" : "Fällig"} value={monthOf(item.date)} />
      {installments > 1 && <Row label="Raten" value={`${installments} × ${currency(item.amount)}`} />}
      {draft.shared && <Row label="Geteilt mit Raphael" value="ja, du zahlst die Hälfte" />}
      <Row label="Konto" value={item.pocket} />
    </dl>}
    {open && item && offset >= 0 && offset <= 12 && <div className="mt-3 space-y-2 rounded-xl bg-muted/30 p-3">
      <Slider label="Wann" value={offset} min={0} max={12} display={monthLabel(draft.date!.slice(0, 7))}
        onChange={(value) => onChange({ ...draft, date: `${addMonths(current, value)}-01` })} />
      <Slider label="Raten" value={installments} min={1} max={24} display={installments === 1 ? "auf einmal" : `${installments} × ${currency(item.amount)}`}
        onChange={(value) => onChange({ ...draft, installments: value })} />
    </div>}
    {check && <div className="mt-3 rounded-xl bg-background/60 p-3 text-sm" role="status">
      <p className="font-medium">{light.dot} {light.label}</p>
      <p className="mt-1 text-muted-foreground">{affordabilityText(check)}</p>
      {buffer > 0 && <p className="mt-1 text-xs text-muted-foreground">Dein gemerkter Puffer von {currency(buffer)} ist schon abgezogen.</p>}
      {check.light === "red" && check.alternatives.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Möglich wäre:</p>}
      {check.light !== "green" && check.alternatives.length > 0 && open && <div className="mt-2 flex flex-wrap gap-2">
        {check.alternatives.map((option) => option.kind === "installments"
          ? <Button key="installments" type="button" size="sm" variant="outline" onClick={() => onChange({ ...draft, installments: option.installments })}>{option.installments} Raten à {currency(option.rate!)}</Button>
          : option.kind === "later"
            ? <Button key="later" type="button" size="sm" variant="outline" onClick={() => onChange({ ...draft, date: `${option.month}-01` })}>Im {monthOf(`${option.month}-01`)} statt</Button>
            : <span key="reserve" className="self-center text-xs text-muted-foreground">oder aus dem Sparkonto ({currency(option.balance!)} verfügbar)</span>)}
      </div>}
    </div>}
    {item && <FreeChart label={`mit ${draft.name ?? "der Ausgabe"}`} rows={freeRows(state, dashboard, (month) => costs.get(month) ?? 0)} />}
  </div>;
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
      ...(goal && money("extraAmount") && Number(read("extraMonths")) ? { extra: { amount: money("extraAmount"), months: Number(read("extraMonths")),
        ...(extraSources.includes(read("extraFrom")) ? { from: read("extraFrom") } : {}) } } : {}),
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
        <Field name="extraAmount" label="Extra pro Monat zum Start (€)" value={draft.extra?.amount} inputMode="decimal" />
        <Field name="extraMonths" label="Extra für wie viele Monate" value={draft.extra?.months} inputMode="numeric" />
        <Field name="extraFrom" label={`Extra von Konto (${extraSources.join(", ")})`} value={draft.extra?.from} />
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
