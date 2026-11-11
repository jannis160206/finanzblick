"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Brain, Bot, CalendarClock, Check, CircleHelp, Columns2, History, LoaderCircle, MessageSquareText, Pencil, PiggyBank, Send, Sparkles, ThumbsDown, ThumbsUp, Trash2, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { ChangeCard, ChangesPanel, FreeChart, MemoryPanel, ResultCard } from "@/components/assistant-cards";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { HomeOfficeCard } from "@/components/homeoffice-card";
import { PageHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { executeTool, memoryValue, parseMemory, type AgentHints, type AgentResult } from "@/lib/assistant/agent";
import { balances } from "@/lib/assistant/accounts";
import { giroTopUp, parseAccountRules, ruleText, rulesResult, storeAccountRules, topUpText } from "@/lib/assistant/funds";
import { readAnswerStream } from "@/lib/ai/answer-stream";
import { weeklyBriefing } from "@/lib/assistant/answers";
import { lastDay, mergeDraft, missingQuestion, parseAssistantMessage } from "@/lib/assistant/intent";
import { extractMemories } from "@/lib/assistant/memory";
import { smallTalk, starterSuggestions } from "@/lib/assistant/smalltalk";
import { applyOperations, OperationError, recordChange, recordCreation, undoChange } from "@/lib/assistant/operations";
import { buildPlannedOneOff, buildSavingsGoal, checkAffordability, goalExtraOperation, monthBasis, planningHorizon, planSavingsGoal, type Affordability } from "@/lib/assistant/plan";
import { changingTools, conversationRoute, evidenceText } from "@/lib/assistant/conversation";
import { detectTool, isAssistantTool, isDraftTool, type AssistantTool } from "@/lib/assistant/tools";
import { agentLabel, isAgentId, routeByRules, routeBySignals, toolOwner, type AgentId } from "@/lib/assistant/orchestrator";
import { agentEvidence, agentFacts, agentSuggestions } from "@/lib/assistant/specialist-context";
import { currentAssistantContext, type AssistantPageContext } from "@/lib/assistant-context";
import { useDashboardExtras } from "@/components/dashboard/use-dashboard-extras";
import { currentNavItem } from "@/components/shell/navigation";
import { currenciesIn, type MarketSnapshot } from "@/lib/assistant/market";
import { findKnowledge, isStale, knowledgeListQuestion, knowledgeTopics, learnPhrase, matchPhrase, relevantKnowledge, storeKnowledge } from "@/lib/assistant/knowledge";
import { resolveFollowUp } from "@/lib/assistant/followup";
import { aliasTeaching, applyAliases, correction, countAliases, learnAlias, openGaps, pickName, recordGap, resolveGap, unknownTarget, unlearnPhrase } from "@/lib/assistant/learning";
import { addMonths, type Dashboard } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { preserveGoalOpeningBalances, savingsGoals } from "@/lib/goals";
import { plannedOccurrences } from "@/lib/planned-one-offs";
import {
  appStateSchema, assistantDraftSchema, assistantMessageSchema, extraSourceSchema, MAX_ASSISTANT_MESSAGES,
  type AppState, type AssistantDraft, type AssistantKnowledge, type AssistantMessage, type AssistantOperation,
} from "@/lib/types";
import { cn } from "@/lib/utils";

// Tools whose answer depends only on the message text; phrasings for these are learned when the model understood them.
const learnableTools: AssistantTool[] = ["query", "accounts", "amex", "budget", "briefing", "check", "coach", "depot", "market", "knowledge", "tax", "homeoffice", "explain", "memory", "changes"];
type KnowledgeHit = { topic: string; title: string; text: string; url: string; source: string };

const examples = [
  "Wie viel hab ich im Oktober fürs Essen ausgegeben?",
  "Ich will bis Juli 2027 3.000 € für Japan sparen, 500 € liegen schon am Sparkonto.",
  "Kann ich mir im Mai einen Fernseher um 900 € leisten?",
  "Was kann ich im Dashboard alles einstellen?",
];
const extraSources: string[] = [...extraSourceSchema.options];
const intro = "Hallo! Ich bin dein Finanz-Assistent. Frag mich einfach, wie du es sagen würdest: zu deinen Ausgaben, deinen Sparzielen " +
  "oder ob du dir etwas leisten kannst. Ich rechne alles mit deinen echten Zahlen und ändere nur etwas, wenn du bestätigst.";
// Natural next questions after an answer, shown as quick replies.
const followUps: Partial<Record<AssistantTool, string[]>> = {
  query: ["Mehr als im Vormonat?", "Was war meine größte Ausgabe dieses Jahr?", "Wo könnte ich kürzen?"],
  accounts: ["Wie viel muss ich auf Amex Rückzahlung überweisen?", "Was bleibt mir diesen Monat?"],
  amex: ["Was habe ich seit 11.10. mit Amex bezahlt?", "Zeig mir meine Kontostände"],
  budget: ["Kann ich mir im Mai 900 € leisten?", "Wo kann ich sparen?"],
  orders: ["Wie viel kann ich heute noch ausgeben?", "Wird mein Konto knapp?"],
  pulse: ["Wird mein Konto knapp?", "Wo gebe ich diesen Monat mehr aus als sonst?"],
  briefing: ["Kann ich mir im Mai 900 € leisten?", "Wo kann ich sparen?"],
  check: ["Wo könnte ich kürzen?", "Wie haben sich meine Ausgaben entwickelt?"],
  coach: ["Wie viel geht für Abos weg?", "100 € im Monat in einen ETF, was habe ich nach 10 Jahren?"],
  depot: ["Und mit 200 € im Monat?", "Wie hoch ist die Inflation gerade?"],
  market: ["Welche Zinsen bekomme ich fürs Sparkonto?", "Wie viel sind 3.000 € in Yen?"],
  knowledge: ["Was ist ein ETF?", "Was bedeutet KESt?"],
  tax: ["Was bekomme ich für Home-Office-Sachen zurück?"],
  memory: ["Merk dir: Puffer immer 500 €"],
  changes: ["Mach das rückgängig"],
  explain: ["Wie funktionieren die Sparziele?", "Wie funktioniert der Import?"],
  contracts: ["Welche Verträge kann ich kündigen?", "Was fällt dir auf?"],
  context: ["Was fällt dir auf?", "Wo gebe ich mehr aus als letzten Monat?"],
  insights: ["Wie viel kann ich noch ausgeben?", "Welche Abos habe ich?"],
};
const thinkingSteps = ["Lese deine Nachricht", "Suche die passenden Daten", "Rechne nach", "Formuliere die Antwort"];
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
// What the user is looking at; pages add filters and selections, otherwise the route is enough.
function pageContext(): AssistantPageContext | null {
  const published = currentAssistantContext();
  if (published) return published;
  if (typeof window === "undefined") return null;
  const route = window.location.pathname;
  return { route, title: currentNavItem(route)?.label ?? "Finanzblick" };
}
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

export function FinanceAssistant({ variant = "page", prompt }: { variant?: "page" | "panel"; prompt?: { text: string; at: number; send?: boolean } } = {}) {
  const { state, dashboard, update, storageError, ready } = useFinance();
  const extras = useDashboardExtras();
  const messages = state.assistantChat ?? [];
  const [input, setInput] = useState(prompt?.text ?? "");
  // A question started from a booking, budget or category lands in the input, ready to send.
  const [seenPrompt, setSeenPrompt] = useState(prompt?.at);
  if (prompt?.text && prompt.at !== seenPrompt) {
    setSeenPrompt(prompt.at);
    setInput(prompt.text);
  }
  useEffect(() => {
    if (!prompt?.text) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [prompt?.text, prompt?.at]);
  // "Mehr dazu" on a hint asks right away; if the chat is busy, the question simply stays in the input.
  const autoSent = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!prompt?.send || !prompt.text || !ready || storageError || autoSent.current === prompt.at) return;
    autoSent.current = prompt.at;
    void send(undefined, prompt.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.at, prompt?.send, ready, storageError]);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [panel, setPanel] = useState<"changes" | "memory">();
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const briefed = useRef(false);
  const marketCache = useRef(new Map<string, { at: number; value: MarketSnapshot }>());
  // The agent whose answer is streaming right now, for the label above the growing text.
  const [answering, setAnswering] = useState<AgentId>();
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [messages.length, busy, streaming]);

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
      { id: newId(), role: "assistant", text: question ?? previewText(draft), at: Date.now(), draft, status: question ? "question" : "preview", source, agent: toolOwner[draft.action] }]);
  };
  const addResult = (result: AgentResult, source: AssistantMessage["source"], meta: Pick<AssistantMessage, "tool" | "asked" | "correcting" | "clarify" | "agent"> = {}) => {
    const suggestions = result.choices?.length ? result.choices : result.suggestions;
    const message = {
      id: newId(), role: "assistant" as const, text: result.text.slice(0, 2000), at: Date.now(), source,
      ...(result.card ? { card: result.card } : {}), ...(result.change ? { change: result.change } : {}),
      ...(result.undoId ? { undoId: result.undoId } : {}), ...(result.change || result.undoId ? { status: "preview" as const } : {}),
      ...(suggestions?.length ? { suggestions: [...new Set(suggestions)].map((item) => item.slice(0, 120)).slice(0, 4) } : {}),
      ...(meta.tool ? { tool: meta.tool.slice(0, 40) } : {}), ...(meta.asked ? { asked: meta.asked.slice(0, 1000) } : {}), ...(meta.agent ? { agent: meta.agent } : {}),
      ...(meta.correcting ? { correcting: meta.correcting.slice(0, 1000) } : {}),
      ...(meta.clarify && result.choices?.length ? { clarify: meta.clarify.slice(0, 1000) } : {}),
    };
    const parsed = assistantMessageSchema.safeParse(message);
    save((items) => [...items, parsed.success ? parsed.data : { id: message.id, role: "assistant", text: message.text, at: message.at }]);
  };
  const knownNames = () => [...savingsGoals(state).filter((goal) => !goal.completedAt).map((goal) => goal.name.slice(0, 80)).slice(0, 50),
    ...new Set(plannedOccurrences(state.plannedOneOffs).filter((item) => item.date.slice(0, 7) >= dashboard.currentMonth).map((item) => item.name.slice(0, 100)))].slice(0, 110);

  // 👍 reinforces how the question was understood; 👎 forgets it and asks what was meant, so the next answer teaches the right way.
  function giveFeedback(message: AssistantMessage, value: "up" | "down") {
    const asked = message.asked;
    if (!asked) return;
    const tool = message.tool && isAssistantTool(message.tool) ? message.tool : undefined;
    const learnable = !!tool && learnableTools.includes(tool) && detectTool(asked, knownNames()) !== tool;
    update((current) => {
      const chat = (current.assistantChat ?? []).map((item) => item.id === message.id ? { ...item, feedback: value } : item);
      if (value === "up") return { ...current, assistantChat: chat,
        assistantPhrases: learnable ? learnPhrase(current.assistantPhrases, asked, tool!) : current.assistantPhrases,
        assistantGaps: tool ? resolveGap(current.assistantGaps, asked, tool) : current.assistantGaps };
      const ask: AssistantMessage = { id: newId(), role: "assistant", at: Date.now(), source: "Regel", correcting: asked.slice(0, 1000),
        text: `Danke für die ehrliche Rückmeldung. Was hast du mit „${asked.slice(0, 120)}“ gemeint? Schreib es kurz anders, dann lerne ich es für das nächste Mal.`,
        suggestions: ["Was kannst du alles?"] };
      return { ...current, assistantChat: [...chat, ask].slice(-MAX_ASSISTANT_MESSAGES),
        assistantPhrases: unlearnPhrase(current.assistantPhrases, asked), assistantGaps: recordGap(current.assistantGaps, asked) };
    });
    if (value === "up") toast.success("Danke, das merke ich mir");
  }

  // Self-improvement: questions it could not answer before are tried again in the background, e.g. once the local model is back.
  const retried = useRef(false);
  useEffect(() => {
    if (retried.current || !ready || storageError) return;
    retried.current = true;
    const open = openGaps(state.assistantGaps).slice(0, 3);
    if (!open.length) return;
    void (async () => {
      const solved: { text: string; tool: AssistantTool }[] = [];
      for (const gap of open) {
        let tool: AssistantTool | undefined = detectTool(gap.text, knownNames());
        if (!tool) try {
          const response = await fetch("/api/ai/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
            body: JSON.stringify({ message: gap.text, asOf: state.settings.asOf, history: [], context: { goals: [], planned: [] } }), signal: AbortSignal.timeout(30000) });
          const reply = response.ok ? await response.json() as { tool?: unknown; source?: string } : undefined;
          if (reply?.source === "KI" && isAssistantTool(reply.tool) && learnableTools.includes(reply.tool)) tool = reply.tool;
        } catch {
          break;
        }
        if (tool && learnableTools.includes(tool)) solved.push({ text: gap.text, tool });
      }
      if (!solved.length) return;
      update((current) => solved.reduce((next, item) => ({ ...next,
        assistantPhrases: learnPhrase(next.assistantPhrases, item.text, item.tool), assistantGaps: resolveGap(next.assistantGaps, item.text, item.tool) }), current));
      toast.success(`Selbst nachgelernt · ${solved.length === 1 ? "1 offene Frage" : `${solved.length} offene Fragen`}`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, storageError]);

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
  function remember(operations: Extract<AssistantOperation, { op: "memory_add" }>[]) {
    const logId = newId();
    const at = timestamp();
    const text = `Gemerkt: ${operations.map((operation) => operation.text).join(" · ")}`.slice(0, 300);
    commit((current) => recordChange(current, applyOperations(current, operations, { asOf: current.settings.asOf, now: at }), { id: logId, at, title: text }),
      (items) => [...items, { id: newId(), role: "assistant", text, at, status: "applied", undoId: logId, source: "Regel" }]);
  }

  // Proactive start: one weekly overview per day, built only from your own data.
  useEffect(() => {
    if (briefed.current || !ready || storageError) return;
    briefed.current = true;
    const now = Date.now();
    if ((state.assistantChat ?? []).some((item) => item.card?.kind === "briefing" && sameDay(item.at, now))) return;
    try {
      const briefing = weeklyBriefing(state, dashboard, state.settings.asOf, memoryValue(state, "salaryDay"));
      const topUp = giroTopUp(state, dashboard, state.settings.asOf);
      const text = topUp ? `⚠️ ${topUpText(topUp)}\n\n${briefing.text}` : briefing.text;
      const message = assistantMessageSchema.safeParse({ id: newId(), role: "assistant", text: text.slice(0, 2000), at: now, source: "Regel",
        ...(briefing.card ? { card: briefing.card } : {}), suggestions: ["Kann ich mir im Mai 900 € leisten?", "Wo kann ich sparen?"] });
      // Checked again inside the update, so two quick page loads never add the overview twice.
      if (message.success) save((items) => items.some((item) => item.card?.kind === "briefing" && sameDay(item.at, now)) ? items : [...items, message.data]);
    } catch {
      // The overview is optional; the chat still works without it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, storageError]);

  // Anything no tool covers gets a short answer from the chosen agent, built only from its own facts and computed evidence.
  async function freeAnswer(question: string, history: { role: "user" | "assistant"; text: string }[], agent: AgentId, evidence?: string) {
    try {
      const facts = agentFacts(agent, state, dashboard, state.settings.asOf, question);
      // Knowledge learned earlier is used here too, so free answers can explain terms.
      const known = relevantKnowledge(state.assistantKnowledge, question);
      if (known.length) Object.assign(facts, { wissen: known.map((entry) => ({ begriff: entry.title, erklaerung: entry.text.slice(0, 600), quelle: entry.source })) });
      setAnswering(agent);
      // The general chat keeps the conversation; a specialist only needs the last exchange.
      const context = agent === "general" ? history : history.slice(-2);
      const response = await fetch("/api/ai/answer?stream=1", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ question, history: context, facts, agent, ...(evidence ? { evidence } : {}) }),
      });
      if (!response.ok) return undefined;
      if (response.body && response.headers.get("content-type")?.includes("ndjson")) {
        const text = await readAnswerStream(response.body, setStreaming);
        // A rejected answer disappears again; the normal fallback takes over.
        if (!text) setStreaming(undefined);
        return text;
      }
      const answer: { text?: unknown } = await response.json();
      return typeof answer.text === "string" && answer.text.trim() ? answer.text.trim() : undefined;
    } catch {
      setStreaming(undefined);
      return undefined;
    }
  }

  // Public market data from the finanzblick-web MCP server; only currency codes leave the browser, never personal data.
  async function loadMarket(text: string): Promise<MarketSnapshot | undefined> {
    const codes = currenciesIn(text).sort().join(",");
    const cached = marketCache.current.get(codes);
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.value;
    try {
      const response = await fetch(`/api/market?currencies=${encodeURIComponent(codes)}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!response.ok) return cached?.value;
      const value = await response.json() as MarketSnapshot;
      marketCache.current.set(codes, { at: Date.now(), value });
      return value;
    } catch {
      return cached?.value;
    }
  }

  // Terms are answered from learned knowledge; unknown or outdated ones are looked up once via the MCP server and remembered.
  async function loadKnowledge(text: string, names: string[]) {
    const topics = knowledgeTopics(text, names, true);
    const found: AssistantKnowledge[] = [], fresh: AssistantKnowledge[] = [], used: string[] = [];
    let offline = false;
    for (const topic of topics) {
      const stored = findKnowledge(state.assistantKnowledge, topic);
      if (stored && !isStale(stored)) { found.push(stored); used.push(stored.id); continue; }
      try {
        const response = await fetch(`/api/knowledge?q=${encodeURIComponent(topic)}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error();
        const { hit } = await response.json() as { hit?: KnowledgeHit | null };
        if (hit?.title && hit.text && hit.url) {
          const entry: AssistantKnowledge = { id: newId(), topic: topic.slice(0, 100), title: hit.title.slice(0, 200), text: hit.text.slice(0, 1500),
            url: hit.url.slice(0, 500), source: hit.source.slice(0, 100), at: Date.now() };
          found.push(entry);
          fresh.push(entry);
        } else if (stored) found.push(stored);
      } catch {
        offline = true;
        if (stored) { found.push(stored); used.push(stored.id); }
      }
    }
    if (fresh.length || used.length) update((current) => ({ ...current, assistantKnowledge: storeKnowledge(current.assistantKnowledge, fresh, used) }));
    return { found, fresh: fresh.map((entry) => entry.id), offline };
  }

  async function send(event?: FormEvent, preset?: string) {
    event?.preventDefault();
    const text = (preset ?? input).trim().slice(0, 1000);
    if (!text || busy || storageError) return;
    const pending = [...messages].reverse().find((item) => item.role === "assistant" && item.draft && (item.status === "question" || item.status === "preview"))?.draft;
    const asOf = state.settings.asOf;
    const startedAt = Date.now();
    // Short pause, so instant rule answers still read like a reply instead of a page jump.
    const settle = () => new Promise((resolve) => setTimeout(resolve, Math.max(0, 650 - (Date.now() - startedAt))));
    const names = knownNames();
    const lastAnswer = messages.findLast((item) => item.role === "assistant");
    // Teaching own words: "Mit Japan meine ich Motorrad".
    const teaching = pending ? undefined : aliasTeaching(text);
    if (teaching) {
      setInput("");
      setBusy(true);
      save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
      const target = pickName(teaching.to, names) ?? teaching.to;
      update((current) => ({ ...current, assistantAliases: learnAlias(current.assistantAliases, teaching.from, target) }));
      await settle();
      addResult({ text: `Gemerkt: Wenn du „${teaching.from}“ schreibst, meinst du „${target}“. Das gilt ab sofort überall im Chat; unter „Gedächtnis“ kannst du es wieder löschen.`,
        suggestions: [`Wie weit bin ich bei ${teaching.from}?`, "Was hast du gelernt?"] }, "Regel");
      setBusy(false);
      inputRef.current?.focus();
      return;
    }
    // Corrections teach the earlier phrasing: "Nein, ich meinte …", or the answer to "Was hast du gemeint?".
    const fix = !pending && lastAnswer?.asked ? correction(text) : undefined;
    if (fix && !fix.text && lastAnswer) {
      setInput("");
      save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
      giveFeedback(lastAnswer, "down");
      inputRef.current?.focus();
      return;
    }
    const original = pending ? undefined : fix ? lastAnswer?.asked : lastAnswer?.correcting;
    let work = fix?.text ?? text;
    // Answer to "Welches meinst du?": run the earlier command with that name and remember the word that was meant.
    let alias: { from: string; to: string } | undefined;
    const chosen = !pending && lastAnswer?.clarify ? pickName(text, names) : undefined;
    if (chosen && lastAnswer?.clarify) {
      const target = unknownTarget(lastAnswer.clarify, names);
      if (target) alias = { from: target, to: chosen };
      work = target ? applyAliases([{ from: target, to: chosen, at: 0 }], lastAnswer.clarify).text : `${lastAnswer.clarify} ${chosen}`;
    }
    const aliased = applyAliases(state.assistantAliases, work);
    work = aliased.text;
    if (aliased.used.length) update((current) => ({ ...current, assistantAliases: countAliases(current.assistantAliases, aliased.used) }));
    const chat = pending || original || chosen ? undefined : smallTalk(text, { hour: new Date().getHours(), seed: messages.length });
    if (chat) {
      setInput("");
      setBusy(true);
      save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
      await settle();
      addResult(chat, "Regel");
      setBusy(false);
      inputRef.current?.focus();
      return;
    }
    const history = messages.slice(-6).map((item) => ({ role: item.role, text: item.text.slice(0, 500) }));
    const goals = savingsGoals(state).filter((goal) => !goal.completedAt).map((goal) => goal.name.slice(0, 80)).slice(0, 50);
    const planned = [...new Set(plannedOccurrences(state.plannedOneOffs).filter((item) => item.date.slice(0, 7) >= dashboard.currentMonth)
      .map((item) => item.name.slice(0, 100)))].slice(0, 60);
    setInput("");
    setBusy(true);
    save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
    let reply: { agent?: unknown; tool?: unknown; hints?: AgentHints; draft?: AssistantDraft; question?: string; source: "KI" | "Regel" };
    // "und im September?" reuses the previous question instead of asking the model again.
    const follow = pending ? undefined : resolveFollowUp(work, messages.filter((item) => item.role === "user").map((item) => item.text), [...goals, ...planned]);
    // Phrasings learned earlier are understood right away, without asking the model again.
    const learned = pending || follow || detectTool(work, [...goals, ...planned]) ? undefined : matchPhrase(state.assistantPhrases, work);
    if (follow) reply = { tool: follow.tool, source: "Regel" };
    else if (learned && isAssistantTool(learned.tool)) {
      reply = { tool: learned.tool, source: "Regel" };
      update((current) => ({ ...current, assistantPhrases: learnPhrase(current.assistantPhrases, work, learned.tool) }));
    } else try {
      const response = await fetch("/api/ai/assistant", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ message: work, asOf, ...(pending ? { pending } : {}), history, context: { goals, planned } }),
      });
      if (!response.ok) throw new Error();
      reply = await response.json();
    } catch {
      // Same orchestrator rules as the server, without the model; whatever stays unclear goes to the general chat.
      const decision = routeByRules(work, [...goals, ...planned]);
      const tool = decision?.tool;
      if (tool && !isDraftTool(tool) && !(pending && tool === "help")) reply = { agent: decision.agent, tool, source: "Regel" };
      else {
        const draft = mergeDraft(pending, parseAssistantMessage(work, asOf), {}, work, asOf);
        reply = { agent: draft ? toolOwner[draft.action] : decision?.agent ?? "general", draft, question: draft ? missingQuestion(draft) : undefined, source: "Regel" };
      }
    }
    const picked: AssistantTool | undefined = isAssistantTool(reply.tool) && !isDraftTool(reply.tool) && reply.tool !== "ask" ? reply.tool : undefined;
    // Explanations, opinions and advice get a written answer; a question never silently opens an edit or a form.
    const route = conversationRoute({ text: work, tool: picked, ruleTool: reply.source === "Regel" ? picked : detectTool(work, [...goals, ...planned]),
      draftAction: reply.draft?.action, numbers: work.match(/\d+(?:[.,]\d+)?/g)?.map(Number) ?? [], pending: !!pending });
    const tool = route.tool;
    // A tool's owner answers; without a tool the orchestrator's choice, and the general chat whenever it is unsure.
    // A question that dropped a misread form ("Was ist mit meiner Versicherung los?") is routed again by its signal words.
    const agent: AgentId = tool ? toolOwner[tool] : route.skipDraft ? routeBySignals(work, [...goals, ...planned])?.agent ?? "general"
      : isAgentId(reply.agent) ? reply.agent : "general";
    // Only the model understood this phrasing; remember it so the rules answer it directly next time.
    if (tool && reply.source === "KI" && learnableTools.includes(tool) && !Object.values(reply.hints ?? {}).some((value) => value !== undefined && value !== null) &&
      !detectTool(work, [...goals, ...planned])) update((current) => ({ ...current, assistantPhrases: learnPhrase(current.assistantPhrases, work, tool),
        assistantGaps: resolveGap(current.assistantGaps, work, tool) }));
    // What was learned from this message is said at the start of the answer.
    const notes: string[] = [];
    if (original && tool && learnableTools.includes(tool) && original !== work && !detectTool(original, [...goals, ...planned])) {
      update((current) => ({ ...current, assistantPhrases: learnPhrase(current.assistantPhrases, original, tool), assistantGaps: resolveGap(current.assistantGaps, original, tool) }));
      notes.push(`Danke, gelernt: „${original.slice(0, 80)}“ verstehe ich ab jetzt so.`);
    }
    if (alias) {
      const learnedAlias = alias;
      update((current) => ({ ...current, assistantAliases: learnAlias(current.assistantAliases, learnedAlias.from, learnedAlias.to) }));
      notes.push(`Gemerkt: Mit „${alias.from}“ meinst du „${alias.to}“.`);
    }
    const withNotes = (result: AgentResult): AgentResult => notes.length ? { ...result, text: `${notes.join(" ")}\n\n${result.text}` } : result;
    const parsed = !tool && reply.draft && !route.skipDraft ? assistantDraftSchema.safeParse(reply.draft) : undefined;
    const free = !tool && !parsed?.success ? await freeAnswer(work, history, agent, agentEvidence(agent, state, dashboard, asOf, work)) : undefined;
    await settle();
    if (tool === "account_rule") {
      // "Sparkonto ist für alle Ausgaben", "Trade Republic nur für Autowerkstatt": saved right away, deletable under „Gedächtnis“.
      const rules = parseAccountRules(work, [...balances(state, dashboard).map((item) => item.name), ...goals]);
      if (rules.length) {
        const next = { ...state, accountRules: storeAccountRules(state.accountRules, rules) };
        update((current) => ({ ...current, accountRules: storeAccountRules(current.accountRules, rules) }));
        addResult(rulesResult(next, dashboard, asOf, `Gemerkt: ${rules.map((rule) => `${rule.account} ${ruleText(rule)}`).join("; ")}. ` +
          "Bei „Kann ich mir … leisten?“ prüfe ich ab jetzt genau diese Konten und sage dir OK oder nicht OK."), "Regel", { tool, asked: work });
      } else addResult({ text: "Welches Konto meinst du und wofür darf es verwendet werden? Zum Beispiel „Sparkonto ist für alle Ausgaben“ oder „Trade Republic nur für Autowerkstatt, Ölwechsel“.",
        suggestions: ["Welche Konten darf ich wofür verwenden?"] }, reply.source);
    } else if (tool === "remember") {
      // An explicit "Merk dir …" is saved right away; it can be undone or deleted under „Gedächtnis“.
      const operation = parseMemory(work);
      if (operation) remember([operation]);
      else addResult({ text: "Was soll ich mir merken? Zum Beispiel „Puffer immer 500 €“ oder „Mein Gehalt kommt am 25.“." }, reply.source);
    } else if (tool) {
      let result: AgentResult;
      const market = tool === "market" || tool === "depot" ? await loadMarket(work) : undefined;
      const knowledge = tool === "knowledge" && !knowledgeListQuestion(work.toLowerCase()) ? await loadKnowledge(work, [...goals, ...planned]) : undefined;
      try {
        result = executeTool(tool, work, { state, dashboard, asOf, hints: reply.hints, previous: follow?.previous, market, knowledge,
          page: pageContext(), insights: extras?.copilot });
      } catch {
        result = { text: "Dabei ist etwas schiefgegangen. Bitte formuliere es etwas anders." };
      }
      // The tool computed the numbers; the model turns them into a direct answer to the actual question. The card stays.
      if (route.converse && !changingTools.includes(tool) && !result.change && !result.undoId && !result.choices) {
        const said = await freeAnswer(work, history, agent, evidenceText(result));
        if (said) result = { ...result, text: said };
      }
      addResult(withNotes(result.suggestions || result.change || result.undoId || result.choices ? result : { ...result, suggestions: followUps[tool] }), reply.source,
        { tool, asked: work, clarify: work, agent });
    } else if (parsed?.success && parsed.data.action === "affordability")
      // Affordability never opens a plan form: it checks the accounts that may be used and says OK or not OK.
      addResult(withNotes(executeTool("funds", work, { state, dashboard, asOf })), reply.source, { tool: "funds", asked: work, clarify: work, agent: "budget" });
    else if (parsed?.success) addDraftMessage(parsed.data, reply.source);
    else if (free) addResult(withNotes({ text: free, suggestions: agentSuggestions[agent] }), "KI", { tool: "free", asked: work, agent });
    else {
      update((current) => ({ ...current, assistantGaps: recordGap(current.assistantGaps, work) }));
      addResult({ text: "Hm, da komme ich gerade nicht mit. Magst du es mir anders sagen? Die neue Formulierung merke ich mir für das nächste Mal. " +
        "Frag mich zum Beispiel nach deinen Ausgaben, einem Sparziel oder ob sich ein Kauf ausgeht.",
      suggestions: ["Was kannst du alles?", ...starterSuggestions.slice(0, 2)] }, "Regel", { correcting: work });
    }
    // Lasting facts in any message ("Mein Gehalt kommt am 25.", "Ich wohne in Wien") are remembered automatically.
    if (tool !== "remember") {
      const memories = extractMemories(work, state, tool ?? (parsed?.success ? parsed.data.action : undefined));
      if (memories.length) remember(memories);
    }
    setStreaming(undefined);
    setAnswering(undefined);
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
  const memoryCount = memory.length + (state.assistantKnowledge?.length ?? 0) + (state.accountRules?.length ?? 0);
  const panelMode = variant === "panel";
  const actionSize = panelMode ? "min-h-9" : "min-h-11";
  const actions = <>
      <Button type="button" variant={panel === "memory" ? "secondary" : "outline"} size="sm" className={actionSize} aria-pressed={panel === "memory"}
        onClick={() => setPanel(panel === "memory" ? undefined : "memory")}><Brain aria-hidden="true" className="size-4" />Gedächtnis{memoryCount ? ` (${memoryCount})` : ""}</Button>
      <Button type="button" variant={panel === "changes" ? "secondary" : "outline"} size="sm" className={actionSize} aria-pressed={panel === "changes"}
        onClick={() => setPanel(panel === "changes" ? undefined : "changes")}><History aria-hidden="true" className="size-4" />Änderungen{changes.length ? ` (${changes.length})` : ""}</Button>
      {messages.length > 0 && <Button type="button" variant="outline" size="sm" className={actionSize} onClick={() => {
        if (window.confirm("Den gesamten Chatverlauf löschen? Angelegte Ziele, Ausgaben, das Gedächtnis und die Änderungsliste bleiben erhalten.")) update((current) => ({ ...current, assistantChat: [] }));
      }}><Trash2 aria-hidden="true" className="size-4" />Verlauf löschen</Button>}
  </>;
  return <div className={panelMode ? "flex h-full min-h-0 flex-col" : "mx-auto flex max-w-4xl flex-col"}>
    {panelMode ? <div className="flex shrink-0 flex-wrap gap-2 px-4 pb-3 sm:px-6">{actions}</div>
      : <PageHeading title="Finanz-Assistent"
      description="Fragen zu deinen Ausgaben, Sparziele und Ausgaben planen, Bestehendes ändern, Regeln, Spar-Coach, Depot-Rechner und Arbeitnehmerveranlagung.">
      {actions}
    </PageHeading>}
    {panel && <div className={panelMode ? "max-h-[40vh] shrink-0 overflow-y-auto px-4 sm:px-6" : undefined}>
    {panel === "changes" && <ChangesPanel changes={changes} disabled={!!storageError} onUndo={undo} />}
    {panel === "memory" && <MemoryPanel memory={memory} knowledge={state.assistantKnowledge ?? []} phrases={state.assistantPhrases?.length ?? 0}
      disabled={!!storageError} onDelete={forget}
      onForgetKnowledge={(id) => { update((current) => ({ ...current, assistantKnowledge: (current.assistantKnowledge ?? []).filter((entry) => entry.id !== id) })); toast.success("Vergessen"); }}
      onResetPhrases={() => { update((current) => ({ ...current, assistantPhrases: [] })); toast.success("Gelernte Formulierungen zurückgesetzt"); }}
      aliases={state.assistantAliases ?? []} gaps={state.assistantGaps ?? []} rules={state.accountRules ?? []}
      onForgetRule={(id) => { update((current) => ({ ...current, accountRules: (current.accountRules ?? []).filter((entry) => entry.id !== id) })); toast.success("Kontoregel gelöscht"); }}
      onForgetAlias={(from) => { update((current) => ({ ...current, assistantAliases: (current.assistantAliases ?? []).filter((entry) => entry.from !== from) })); toast.success("Vergessen"); }}
      onRemoveGap={(text) => update((current) => ({ ...current, assistantGaps: (current.assistantGaps ?? []).filter((entry) => entry.text !== text) }))} />}
    </div>}
    <section className={panelMode ? "flex min-h-0 flex-1 flex-col border-t border-border/60" : "panel flex min-h-[60vh] flex-col p-4 sm:p-6"} aria-label="Chat mit dem Finanz-Assistenten">
      <FinancialData className={panelMode ? "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6" : "flex flex-1 flex-col gap-4"} aria-live="polite">
        <Bubble role="assistant" text={intro} />
        {messages.length <= 1 && <QuickReplies items={examples} disabled={busy || !!storageError} onPick={(text) => void send(undefined, text)} />}
        {messages.map((message) => <div key={message.id} className="flex flex-col gap-2">
          <Bubble role={message.role} text={message.text} source={message.source} agent={message.agent} faded={message.status === "dismissed"}>
            {message.card && message.card.kind !== "homeoffice" && <ResultCard card={message.card} state={state} embedded
              onResult={storageError ? undefined : (result) => addResult(result, "Regel")} />}
          </Bubble>
          {message.card?.kind === "homeoffice" && <div className="pl-11">
            <HomeOfficeCard card={message.card} state={state} disabled={!!storageError} onResult={(result) => addResult(result, "Regel")} /></div>}
          {message.change && message.status !== "dismissed" && <div className="pl-11">
            <ChangeCard message={message} disabled={!!storageError} onApply={() => applyChange(message)}
              onDismiss={() => setMessage(message.id, { status: "dismissed" }, "Alles klar, ich habe nichts geändert.")}
              onUndo={() => message.change?.logId && undo(message.change.logId)} />
          </div>}
          {message.undoId && !message.draft && !message.change && message.status !== "dismissed" && <div className="flex flex-wrap items-center gap-2 pl-11">
            {message.status === "preview" ? <>
              <Button type="button" size="sm" className="min-h-10" disabled={!!storageError} onClick={() => undo(message.undoId!)}><Undo2 aria-hidden="true" className="size-4" />Rückgängig machen</Button>
              <Button type="button" size="sm" variant="ghost" className="min-h-10" onClick={() => setMessage(message.id, { status: "dismissed" })}><X aria-hidden="true" className="size-4" />Doch nicht</Button>
            </> : message.status === "applied" ? <Button type="button" size="sm" variant="ghost" className="min-h-10 text-muted-foreground" disabled={!!storageError}
              onClick={() => undo(message.undoId!)}><Undo2 aria-hidden="true" className="size-4" />Nicht merken</Button>
              : message.status === "undone" && <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Undo2 aria-hidden="true" className="size-3.5" />Rückgängig gemacht</p>}
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
          {message.suggestions && !busy && message.id === messages.at(-1)?.id &&
            <QuickReplies items={message.suggestions} disabled={!!storageError} onPick={(text) => void send(undefined, text)} />}
          {message.role === "assistant" && message.asked && !message.correcting && <div className="flex items-center gap-1 pl-11 text-2xs text-muted-foreground">
            {message.feedback ? <span className="inline-flex items-center gap-1.5 px-1 py-1">
              {message.feedback === "up" ? <ThumbsUp aria-hidden="true" className="size-3.5 text-primary" /> : <ThumbsDown aria-hidden="true" className="size-3.5" />}Danke für dein Feedback</span>
              : <>
                <button type="button" disabled={busy || !!storageError} onClick={() => giveFeedback(message, "up")} aria-label="Hilfreich" title="Hilfreich"
                  className="rounded-md p-1.5 opacity-60 transition hover:bg-muted hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"><ThumbsUp aria-hidden="true" className="size-3.5" /></button>
                <button type="button" disabled={busy || !!storageError} onClick={() => giveFeedback(message, "down")} aria-label="Nicht hilfreich" title="Nicht hilfreich – ich lerne daraus"
                  className="rounded-md p-1.5 opacity-60 transition hover:bg-muted hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"><ThumbsDown aria-hidden="true" className="size-3.5" /></button>
              </>}
          </div>}
        </div>)}
        {busy && (streaming ? <div aria-live="polite" aria-busy="true"><Bubble role="assistant" text={streaming} source="KI" agent={answering} /></div> : <Thinking />)}
        <div ref={endRef} />
      </FinancialData>
      <form onSubmit={send} className={panelMode ? "flex shrink-0 items-end gap-2 border-t border-border/60 px-4 pt-3 pb-1 sm:px-6" : "mt-5 flex items-end gap-2 border-t border-border/60 pt-4"}>
        <Label htmlFor="assistant-input" className="sr-only">Nachricht an den Finanz-Assistenten</Label>
        <textarea id="assistant-input" ref={inputRef} value={input} rows={2} maxLength={1000} disabled={busy}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); return; }
            if (event.key === "ArrowUp" && !input) {
              const last = messages.findLast((item) => item.role === "user");
              if (last) { event.preventDefault(); setInput(last.text); }
            }
          }}
          aria-keyshortcuts="ArrowUp"
          placeholder="z. B. „Was war meine größte Ausgabe dieses Jahr?“ oder „Schieb das Pickerl auf April“"
          className="min-h-11 flex-1 resize-none rounded-xl border border-input bg-background/60 px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button type="submit" className="min-h-11" disabled={busy || !input.trim() || !!storageError}><Send aria-hidden="true" className="size-4" />Senden</Button>
      </form>
      <p className={cn("mt-2 text-2xs text-muted-foreground", panelMode && "shrink-0 px-4 pb-4 sm:px-6")}>Jede Frage geht an den passenden Spezialisten (Umsätze, Verträge, Budget, Gehalt) oder in den Chat. Alle Zahlen rechnet der Code. Gespeichert wird nur nach deinem Klick, der Verlauf bleibt in deiner lokalen Datenbank.</p>
    </section>
  </div>;
}
function QuickReplies({ items, disabled, onPick }: { items: string[]; disabled: boolean; onPick: (text: string) => void }) {
  return <div className="flex flex-wrap gap-2 pl-11" aria-label="Vorschläge">
    {[...new Set(items)].map((item) => <button key={item} type="button" disabled={disabled} onClick={() => onPick(item)}
      className="assistant-reveal rounded-full border border-primary/25 bg-primary/5 px-3 py-1.5 text-left text-xs text-foreground/80 transition hover:border-primary/60 hover:bg-primary/10 hover:text-foreground disabled:opacity-50">{item}</button>)}
  </div>;
}

// Live "thinking" state: spinning ring around the avatar, shimmering status text that walks through the steps.
function Thinking() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStep((value) => Math.min(value + 1, thinkingSteps.length - 1)), 1400);
    return () => clearInterval(timer);
  }, []);
  return <div className="assistant-reveal flex items-start gap-3" role="status" aria-live="polite">
    <span className="relative flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
      <LoaderCircle aria-hidden="true" className="absolute size-8 animate-spin text-primary/60 [animation-duration:1.1s] motion-reduce:animate-none" strokeWidth={1.5} />
      <Sparkles aria-hidden="true" className="size-3.5 animate-pulse motion-reduce:animate-none" />
    </span>
    <div className="flex items-center gap-3 rounded-2xl bg-muted/50 px-4 py-2.5 text-sm">
      <span className="assistant-shimmer font-medium">Denkt nach</span>
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((dot) => <span key={dot} className="assistant-dot size-1.5 rounded-full bg-primary/70" style={{ animationDelay: `${dot * 160}ms` }} />)}
      </span>
      <span key={step} className="assistant-reveal text-xs text-muted-foreground">{thinkingSteps[step]} …</span>
    </div>
  </div>;
}

function Bubble({ role, text, source, agent, faded, children }: {
  role: "user" | "assistant"; text: string; source?: "KI" | "Regel"; agent?: AgentId; faded?: boolean; children?: React.ReactNode;
}) {
  const mine = role === "user";
  return <div className={cn("assistant-reveal flex items-start gap-3", mine && "flex-row-reverse", faded && "opacity-60")}>
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-xl", mine ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}>
      {mine ? <MessageSquareText aria-hidden="true" className="size-4" /> : <Bot aria-hidden="true" className="size-4" />}
    </span>
    <div className={cn("min-w-0 rounded-2xl px-4 py-2.5 text-sm leading-relaxed", mine ? "max-w-[80%] bg-primary text-primary-foreground" : "bg-muted/50",
      !mine && (children ? "max-w-[90%] flex-1 py-3.5" : "max-w-[80%]"))}>
      <span className="sr-only">{mine ? "Du: " : "Assistent: "}</span><span className="whitespace-pre-line">{text}</span>
      {(source === "KI" || agent && agent !== "general") && <span className="ml-2 inline-flex items-center gap-1 text-2xs text-muted-foreground">
        {source === "KI" && <Sparkles aria-hidden="true" className="size-3" />}{[agent && agent !== "general" ? agentLabel[agent] : "", source === "KI" ? "KI" : ""].filter(Boolean).join(" · ")}</span>}
      {children}
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
