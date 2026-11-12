"use client";

import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { Brain, CalendarClock, Check, CircleHelp, Columns2, History, Pencil, PiggyBank, Trash2, Undo2, X } from "lucide-react";
import { useTheme } from "next-themes";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { ChangeCard, ChangesPanel, FreeChart, MemoryPanel, ResultCard } from "@/components/assistant-cards";
import { AgentAvatar, ChatEmptyState, ComposerButton, createLiveRun, GlowFrame, HandoffAvatar, LiveAnswer, MessageActions, MessageEnter } from "@/components/assistant-chat-parts";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { HomeOfficeCard } from "@/components/homeoffice-card";
import { PageHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { contractDraftResult, executeTool, memoryValue, parseMemory, type AgentHints, type AgentResult } from "@/lib/assistant/agent";
import { balances } from "@/lib/assistant/accounts";
import { giroTopUp, topUpText } from "@/lib/assistant/funds";
import { readAnswerStream } from "@/lib/ai/answer-stream";
import { weeklyBriefing } from "@/lib/assistant/answers";
import { draftSuggestions, lastDay, mergeDraft, missingField, missingQuestion, parseAssistantMessage } from "@/lib/assistant/intent";
import { extractMemories } from "@/lib/assistant/memory";
import { smallTalk, starterSuggestions } from "@/lib/assistant/smalltalk";
import { applyOperations, OperationError, recordChange, recordCreation, undoChange } from "@/lib/assistant/operations";
import { cancelDraft, confirmDraft, continueContractDraft, contractStepReply, leavesDraft, refusesDraft } from "@/lib/assistant/contract-draft";
import { buildPlannedOneOff, buildSavingsGoal, checkAffordability, goalExtraOperation, monthBasis, planningHorizon, planSavingsGoal, type Affordability } from "@/lib/assistant/plan";
import { changingTools, conversationRoute, converseOn, evidenceText, freshPart } from "@/lib/assistant/conversation";
import { detectTool, isAssistantTool, isDraftTool, type AssistantTool } from "@/lib/assistant/tools";
import {
  agentLabel, asksForWebSearch, isAgentId, isRouteVia, routeByRules, routeBySignals, toolOwner, unsureAnswer, wantsKnowledge, wantsWebSearch, type AgentId, type RouteVia,
} from "@/lib/assistant/orchestrator";
import {
  avoidedSources, correctionNotes, correctsAnswer, helpedReply, isWebAnswer, LEARNED_TOOL, learnedCandidates, learnWebAnswer, noteWebAnswer, recallConfirmed,
  rejectWebAnswer, searchesAgain, WEB_FIX_TOOL, WEB_TOOL, webEntryId,
} from "@/lib/assistant/web-learning";
import { webEvidence, webFallbackAnswer, webLinks, type WebSearchResult } from "@/lib/web/web-answer";
import { buildFeedbackEntry, type FeedbackEntry } from "@/lib/assistant/feedback";
import { failedAnswer, lookupTool, toolCall } from "@/lib/assistant/orchestrator-info";
import { statusFor, workStatus, type WorkActivity } from "@/lib/assistant/status";
import { figuresOf, onlyAssistantChanged, parseAssistantChanges } from "@/lib/assistant-state";
import { confidentHit, knowledgeEvidence, localKnowledgeAnswer } from "@/lib/knowledge-base/query";
import type { LocalKnowledgeHit, LocalKnowledgeSearch } from "@/lib/knowledge-base/types";
import { agentEvidence, agentFacts, agentSuggestions } from "@/lib/assistant/specialist-context";
import { currentAssistantContext, type AssistantPageContext } from "@/lib/assistant-context";
import { useDashboardExtras } from "@/components/dashboard/use-dashboard-extras";
import { currentNavItem } from "@/components/shell/navigation";
import { currenciesIn, type MarketSnapshot } from "@/lib/assistant/market";
import { findKnowledge, isStale, knowledgeListQuestion, knowledgeTopics, learnPhrase, matchPhrase, relevantKnowledge, storeKnowledge } from "@/lib/assistant/knowledge";
import { resolveFollowUp, resolvePronoun } from "@/lib/assistant/followup";
import { splitQuestion } from "@/lib/assistant/combined";
import { clarifyChoices } from "@/lib/assistant/intents";
import { explainAgain, fixedReply, topicClarify, type DeviceSetting, type FixedReply } from "@/lib/assistant/fixed-replies";
import { useInteractionSoundsControl } from "@/components/interaction-sounds";
import { setNotificationsEnabled } from "@/components/pwa-notifications";
import { getSecuritySnapshot, setSecurityMode } from "@/lib/security-mode";
import { detectContracts } from "@/lib/contracts";
import { aliasTeaching, applyAliases, correction, countAliases, learnAlias, openGaps, pickName, recordGap, rephrases, resolveGap, unknownTarget, unlearnPhrase } from "@/lib/assistant/learning";
import { addMonths, type Dashboard } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { preserveGoalOpeningBalances, savingsGoals } from "@/lib/goals";
import { plannedOccurrences } from "@/lib/planned-one-offs";
import {
  appStateSchema, assistantDraftSchema, assistantMessageSchema, extraSourceSchema, MAX_ASSISTANT_MESSAGES,
  type AppState, type AssistantDraft, type AssistantKnowledge, type AssistantMessage, type AssistantOperation, type AssistantToolCall, type WebLinkEntry,
} from "@/lib/types";
import { cn } from "@/lib/utils";

// Tools whose answer depends only on the message text; phrasings for these are learned when the model understood them.
const learnableTools: AssistantTool[] = ["query", "accounts", "amex", "budget", "briefing", "check", "coach", "depot", "market", "knowledge", "tax", "homeoffice", "explain", "memory", "changes"];
type KnowledgeHit = { topic: string; title: string; text: string; url: string; source: string };

// Shown before the first own message; each one goes straight to a tool.
const starterPrompts: { text: string; agent: AgentId }[] = [
  { text: "Was habe ich diesen Monat ausgegeben?", agent: "transactions" }, { text: "Zeige mir meine Verträge", agent: "contracts" },
  { text: "Wie viel ist noch frei?", agent: "budget" },
];
const extraSources: string[] = [...extraSourceSchema.options];
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
// A request ends after its own time limit or when the user stops the answer, whichever comes first.
const withTimeout = (ms: number, signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
// Lets the browser paint (the question, the orb, the next step) before synchronous work continues.
const afterPaint = () => new Promise<void>((resolve) => {
  if (typeof requestAnimationFrame !== "function" || document.hidden) {
    setTimeout(resolve, 0);
    return;
  }
  requestAnimationFrame(() => setTimeout(resolve, 0));
});
// Contract names for one-word questions; detection scans the whole ledger, so it runs once per set of figures.
const contractNameCache = new WeakMap<AppState, { asOf: string; names: string[] }>();
function contractNames(state: AppState, asOf: string) {
  const figures = figuresOf(state);
  const cached = contractNameCache.get(figures);
  if (cached?.asOf === asOf) return cached.names;
  const names = detectContracts(state, asOf).map((contract) => contract.name);
  contractNameCache.set(figures, { asOf, names });
  return names;
}
// Runs `work` once the browser is idle, at the latest after `timeout` ms.
function whenIdle(work: () => void, timeout: number) {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(work, { timeout });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(work, Math.min(timeout, 400));
  return () => clearTimeout(id);
}
// What the user is looking at; pages add filters and selections, otherwise the route is enough.
function pageContext(): AssistantPageContext | null {
  const published = currentAssistantContext();
  if (published) return published;
  if (typeof window === "undefined") return null;
  const route = window.location.pathname;
  return { route, title: currentNavItem(route)?.label ?? "Finanzblick" };
}
const timestamp = () => Date.now();
// Screen, language, color scheme and motion setting for the feedback file; nothing that identifies the device.
function clientInfo(theme?: string): FeedbackEntry["client"] {
  if (typeof window === "undefined") return undefined;
  return { viewport: `${window.innerWidth}x${window.innerHeight}`, ...(navigator.language ? { language: navigator.language.slice(0, 20) } : {}),
    ...(theme ? { theme: theme.slice(0, 10) } : {}), reducedMotion: !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches };
}

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
  const { state: stored, dashboard, update, storageError, ready } = useFinance();
  const { setTheme, resolvedTheme } = useTheme();
  const sounds = useInteractionSoundsControl();
  // Settings of this device (notifications, sounds, privacy screen) are switched right away; a missing permission is said honestly.
  const deviceReply = (reply: FixedReply, device: DeviceSetting): AgentResult => {
    const settings: AgentResult["card"] = { kind: "answer", title: "Einstellungen", lines: [], page: { label: "Einstellungen öffnen", href: "/einstellungen" } };
    if (device.notifications !== undefined) {
      const result = setNotificationsEnabled(device.notifications);
      if (result === "permission") return { text: "Dafür muss dein Browser Benachrichtigungen erst erlauben – das geht nur mit einem Klick in den Einstellungen unter Benachrichtigungen.", card: settings };
      if (result === "unsupported") return { text: "Dieser Browser unterstützt keine Benachrichtigungen.", card: settings };
    }
    if (device.sounds !== undefined) {
      if (!sounds) return { text: "Die Interaktionsklänge stellst du unter Einstellungen → Darstellung ein.", card: settings };
      sounds.setEnabled(device.sounds, new Event("assistant"));
    }
    if (device.privacy !== undefined) {
      if (getSecuritySnapshot().preference === "off")
        return { text: "Der Sichtschutz ist in den Einstellungen ausgeschaltet. Schalte ihn unter Einstellungen → Sicherheit ein, dann kann ich ihn hier an- und ausmachen.", card: settings };
      setSecurityMode(device.privacy);
    }
    return { text: reply.text, card: settings };
  };
  const extras = useDashboardExtras();
  // New messages and what a run learned (phrasings, aliases, memories) collect here while the chat is in use; the app's state
  // takes them in one step once the chat is idle, so the pages behind it do not re-render and save for every single message.
  // Chat changes are kept as steps and replayed onto the stored chat, so messages that arrived meanwhile (sync) stay.
  const [localChat, setLocalChat] = useState<AssistantMessage[] | null>(null);
  const localChatRef = useRef<AssistantMessage[] | null>(null);
  const chatChanges = useRef<((items: AssistantMessage[]) => AssistantMessage[])[]>([]);
  const pendingSteps = useRef<((current: AppState) => AppState)[]>([]);
  const [pendingVersion, setPendingVersion] = useState(0);
  // What the chat works with: the stored state plus everything learned but not handed over yet.
  const state = useMemo(() => pendingSteps.current.reduce((next, step) => step(next), stored), [stored, pendingVersion]);
  const globalChat = useRef(stored.assistantChat);
  useLayoutEffect(() => { globalChat.current = stored.assistantChat; }, [stored.assistantChat]);
  const mounted = useRef(true);
  const messages = localChat ?? state.assistantChat ?? [];
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: sends once per prompt; the latest send() and state are read at that moment
  useEffect(() => {
    if (!prompt?.send || !prompt.text || !ready || storageError || autoSent.current === prompt.at) return;
    autoSent.current = prompt.at;
    void send(undefined, prompt.text);
  }, [prompt?.at, prompt?.send, ready, storageError]);
  const [busy, setBusy] = useState(false);
  // Step and streamed words of the running answer (only the live row subscribes to them), and the handle that stops it.
  const [live] = useState(createLiveRun);
  const setStatus = live.setStatus;
  const activeRun = useRef<AbortController | null>(null);
  const running = useRef(false);
  const streamed = useRef<string | undefined>(undefined);
  const setStreaming = (text?: string) => { streamed.current = text; live.setText(text); };
  // The live steps of the running answer, attached to the answer for the feedback file.
  const runSteps = useRef<string[]>([]);
  useEffect(() => live.subscribe(() => {
    const step = live.get().status?.text;
    if (running.current && step && runSteps.current.at(-1) !== step && runSteps.current.length < 12) runSteps.current.push(step.slice(0, 80));
  }), [live]);
  const takeSteps = () => {
    const steps = runSteps.current;
    runSteps.current = [];
    return running.current && steps.length ? { steps } : {};
  };
  // The tools the running answer called (lookups, web search); the next answer it writes takes them, plus its own tool.
  const runCalls = useRef<AssistantToolCall[]>([]);
  const noteCall = (call: AssistantToolCall) => {
    if (running.current && runCalls.current.length < 8) runCalls.current.push(call);
  };
  const takeCalls = (own?: AssistantToolCall) => {
    const noted = running.current ? runCalls.current : [];
    runCalls.current = [];
    const calls = own && !noted.some((call) => call.tool === own.tool) ? [...noted, own] : noted;
    return calls.length ? { calls: calls.slice(-8) } : {};
  };
  // The answer whose feedback comment field is open.
  const [commentFor, setCommentFor] = useState<string>();
  // The question shows the moment it is sent; the stored message takes its place once routing has run.
  const [echo, setEcho] = useState<{ text: string; at: number }>();
  // Answers that came out of a run: their bot takes over from the orb, and an answer that was streamed does not enter twice.
  const handoffs = useRef(new Map<string, { activity: WorkActivity; streamed: boolean }>());
  // Messages that were already there when the chat opened stay still; new ones spring in.
  const [initialIds] = useState(() => new Set((state.assistantChat ?? []).map((item) => item.id)));
  const [editing, setEditing] = useState<string>();
  const [panel, setPanel] = useState<"changes" | "memory">();
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const briefed = useRef(false);
  const marketCache = useRef(new Map<string, { at: number; value: MarketSnapshot }>());
  const started = !!echo || messages.some((message) => message.role === "user");
  // The newest answer's bot is awake; a result waiting for "Bestätigen" glows until it is decided.
  const newest = busy ? undefined : messages.findLast((message) => message.role === "assistant");
  const liveId = newest?.id;
  const pendingId = newest?.status === "preview" && (newest.change || newest.draft) ? newest.id : undefined;
  // Before the first question the greeting stays in view; afterwards the newest message does.
  useEffect(() => { if (started) endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [started, messages.length, busy, echo]);

  // Everything collected locally goes into the app's state first, then `updater`; nothing collected is lost or reordered.
  const writeGlobal = useCallback((updater?: (current: AppState) => AppState) => {
    const changes = chatChanges.current;
    const steps = pendingSteps.current;
    if (!changes.length && !steps.length && !updater) return;
    chatChanges.current = [];
    pendingSteps.current = [];
    localChatRef.current = null;
    if (changes.length) setLocalChat(null);
    update((current) => {
      const chatted = changes.length ? { ...current, assistantChat: changes.reduce((items, change) => change(items), current.assistantChat ?? [])
        .slice(-MAX_ASSISTANT_MESSAGES) } : current;
      const collected = steps.reduce((next, step) => step(next), chatted);
      return updater ? updater(collected) : collected;
    });
  }, [update]);
  const flush = useCallback(() => writeGlobal(), [writeGlobal]);
  // Leaving or reloading the page: committed and saved synchronously, before the page is gone.
  const persistNow = useCallback(() => {
    if (chatChanges.current.length || pendingSteps.current.length) flushSync(flush);
  }, [flush]);
  useEffect(() => {
    if (busy || !chatChanges.current.length && !pendingSteps.current.length) return;
    // A moment after an answer, so the bot's entrance runs smoothly before the pages behind the chat update.
    let cancel = () => {};
    const timer = setTimeout(() => { cancel = whenIdle(flush, 2000); }, 1200);
    return () => {
      clearTimeout(timer);
      cancel();
    };
  }, [busy, localChat, pendingVersion, flush]);
  // The first question needs the contract names; they are found while the chat is still idle.
  useEffect(() => whenIdle(() => { contractNames(state, state.settings.asOf); }, 4000), [state]);
  // Closing the chat or leaving the page hands everything over at once; a run that is still going writes directly afterwards.
  useEffect(() => {
    mounted.current = true;
    const away = () => { if (document.visibilityState === "hidden") persistNow(); };
    window.addEventListener("pagehide", persistNow);
    window.addEventListener("beforeunload", persistNow);
    document.addEventListener("visibilitychange", away);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", persistNow);
      window.removeEventListener("beforeunload", persistNow);
      document.removeEventListener("visibilitychange", away);
      flush();
    };
  }, [flush, persistNow]);
  const writeLocal = (change: (items: AssistantMessage[]) => AssistantMessage[]) => {
    if (!mounted.current) {
      update((current) => ({ ...current, assistantChat: change(current.assistantChat ?? []).slice(-MAX_ASSISTANT_MESSAGES) }));
      return;
    }
    const next = change(localChatRef.current ?? globalChat.current ?? []).slice(-MAX_ASSISTANT_MESSAGES);
    chatChanges.current.push(change);
    localChatRef.current = next;
    setLocalChat(next);
  };
  // What a running answer learns (phrasings, aliases, knowledge, memories) is stored together with its chat afterwards;
  // the next question and "Nicht merken" already see it.
  const learn = (step: (current: AppState) => AppState) => {
    if (running.current && mounted.current) pendingSteps.current.push(step);
    else writeGlobal(step);
  };
  const save = (change: (items: AssistantMessage[]) => AssistantMessage[], also?: (current: AppState) => AppState) => {
    if (!also) return writeLocal(change);
    writeGlobal((current) => ({ ...also(current), assistantChat: change(current.assistantChat ?? []).slice(-MAX_ASSISTANT_MESSAGES) }));
  };
  const noteHandoff = (id: string) => {
    if (running.current) handoffs.current.set(id, { activity: live.get().status?.activity ?? "composing", streamed: !!streamed.current?.trim() });
  };
  const setMessage = (id: string, patch: Partial<AssistantMessage>, reply?: string, also?: (current: AppState) => AppState) =>
    save((items) => [...items.map((item) => item.id === id ? { ...item, ...patch } : item),
      ...(reply ? [{ id: newId(), role: "assistant" as const, text: reply, at: Date.now() }] : [])], also);
  const addDraftMessage = (draft: AssistantDraft, source: AssistantMessage["source"] = "Regel", run: Pick<AssistantMessage, "via" | "ms"> = {}) => {
    const question = missingQuestion(draft);
    const suggestions = draftSuggestions(draft, state.settings.asOf);
    const id = newId();
    noteHandoff(id);
    const steps = takeSteps();
    const calls = takeCalls(toolCall(draft.action));
    save((items) => [...items.map((item) => item.draft && (item.status === "question" || item.status === "preview") ? { ...item, status: "dismissed" as const } : item),
      { id, role: "assistant", text: question ?? previewText(draft), at: Date.now(), draft, status: question ? "question" : "preview", source, agent: toolOwner[draft.action],
        ...(suggestions ? { suggestions } : {}), ...run, ...steps, ...calls }]);
  };
  const addResult = (result: AgentResult, source: AssistantMessage["source"],
    meta: Pick<AssistantMessage, "tool" | "asked" | "correcting" | "clarify" | "agent" | "via" | "ms" | "sources" | "links" | "knowledgeId"> = {}) => {
    const suggestions = result.choices?.length ? result.choices : result.suggestions;
    const message = {
      id: newId(), role: "assistant" as const, text: result.text.slice(0, 2000), at: Date.now(), source,
      ...(result.card ? { card: result.card } : {}), ...(result.change ? { change: result.change } : {}),
      ...(result.undoId ? { undoId: result.undoId } : {}), ...(result.contractDraft ? { contractDraft: result.contractDraft } : {}),
      ...(result.change || result.undoId ? { status: "preview" as const } : result.contractDraft ? { status: "question" as const } : {}),
      ...(suggestions?.length ? { suggestions: [...new Set(suggestions)].map((item) => item.slice(0, 120)).slice(0, 4) } : {}),
      ...(meta.tool ? { tool: meta.tool.slice(0, 40) } : {}), ...(meta.asked ? { asked: meta.asked.slice(0, 1000) } : {}), ...(meta.agent ? { agent: meta.agent } : {}),
      ...(meta.via ? { via: meta.via } : {}), ...(meta.ms !== undefined ? { ms: Math.max(0, Math.round(meta.ms)) } : {}),
      ...(meta.sources?.length ? { sources: meta.sources.map((item) => item.slice(0, 80)).slice(0, 5) } : {}),
      ...(meta.links?.length ? { links: meta.links.slice(0, 4) } : {}), ...(meta.knowledgeId ? { knowledgeId: meta.knowledgeId } : {}),
      ...(meta.correcting ? { correcting: meta.correcting.slice(0, 1000) } : {}),
      ...(meta.clarify && result.choices?.length ? { clarify: meta.clarify.slice(0, 1000) } : {}),
      ...takeSteps(),
      ...takeCalls(meta.tool ? toolCall(meta.tool, { ok: !failedAnswer(result.text), change: result.change }) : undefined),
    };
    const parsed = assistantMessageSchema.safeParse(message);
    noteHandoff(message.id);
    save((items) => [...items, parsed.success ? parsed.data : { id: message.id, role: "assistant", text: message.text, at: message.at }]);
  };
  const knownNames = () => [...savingsGoals(state).filter((goal) => !goal.completedAt).map((goal) => goal.name.slice(0, 80)).slice(0, 50),
    ...new Set(plannedOccurrences(state.plannedOneOffs).filter((item) => item.date.slice(0, 7) >= dashboard.currentMonth).map((item) => item.name.slice(0, 100)))].slice(0, 110);

  // Every rating goes into the feedback file with as much context as possible (question, answer, route, steps, sources, chat).
  async function storeFeedback(message: AssistantMessage, success: string) {
    if (!message.feedback || !message.feedbackId) return;
    try {
      const entry = buildFeedbackEntry({ id: message.feedbackId, message, thread: messages, rating: message.feedback === "up" ? "like" : "dislike",
        comment: message.feedbackComment, page: pageContext(), asOf: state.settings.asOf, client: clientInfo(resolvedTheme) });
      const response = await fetch("/api/assistant-feedback", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify(entry), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      toast.success(success);
    } catch {
      toast.error("Das Feedback konnte gerade nicht gespeichert werden. Bitte später noch einmal versuchen.");
    }
  }

  // 👍 reinforces how the question was understood; 👎 forgets it and opens the comment field. A web answer is kept or rejected.
  // `change`: "Das war falsch" in the chat turns an earlier 👍 into 👎 (same entry in the feedback file).
  function giveFeedback(message: AssistantMessage, value: "up" | "down", options: { change?: boolean } = {}) {
    if (message.feedback === value || message.feedback && !options.change) {
      if (value === "down") setCommentFor(message.id);
      return;
    }
    const asked = message.asked;
    const feedbackId = message.feedbackId ?? newId();
    const web = !!asked && isWebAnswer(message);
    const answer = web ? { id: newId(), question: asked, text: message.text, links: message.links, target: message.knowledgeId } : undefined;
    const tool = message.tool && isAssistantTool(message.tool) ? message.tool : undefined;
    const teaches = !!asked && !message.correcting && !web;
    const learnable = teaches && !!tool && learnableTools.includes(tool) && detectTool(asked, knownNames()) !== tool;
    // A rejected web answer remembers its knowledge entry, so a comment reaches exactly that one as a correction.
    const knowledgeId = answer && value === "down" ? webEntryId(state.assistantKnowledge, answer) : undefined;
    const rated: AssistantMessage = { ...message, feedback: value, feedbackId, ...(knowledgeId ? { knowledgeId } : {}) };
    writeGlobal((current) => {
      const chat = (current.assistantChat ?? []).map((item) => item.id === message.id ? { ...item, ...rated } : item);
      if (answer) return { ...current, assistantChat: chat,
        assistantKnowledge: value === "up" ? learnWebAnswer(current.assistantKnowledge, answer) : rejectWebAnswer(current.assistantKnowledge, answer) };
      if (!teaches) return { ...current, assistantChat: chat };
      if (value === "up") return { ...current, assistantChat: chat,
        assistantPhrases: learnable ? learnPhrase(current.assistantPhrases, asked, tool!) : current.assistantPhrases,
        assistantGaps: tool ? resolveGap(current.assistantGaps, asked, tool) : current.assistantGaps };
      return { ...current, assistantChat: chat, assistantPhrases: unlearnPhrase(current.assistantPhrases, asked), assistantGaps: recordGap(current.assistantGaps, asked) };
    });
    if (value === "down") setCommentFor(message.id);
    void storeFeedback(rated, value === "up" && web ? "Feedback gespeichert – nächstes Mal antworte ich ohne neue Suche" : "Feedback gespeichert");
  }

  // The comment completes the same entry in the feedback file; on a rejected web answer it is also kept as a correction.
  function commentFeedback(message: AssistantMessage, comment: string) {
    const current = messages.find((item) => item.id === message.id) ?? message;
    const text = comment.trim().slice(0, 2000);
    setCommentFor(undefined);
    if (!text || !current.feedback || !current.feedbackId) return;
    const commented: AssistantMessage = { ...current, feedbackComment: text };
    const correction = current.feedback === "down" && current.asked && isWebAnswer(current) ? { question: current.asked, target: current.knowledgeId } : undefined;
    writeGlobal((next) => ({ ...next,
      assistantChat: (next.assistantChat ?? []).map((item) => item.id === current.id ? { ...item, feedbackComment: text } : item),
      ...(correction ? { assistantKnowledge: noteWebAnswer(next.assistantKnowledge, correction, text) } : {}) }));
    void storeFeedback(commented, "Kommentar gespeichert");
  }

  // Self-improvement: questions it could not answer before are tried again in the background, e.g. once the local model is back.
  const retried = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once when the data is ready, guarded by retried
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
      writeGlobal((current) => solved.reduce((next, item) => ({ ...next,
        assistantPhrases: learnPhrase(next.assistantPhrases, item.text, item.tool), assistantGaps: resolveGap(next.assistantGaps, item.text, item.tool) }), current));
      toast.success(`Selbst nachgelernt · ${solved.length === 1 ? "1 offene Frage" : `${solved.length} offene Fragen`}`);
    })();
  }, [ready, storageError]);

  // Checks the change against the current snapshot first, so the provider never receives an invalid state; a change of only the
  // assistant's own data (memory, change log) checks just that. `later`: inside a running answer it is stored with its chat.
  const commit = (run: (current: AppState) => AppState, chat?: (items: AssistantMessage[]) => AssistantMessage[], later = false) => {
    try {
      const next = run(state);
      const valid = onlyAssistantChanged(state, next) ? (() => { try { parseAssistantChanges(state, next); return true; } catch { return false; } })()
        : appStateSchema.safeParse(next).success;
      if (!valid) throw new OperationError("Die Änderung passt nicht zu deinen Daten.");
    } catch (error) {
      toast.error(errorText(error));
      return false;
    }
    if (later && running.current && mounted.current) {
      learn((current) => { try { return run(current); } catch { return current; } });
      if (chat) writeLocal(chat);
      return true;
    }
    writeGlobal((current) => {
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

  // `said`: the typed confirmation ("Ja"), shown in the chat together with a short reply.
  function applyChange(message: AssistantMessage, said?: string) {
    const change = message.change!;
    const logId = newId();
    const at = timestamp();
    const tool = message.tool ?? message.calls?.at(-1)?.tool;
    const typed: AssistantMessage[] = said ? [{ id: newId(), role: "user", text: said, at },
      { id: newId(), role: "assistant", text: `Erledigt: ${change.title}. Rückgängig geht jederzeit über den Knopf oben.`.slice(0, 2000), at: at + 1, source: "Regel",
        ...(message.agent ? { agent: message.agent } : {}), ...(tool ? { calls: [toolCall(tool, { change })] } : {}) }] : [];
    if (commit((current) => recordChange(current, applyOperations(current, change.operations, { asOf: current.settings.asOf, now: at }), { id: logId, at, title: change.title }),
      (items) => [...items.map((item) => item.id === message.id ? { ...item, status: "applied" as const, change: { ...change, logId } } : item), ...typed])) toast.success("Übernommen");
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
    const calls = takeCalls(toolCall("remember"));
    commit((current) => recordChange(current, applyOperations(current, operations, { asOf: current.settings.asOf, now: at }), { id: logId, at, title: text }),
      (items) => [...items, { id: newId(), role: "assistant", text, at, status: "applied", undoId: logId, source: "Regel", agent: "general", ...calls }], true);
  }

  // Proactive start: one weekly overview per day, built only from your own data.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once when the data is ready, guarded by briefed
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
  }, [ready, storageError]);

  // Anything no tool covers gets a short answer from the chosen agent, built only from its own facts and computed evidence.
  async function freeAnswer(question: string, history: { role: "user" | "assistant"; text: string }[], agent: AgentId, evidence?: string, signal?: AbortSignal,
    step = workStatus.answer) {
    try {
      setStatus({ ...step, agent });
      const facts = agentFacts(agent, state, dashboard, state.settings.asOf, question);
      // Knowledge learned earlier is used here too, so free answers can explain terms.
      const known = relevantKnowledge(state.assistantKnowledge, question);
      if (known.length) Object.assign(facts, { wissen: known.map((entry) => ({ begriff: entry.title, erklaerung: entry.text.slice(0, 600), quelle: entry.source })) });
      // The general chat keeps the conversation; a specialist only needs the last exchange.
      const context = agent === "general" ? history : history.slice(-2);
      const ask = async (past: typeof history) => {
        const response = await fetch("/api/ai/answer?stream=1", {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal,
          body: JSON.stringify({ question, history: past, facts, agent, ...(evidence ? { evidence } : {}) }),
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
      };
      const text = await ask(context);
      // Sentences copied from the previous answer are dropped; a full copy is asked once more without the history.
      const previous = context.findLast((item) => item.role === "assistant")?.text;
      if (!text || !context.length) return text;
      const fresh = freshPart(text, previous);
      if (fresh) return fresh;
      setStreaming(undefined);
      return await ask([]) ?? text;
    } catch {
      if (!signal?.aborted) setStreaming(undefined);
      return undefined;
    }
  }

  // Public market data from the finanzblick-web MCP server; only currency codes leave the browser, never personal data.
  async function loadMarket(text: string, signal?: AbortSignal): Promise<MarketSnapshot | undefined> {
    const codes = currenciesIn(text).sort().join(",");
    const cached = marketCache.current.get(codes);
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) {
      noteCall(toolCall(lookupTool.market));
      return cached.value;
    }
    let value: MarketSnapshot | undefined;
    try {
      const response = await fetch(`/api/market?currencies=${encodeURIComponent(codes)}`, { cache: "no-store", signal: withTimeout(15000, signal) });
      if (response.ok) {
        value = await response.json() as MarketSnapshot;
        marketCache.current.set(codes, { at: Date.now(), value });
      }
    } catch {
      // Unreachable: the values from earlier stay.
    }
    if (!signal?.aborted) noteCall(toolCall(lookupTool.market, { ok: !!value }));
    return value ?? cached?.value;
  }

  // Terms are answered from learned knowledge; unknown or outdated ones are looked up once via the MCP server and remembered.
  async function loadKnowledge(text: string, names: string[], signal?: AbortSignal) {
    const topics = knowledgeTopics(text, names, true);
    const found: AssistantKnowledge[] = [], fresh: AssistantKnowledge[] = [], used: string[] = [];
    let offline = false;
    for (const topic of topics) {
      const stored = findKnowledge(state.assistantKnowledge, topic);
      if (stored && !isStale(stored)) { found.push(stored); used.push(stored.id); continue; }
      try {
        const response = await fetch(`/api/knowledge?q=${encodeURIComponent(topic)}`, { cache: "no-store", signal: withTimeout(15000, signal) });
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
    if (fresh.length || used.length) learn((current) => ({ ...current, assistantKnowledge: storeKnowledge(current.assistantKnowledge, fresh, used) }));
    if (topics.length && !signal?.aborted) noteCall(toolCall(lookupTool.lexicon, { ok: !offline, empty: !found.length }));
    return { found, fresh: fresh.map((entry) => entry.id), offline };
  }

  // The local finance knowledge (hybrid search on the server, no internet); nothing found or no answer means no extra context.
  // Answers the user confirmed earlier are searched together with the curated knowledge.
  async function searchLocalKnowledge(question: string, signal?: AbortSignal): Promise<LocalKnowledgeSearch | undefined> {
    const learned = learnedCandidates(state.assistantKnowledge);
    setStatus((current) => ({ ...(learned.length ? workStatus.recall : workStatus.knowledge), agent: current?.agent }));
    try {
      const response = await fetch("/api/ai/knowledge", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ question: question.slice(0, 500), ...(learned.length ? { learned } : {}) }), signal: withTimeout(5000, signal) });
      const result = response.ok ? await response.json() as LocalKnowledgeSearch : undefined;
      noteCall(toolCall(lookupTool.knowledge, { ok: !!result, empty: !Array.isArray(result?.hits) || !result.hits.length }));
      return result;
    } catch {
      if (!signal?.aborted) noteCall(toolCall(lookupTool.knowledge, { ok: false }));
      return undefined;
    }
  }

  // The automatic web search: only search words leave the device; sources the user rejected for this question are skipped.
  async function searchTheWeb(question: string, signal?: AbortSignal): Promise<WebSearchResult | undefined> {
    setStatus((current) => ({ ...workStatus.web, agent: current?.agent }));
    try {
      const avoid = avoidedSources(state.assistantKnowledge, question);
      const response = await fetch("/api/ai/web-search", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ question: question.slice(0, 500), ...(avoid.length ? { avoid } : {}) }), signal: withTimeout(15000, signal) });
      const result = response.ok ? await response.json() as WebSearchResult : undefined;
      noteCall(toolCall(WEB_TOOL, { ok: !!result, empty: !result?.sources?.length }));
      return result?.sources?.length ? result : undefined;
    } catch {
      if (!signal?.aborted) noteCall(toolCall(WEB_TOOL, { ok: false }));
      return undefined;
    }
  }

  // The model compares the sources; without it the most official source speaks for itself.
  async function answerFromWeb(question: string, history: { role: "user" | "assistant"; text: string }[], result: WebSearchResult, signal?: AbortSignal) {
    const notes = correctionNotes(state.assistantKnowledge, question);
    const hint = notes.length ? `Hinweis des Nutzers zu früheren Antworten auf diese Frage: ${notes.join(" ")}` : "";
    const evidence = [webEvidence(result, hint ? 1450 - hint.length - 2 : 1450), hint].filter(Boolean).join("\n\n").slice(0, 1500);
    const said = await freeAnswer(question, history, "general", evidence, signal, workStatus.compare);
    return { text: said ?? webFallbackAnswer(result) ?? "", byModel: !!said, links: webLinks(result) };
  }

  // A confirmed answer from earlier: shown right away and counted as used, so often asked questions stay at the top.
  function learnedAnswer(hit: LocalKnowledgeHit): { result: AgentResult; links?: WebLinkEntry[]; knowledgeId?: string } {
    const entry = state.assistantKnowledge?.find((item) => item.id === hit.learned?.entryId);
    if (entry) learn((current) => ({ ...current, assistantKnowledge: storeKnowledge(current.assistantKnowledge, [], [entry.id]) }));
    return { result: { text: entry?.text ?? hit.text, suggestions: ["Such im Internet nach Neuem dazu", ...agentSuggestions.general.slice(0, 2)] }, links: entry?.links,
      knowledgeId: entry?.id };
  }

  // "Töne an" or "Lösch die Buchung vom 3.10." while a form asks for an amount: a command of its own, not the answer.
  function deviceCommand(value: string) {
    const fixed = fixedReply(value);
    return !!(fixed?.device || fixed?.theme);
  }
  // Only tools whose commands never read like an answer to a form ("Ich zahle monatlich 250 €" stays with the form).
  function otherCommand(value: string) {
    if (deviceCommand(value)) return true;
    const tool = detectTool(value, knownNames());
    return !!tool && value.trim().split(/\s+/).length >= 3 && ["booking", "rule", "settings", "payroll_action", "account_rule", "undo", "reminder", "remember", "forget"].includes(tool);
  }

  // A contract created step by step: the answer fills the open step; "Ja" on the preview saves it, "Abbrechen" drops it.
  async function continueContract(message: AssistantMessage, text: string): Promise<boolean> {
    const draft = message.contractDraft!;
    const asOf = state.settings.asOf;
    const startedAt = Date.now();
    const userMessage: AssistantMessage = { id: newId(), role: "user", text, at: Date.now() };
    if (cancelDraft(text)) {
      save((items) => [...items.map((item) => item.id === message.id ? { ...item, status: "dismissed" as const } : item), userMessage,
        { id: newId(), role: "assistant", text: "Alles klar, ich lege keinen Vertrag an.", at: Date.now(), source: "Regel", agent: "contracts" }]);
      return true;
    }
    if (message.status === "preview" && message.change && confirmDraft(text)) {
      applyChange(message, text);
      return true;
    }
    // A new question, a greeting or another topic in between is answered normally; the contract stays where it was.
    if (/\?\s*$/.test(text) || leavesDraft(text, draft.step === "name") || deviceCommand(text)) return false;
    const next = continueContractDraft(draft, text, state, asOf);
    if (!next.understood && (detectTool(text, knownNames()) || text.split(/\s+/).length > 5)) return false;
    setBusy(true);
    save((items) => [...items.map((item) => item.id !== message.id ? item : item.status === "preview" ? { ...item, status: "dismissed" as const }
      : { ...item, status: undefined }), userMessage]);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 450 - (Date.now() - startedAt))));
    // At the preview the change stays confirmable; a plain "Nein" asks what to change instead of failing.
    const refused = draft.step === "preview" && refusesDraft(text);
    const result = next.understood || draft.step === "preview" ? contractDraftResult(state, next.understood ? next.draft : draft, asOf)
      : { ...contractStepReply(draft, state, asOf), contractDraft: draft };
    const unclear = refused ? "Was soll ich ändern? Sag es einfach, zum Beispiel „Betrag 12 €“ oder „Kündigungsfrist 1 Monat“ – oder „Abbrechen“."
      : `Das habe ich nicht ganz verstanden. ${result.text}`;
    addResult(next.understood ? result : { ...result, text: unclear }, "Regel",
      { tool: "contract_new", agent: "contracts", via: "rule", ms: Date.now() - startedAt });
    setBusy(false);
    return true;
  }

  // `without`: messages to leave out of this turn, e.g. the answer that is being regenerated.
  async function send(event?: FormEvent, preset?: string, options: { without?: string[] } = {}) {
    event?.preventDefault();
    const text = (preset ?? input).trim().slice(0, 1000);
    if (!text || busy || running.current || storageError) return;
    running.current = true;
    // The question, the orb and the stop button show at once; routing and tools start once the browser has painted them.
    // A suggestion leaves what was typed in the meantime; a question sent from the input (or prefilled there) clears it.
    if (preset === undefined || input.trim() === text) setInput("");
    const controller = new AbortController();
    activeRun.current = controller;
    setEcho({ text, at: Date.now() });
    setBusy(true);
    live.reset();
    runSteps.current = [];
    runCalls.current = [];
    setCommentFor(undefined);
    setStatus(workStatus.read);
    await afterPaint();
    try {
      await answer(text, options, controller.signal);
    } finally {
      running.current = false;
      activeRun.current = null;
      if (pendingSteps.current.length) setPendingVersion((value) => value + 1);
      streamed.current = undefined;
      live.reset();
      setEcho(undefined);
      setBusy(false);
      // A clicked suggestion disappears with the answer: mouse and keyboard continue in the input, touch screens keep the keyboard closed.
      void afterPaint().then(() => {
        const active = document.activeElement;
        if ((!active || active === document.body) && window.matchMedia?.("(pointer: fine)").matches) inputRef.current?.focus();
      });
    }
  }

  async function answer(text: string, options: { without?: string[] }, signal: AbortSignal) {
    const thread = options.without?.length ? messages.filter((item) => !options.without!.includes(item.id)) : messages;
    // Only the latest answer's open draft takes follow-ups ("lieber 4000"); once the chat moved on, a new message is a new request.
    const latest = thread.findLast((item) => item.role === "assistant");
    if (latest?.contractDraft && (latest.status === "question" || latest.status === "preview") && await continueContract(latest, text)) return;
    // "Ja" or "Nein" right below a preview does the same as its buttons.
    if (latest?.change && latest.status === "preview" && !latest.draft && !latest.contractDraft) {
      if (confirmDraft(text)) {
        applyChange(latest, text);
        return;
      }
      if (cancelDraft(text) || /^(?:nein|ne|nö|lieber nicht|verwerfen|nicht übernehmen)[.!]*$/i.test(text.trim())) {
        save((items) => [...items.map((item) => item.id === latest.id ? { ...item, status: "dismissed" as const } : item), { id: newId(), role: "user", text, at: Date.now() },
          { id: newId(), role: "assistant", text: "Alles klar, ich habe nichts geändert.", at: Date.now(), source: "Regel", ...(latest.agent ? { agent: latest.agent } : {}) }]);
        return;
      }
    }
    // "Abbrechen" while a goal or an expense is being asked for: nothing is saved.
    if (latest?.draft && (latest.status === "question" || latest.status === "preview") && cancelDraft(text)) {
      save((items) => [...items.map((item) => item.id === latest.id ? { ...item, status: "dismissed" as const } : item), { id: newId(), role: "user", text, at: Date.now() },
        { id: newId(), role: "assistant", text: "Alles klar, ich habe nichts gespeichert.", at: Date.now(), source: "Regel", agent: toolOwner[latest.draft!.action] }]);
      return;
    }
    const pending = latest?.draft && (latest.status === "question" || latest.status === "preview")
      && !leavesDraft(text, missingField(latest.draft) === "name") && !otherCommand(text) ? latest.draft : undefined;
    setStatus(workStatus.read);
    const asOf = state.settings.asOf;
    const startedAt = Date.now();
    // Rough duration of this run for the admin view, from sending to the answer.
    const elapsed = () => Date.now() - startedAt;
    // Short pause, so instant rule answers still read like a reply instead of a page jump.
    const settle = () => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, Math.max(0, 650 - (Date.now() - startedAt)));
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const names = knownNames();
    const lastAnswer = thread.findLast((item) => item.role === "assistant");
    // Teaching own words: "Mit Japan meine ich Motorrad".
    const teaching = pending ? undefined : aliasTeaching(text);
    if (teaching) {
      setBusy(true);
      save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
      const target = pickName(teaching.to, names) ?? teaching.to;
      learn((current) => ({ ...current, assistantAliases: learnAlias(current.assistantAliases, teaching.from, target) }));
      await settle();
      addResult({ text: `Gemerkt: Wenn du „${teaching.from}“ schreibst, meinst du „${target}“. Das gilt ab sofort überall im Chat; unter „Gedächtnis“ kannst du es wieder löschen.`,
        suggestions: [`Wie weit bin ich bei ${teaching.from}?`, "Was hast du gelernt?"] }, "Regel", { agent: "general", via: "rule", ms: elapsed() });
      setBusy(false);
      return;
    }
    // After a web answer "Das hat geholfen" confirms it; after its 👎 the next message is the correction, unless it searches again.
    const webQuestion = pending ? undefined : lastAnswer?.tool === WEB_FIX_TOOL ? lastAnswer.correcting : lastAnswer && isWebAnswer(lastAnswer) ? lastAnswer.asked : undefined;
    const searchAgain = !!webQuestion && searchesAgain(text);
    // A rejected answer stays rejected: "Passt" after 👎 is just a reply, never a confirmation.
    if (webQuestion && lastAnswer && isWebAnswer(lastAnswer) && lastAnswer.feedback !== "down" && helpedReply(text)) {
      const confirmed = lastAnswer;
      // "Das hat geholfen" counts as 👍, in the feedback file too.
      const rated = confirmed.feedback === "up" ? undefined : { ...confirmed, feedback: "up" as const, feedbackId: confirmed.feedbackId ?? newId() };
      setBusy(true);
      save((items) => [...items.map((item) => item.id === confirmed.id && rated ? { ...item, feedback: rated.feedback, feedbackId: rated.feedbackId } : item),
        { id: newId(), role: "user", text, at: Date.now() }]);
      if (rated) {
        learn((current) => ({ ...current, assistantKnowledge: learnWebAnswer(current.assistantKnowledge,
          { id: newId(), question: webQuestion, text: confirmed.text, links: confirmed.links, target: confirmed.knowledgeId }) }));
        void storeFeedback(rated, "Feedback gespeichert");
      }
      await settle();
      addResult({ text: "Freut mich! Ich habe mir die Antwort gemerkt – fragst du wieder danach, weiß ich es sofort, ohne neue Suche.",
        suggestions: ["Was hast du gelernt?", ...starterSuggestions.slice(0, 2)] }, "Regel", { agent: "general", via: "rule", ms: elapsed() });
      setBusy(false);
      return;
    }
    // Only a statement that corrects the answer becomes a note; a new question, thanks or a command is answered normally.
    if (webQuestion && lastAnswer?.tool === WEB_FIX_TOOL && !searchAgain && correctsAnswer(text, webQuestion) && !detectTool(text, names) && !cancelDraft(text)) {
      const target = lastAnswer.knowledgeId;
      setBusy(true);
      save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
      learn((current) => ({ ...current, assistantKnowledge: noteWebAnswer(current.assistantKnowledge, { question: webQuestion, target }, text) }));
      await settle();
      addResult({ text: `Danke, notiert. Fragst du wieder nach „${webQuestion.slice(0, 80)}“, berücksichtige ich deinen Hinweis und lasse die abgelehnten Quellen weg.`,
        suggestions: [`Such im Internet: ${webQuestion.slice(0, 90)}`, "Was hast du gelernt?"] }, "Regel", { agent: "general", via: "rule", ms: elapsed() });
      setBusy(false);
      return;
    }
    // Corrections teach the earlier phrasing: "Nein, ich meinte …", or the answer to "Was hast du gemeint?".
    const fix = !pending && lastAnswer?.asked ? correction(text) : undefined;
    if (fix && !fix.text && lastAnswer) {
      // Question and reply first: the rating's global write then takes all three in one update.
      save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() },
        { id: newId(), role: "assistant", at: Date.now() + 1, source: "Regel", ...(lastAnswer.agent ? { agent: lastAnswer.agent } : {}),
          ...(lastAnswer.asked && !isWebAnswer(lastAnswer) ? { correcting: lastAnswer.asked.slice(0, 1000) } : {}),
          text: "Danke, dein Feedback ist gespeichert. Was war falsch? Schreib es ins Feld unter der Antwort – oder stell die Frage einfach anders, dann lerne ich daraus." }]);
      giveFeedback(lastAnswer, "down", { change: true });
      return;
    }
    // After 👎 the next message may rephrase the question; only a real rephrasing (see `rephrases`) is learned.
    const original = pending || lastAnswer?.tool === WEB_FIX_TOOL ? undefined : fix ? lastAnswer?.asked
      : lastAnswer?.correcting ?? (lastAnswer?.feedback === "down" && !isWebAnswer(lastAnswer) ? lastAnswer.asked : undefined);
    let work = searchAgain && webQuestion ? webQuestion : fix?.text ?? text;
    // "Such im Internet nach …" always searches, also for a question the local knowledge could answer.
    const forceWeb = searchAgain || asksForWebSearch(text);
    // Answer to "Welches meinst du?": run the earlier command with that name and remember the word that was meant.
    let alias: { from: string; to: string } | undefined;
    // "Vespa ist erreicht" right after that question is a new command of its own, not the pick for the earlier one.
    const pickedName = !pending && lastAnswer?.clarify ? pickName(text, names) : undefined;
    const chosen = pickedName && (text.trim().split(/\s+/).length <= 2 || !detectTool(text, names)) ? pickedName : undefined;
    if (chosen && lastAnswer?.clarify) {
      const target = unknownTarget(lastAnswer.clarify, names);
      if (target) alias = { from: target, to: chosen };
      work = target ? applyAliases([{ from: target, to: chosen, at: 0 }], lastAnswer.clarify).text : `${lastAnswer.clarify} ${chosen}`;
    }
    const aliased = applyAliases(state.assistantAliases, work);
    work = resolvePronoun(aliased.text, lastAnswer?.card);
    if (aliased.used.length) learn((current) => ({ ...current, assistantAliases: countAliases(current.assistantAliases, aliased.used) }));
    // Bare words ("Netflix", "500", "Geld") get a short question back; a bare account or goal name shows its balance.
    const open = !pending && !original && !chosen;
    const topic = open ? topicClarify(work, state, { accounts: balances(state, dashboard).map((item) => item.name),
      goals: savingsGoals(state).filter((goal) => !goal.completedAt).map((goal) => goal.name), contracts: contractNames(state, asOf) }) : undefined;
    if (topic && "rewrite" in topic) work = topic.rewrite;
    const fixed = open ? fixedReply(work) : undefined;
    // "Erklär das nochmal" after small talk has nothing to explain: ask what is meant.
    const nothingToExplain = explainAgain(work) && (!lastAnswer || !lastAnswer.card && !lastAnswer.tool && lastAnswer.text.length < 160)
      ? { text: "Was soll ich dir genauer erklären? Frag mich einfach direkt danach.", suggestions: starterSuggestions } : undefined;
    const chat = open ? smallTalk(text, { hour: new Date().getHours(), seed: thread.length, now: new Date() }) ?? fixed ?? nothingToExplain ??
      (topic && "reply" in topic ? topic.reply : undefined) : undefined;
    if (chat) {
      if (fixed?.theme && chat === fixed) setTheme(fixed.theme);
      const switched = fixed?.device && chat === fixed ? deviceReply(fixed, fixed.device) : chat;
      if (chat === fixed && (fixed.theme || fixed.device)) noteCall(toolCall("settings", { ok: switched.text === fixed.text }));
      setBusy(true);
      save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
      await settle();
      addResult(switched, "Regel", { agent: "general", via: "rule", ms: elapsed() });
      setBusy(false);
      return;
    }
    // The same question as a confirmed answer from earlier: answered right away, without routing, search or model.
    // A command or a question for one of the tools ("Zeig mir meinen ETF-Sparplan") always goes to its tool.
    const remembered = open && !forceWeb && !detectTool(work, names) ? recallConfirmed(state.assistantKnowledge, work) : undefined;
    if (remembered) {
      setBusy(true);
      save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
      setStatus(workStatus.recall);
      learn((current) => ({ ...current, assistantKnowledge: storeKnowledge(current.assistantKnowledge, [], [remembered.id]) }));
      await settle();
      addResult({ text: remembered.text, suggestions: ["Such im Internet nach Neuem dazu", ...agentSuggestions.general.slice(0, 2)] }, "Regel",
        { tool: LEARNED_TOOL, asked: work, agent: "general", via: "rule", ms: elapsed(), sources: ["Von dir bestätigt"], knowledgeId: remembered.id,
          ...(remembered.links?.length ? { links: remembered.links } : {}) });
      setStatus(undefined);
      setBusy(false);
      return;
    }
    const history = thread.slice(-6).map((item) => ({ role: item.role, text: item.text.slice(0, 500) }));
    const goals = savingsGoals(state).filter((goal) => !goal.completedAt).map((goal) => goal.name.slice(0, 80)).slice(0, 50);
    const planned = [...new Set(plannedOccurrences(state.plannedOneOffs).filter((item) => item.date.slice(0, 7) >= dashboard.currentMonth)
      .map((item) => item.name.slice(0, 100)))].slice(0, 60);
    setBusy(true);
    save((items) => [...items, { id: newId(), role: "user", text, at: Date.now() }]);
    // Stopped by the user: what was already written stays as the answer, otherwise a short note.
    const halted = (agent: AgentId = "general") => {
      if (!signal.aborted) return false;
      const partial = streamed.current?.trim();
      addResult({ text: partial ? `${partial} …` : "Gestoppt. Frag gern noch einmal oder anders." }, partial ? "KI" : "Regel",
        { agent, via: "rule", ms: elapsed(), ...(partial ? { tool: "free", asked: work } : {}) });
      setStreaming(undefined);
      setStatus(undefined);
      return true;
    };
    let reply: { agent?: unknown; via?: unknown; tool?: unknown; hints?: AgentHints; draft?: AssistantDraft; question?: string; source: "KI" | "Regel" };
    // "und im September?" reuses the previous question instead of asking the model again.
    const follow = pending ? undefined : resolveFollowUp(work, thread.filter((item) => item.role === "user").map((item) => item.text), [...goals, ...planned]);
    // Phrasings learned earlier are understood right away, without asking the model again.
    const learned = pending || follow || detectTool(work, [...goals, ...planned]) ? undefined : matchPhrase(state.assistantPhrases, work);
    // Two questions in one message are answered one after the other, each by its own agent.
    const parts = pending || follow || original || chosen ? undefined : splitQuestion(work, [...goals, ...planned]);
    if (parts) {
      for (const part of parts) {
        const partAgent: AgentId = part.tool ? toolOwner[part.tool] : routeBySignals(part.text, [...goals, ...planned])?.agent ?? "general";
        let result: AgentResult;
        // A new goal or planned expense in a combined message opens its form after the other answers.
        if (part.tool && isDraftTool(part.tool)) {
          setStatus(statusFor(part.tool, partAgent));
          const draft = mergeDraft(undefined, parseAssistantMessage(part.text, asOf), {}, part.text, asOf);
          const checked = draft ? assistantDraftSchema.safeParse(draft) : undefined;
          await settle();
          if (halted(partAgent)) return;
          if (checked?.success) addDraftMessage(checked.data, "Regel", { via: "rule", ms: elapsed() });
          else addResult({ text: "Für das Sparziel brauche ich noch Name, Betrag und Datum – zum Beispiel „Sparziel Urlaub 2.000 € bis Juli“." },
            "Regel", { tool: part.tool, asked: part.text, agent: partAgent, via: "rule", ms: elapsed() });
          continue;
        }
        if (part.tool) {
          setStatus(statusFor(part.tool, partAgent));
          const market = part.tool === "market" || part.tool === "depot" ? await loadMarket(part.text, signal) : undefined;
          const knowledge = part.tool === "knowledge" ? await loadKnowledge(part.text, [...goals, ...planned], signal) : undefined;
          await afterPaint();
          try {
            result = executeTool(part.tool, part.text, { state, dashboard, asOf, market, knowledge, page: pageContext(), insights: extras?.copilot });
          } catch {
            result = { text: "Dabei ist etwas schiefgegangen. Bitte formuliere es etwas anders." };
          }
        } else {
          const said = await freeAnswer(work, history, partAgent, agentEvidence(partAgent, state, dashboard, asOf, part.text), signal);
          if (!said && !signal.aborted) noteCall(toolCall("free", { ok: false }));
          result = { text: said ?? "Den zweiten Teil beantworte ich gern extra – frag mich einfach noch einmal danach." };
        }
        await settle();
        if (halted(partAgent)) return;
        addResult(result.suggestions ? result : { ...result, suggestions: part.tool ? followUps[part.tool] : agentSuggestions[partAgent] },
          part.tool ? "Regel" : "KI", { tool: part.tool ?? "free", asked: part.text, agent: partAgent, via: "rule", ms: elapsed() });
        setStreaming(undefined);
      }
      setStatus(undefined);
      return;
    }
    if (follow) reply = { tool: follow.tool, source: "Regel" };
    else if (learned && isAssistantTool(learned.tool)) {
      reply = { tool: learned.tool, source: "Regel" };
      learn((current) => ({ ...current, assistantPhrases: learnPhrase(current.assistantPhrases, work, learned.tool) }));
    } else try {
      // When the rules already know the specialist, its bot and step show while the server still reads the details.
      const early = pending ? undefined : routeByRules(work, [...goals, ...planned]);
      setStatus(early?.tool && !isDraftTool(early.tool) ? statusFor(early.tool, early.agent) : workStatus.route);
      const response = await fetch("/api/ai/assistant", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal,
        body: JSON.stringify({ message: work, asOf, ...(pending ? { pending } : {}), history, context: { goals, planned } }),
      });
      if (!response.ok) throw new Error();
      reply = await response.json();
    } catch {
      // Same orchestrator rules as the server, without the model; whatever stays unclear goes to the general chat.
      const decision = routeByRules(work, [...goals, ...planned]);
      const tool = decision?.tool;
      if (tool && !isDraftTool(tool) && !(pending && tool === "help")) reply = { agent: decision.agent, via: decision.via, tool, source: "Regel" };
      else {
        const draft = mergeDraft(pending, parseAssistantMessage(work, asOf), {}, work, asOf);
        reply = { agent: draft ? toolOwner[draft.action] : decision?.agent ?? "general", via: draft ? "rule" : decision?.via ?? "fallback", draft,
          question: draft ? missingQuestion(draft) : undefined, source: "Regel" };
      }
    }
    if (halted()) return;
    const picked: AssistantTool | undefined = isAssistantTool(reply.tool) && !isDraftTool(reply.tool) && reply.tool !== "ask" ? reply.tool : undefined;
    // Explanations, opinions and advice get a written answer; a question never silently opens an edit or a form.
    const ruleTool = reply.source === "Regel" ? picked : detectTool(work, [...goals, ...planned]);
    const route = conversationRoute({ text: work, tool: picked, ruleTool,
      draftAction: reply.draft?.action, numbers: work.match(/\d+(?:[.,]\d+)?/g)?.map(Number) ?? [], pending: !!pending });
    // "Such im Internet nach dem Familienbonus" searches even when a reading tool would answer; changes and forms never go to the web.
    const tool = forceWeb && route.tool && !changingTools.includes(route.tool) ? undefined : route.tool;
    // A tool's owner answers; without a tool the orchestrator's choice, and the general chat whenever it is unsure.
    // A question that dropped an edit ("Sollte ich das Lebensmittelbudget erhöhen?") stays with that edit's owner;
    // one that dropped a misread form ("Was ist mit meiner Versicherung los?") is routed again by its signal words.
    const dropped = !tool && picked ? picked : undefined;
    const agent: AgentId = tool ? toolOwner[tool] : dropped ? toolOwner[dropped]
      : route.skipDraft ? routeBySignals(work, [...goals, ...planned])?.agent ?? "general"
      : isAgentId(reply.agent) ? reply.agent : "general";
    const via: RouteVia = isRouteVia(reply.via) ? reply.via : "rule";
    const run = { agent, via };
    setStatus(statusFor(tool ?? (reply.draft && !route.skipDraft ? reply.draft.action : undefined), agent));
    // Only the model understood this phrasing; remember it so the rules answer it directly next time.
    if (tool && reply.source === "KI" && learnableTools.includes(tool) && !Object.values(reply.hints ?? {}).some((value) => value !== undefined && value !== null) &&
      !detectTool(work, [...goals, ...planned])) learn((current) => ({ ...current, assistantPhrases: learnPhrase(current.assistantPhrases, work, tool),
        assistantGaps: resolveGap(current.assistantGaps, work, tool) }));
    // What was learned from this message is said at the start of the answer.
    const notes: string[] = [];
    // An explicit "Nein, ich meinte …" always teaches; after "da komme ich nicht mit" only a real rephrasing, not the next topic.
    if (original && tool && learnableTools.includes(tool) && original !== work && !detectTool(original, [...goals, ...planned]) && (fix || rephrases(original, work))) {
      learn((current) => ({ ...current, assistantPhrases: learnPhrase(current.assistantPhrases, original, tool), assistantGaps: resolveGap(current.assistantGaps, original, tool) }));
      notes.push(`Danke, gelernt: „${original.slice(0, 80)}“ verstehe ich ab jetzt so.`);
    }
    if (alias) {
      const learnedAlias = alias;
      learn((current) => ({ ...current, assistantAliases: learnAlias(current.assistantAliases, learnedAlias.from, learnedAlias.to) }));
      notes.push(`Gemerkt: Mit „${alias.from}“ meinst du „${alias.to}“.`);
    }
    const withNotes = (result: AgentResult): AgentResult => notes.length ? { ...result, text: `${notes.join(" ")}\n\n${result.text}` } : result;
    const parsed = !tool && reply.draft && !route.skipDraft ? assistantDraftSchema.safeParse(reply.draft) : undefined;
    const writes = !tool && !parsed?.success;
    // The orchestrator decides whether general finance knowledge helps (curated chunks and the user's confirmed answers)
    // and whether the web is asked; app actions and the user's own figures never wait for either.
    const webWanted = writes && (forceWeb || wantsWebSearch(work));
    const wisdom = writes && (wantsKnowledge(work, { agent }) || webWanted) ? await searchLocalKnowledge(work, signal) : undefined;
    if (halted(agent)) return;
    const recalled = wisdom ? confidentHit(wisdom.hits, wisdom.mode) : undefined;
    const confirmed = recalled?.learned && !forceWeb ? learnedAnswer(recalled) : undefined;
    let web = writes && !confirmed && (forceWeb || webWanted && wantsWebSearch(work, { hits: wisdom?.hits.length ?? 0, confident: !!recalled }))
      ? await searchTheWeb(work, signal) : undefined;
    if (halted(agent)) return;
    // The agent's evidence scans the ledger; it is only built when a written answer needs it.
    let free = writes && !confirmed && !web ? await freeAnswer(work, history, agent,
      [knowledgeEvidence(wisdom?.hits ?? []), agentEvidence(agent, state, dashboard, asOf, work)].filter(Boolean).join("\n\n") || undefined, signal) : undefined;
    if (halted(agent)) return;
    // An answer that admits not knowing (or none at all) gets one web search, for finance questions only.
    if (writes && !confirmed && !web && unsureAnswer(free) && wantsWebSearch(work, { hits: 0 })) {
      web = await searchTheWeb(work, signal);
      if (web) {
        setStreaming(undefined);
        free = undefined;
      }
      if (halted(agent)) return;
    }
    const fromWeb = web ? await answerFromWeb(work, history, web, signal) : undefined;
    await settle();
    if (halted(agent)) return;
    if (tool === "remember") {
      // An explicit "Merk dir …" is saved right away; it can be undone or deleted under „Gedächtnis“.
      const operation = parseMemory(work);
      if (operation) remember([operation]);
      else addResult({ text: "Was soll ich mir merken? Zum Beispiel „Puffer immer 500 €“ oder „Mein Gehalt kommt am 25.“." }, reply.source, { ...run, ms: elapsed() });
    } else if (tool) {
      let result: AgentResult;
      const market = tool === "market" || tool === "depot" ? await loadMarket(work, signal) : undefined;
      const term = tool === "knowledge" && !knowledgeListQuestion(work.toLowerCase());
      // Terms come from the local finance knowledge first; only what it does not cover is looked up online.
      const local = term ? await searchLocalKnowledge(work, signal) : undefined;
      const known = local ? confidentHit(local.hits, local.mode) : undefined;
      const knowledge = term && !known ? await loadKnowledge(work, [...goals, ...planned], signal) : undefined;
      if (halted(agent)) return;
      // A confirmed answer from earlier comes first; what neither the local knowledge nor the encyclopedia covers goes to the web search.
      const recalledTerm = known?.learned ? learnedAnswer(known) : undefined;
      const termWeb = term && !known && knowledge && !knowledge.found.length && !knowledge.offline ? await searchTheWeb(work, signal) : undefined;
      const fromTerm = termWeb ? await answerFromWeb(work, history, termWeb, signal) : undefined;
      if (halted(agent)) return;
      if (recalledTerm || fromTerm?.text) {
        await settle();
        if (halted(agent)) return;
        if (recalledTerm) addResult(withNotes(recalledTerm.result), "Regel", { tool: LEARNED_TOOL, asked: work, agent: "general", via, ms: elapsed(),
          sources: ["Von dir bestätigt"], knowledgeId: recalledTerm.knowledgeId, ...(recalledTerm.links?.length ? { links: recalledTerm.links } : {}) });
        else if (fromTerm) addResult(withNotes({ text: fromTerm.text, suggestions: ["Das hat geholfen", ...agentSuggestions.general.slice(0, 2)] }), fromTerm.byModel ? "KI" : "Regel",
          { tool: WEB_TOOL, asked: work, agent: "general", via, ms: elapsed(), links: fromTerm.links });
        setStreaming(undefined);
        setStatus(undefined);
        return;
      }
      setStatus(statusFor(tool, agent));
      await afterPaint();
      try {
        result = known ? localKnowledgeAnswer(known, local!.hits) : executeTool(tool, work, { state, dashboard, asOf, hints: reply.hints, previous: follow?.previous,
          market, knowledge, page: pageContext(), insights: extras?.copilot });
      } catch {
        result = { text: "Dabei ist etwas schiefgegangen. Bitte formuliere es etwas anders." };
      }
      // The tool computed the numbers; the model turns them into a direct answer to the actual question. The card stays.
      // A term without a reliable finance article keeps the tool's honest answer instead of a guess.
      if (!known && !(tool === "knowledge" && knowledge && !knowledge.found.length) && route.converse && converseOn(tool, result, work, tool !== ruleTool) && !changingTools.includes(tool) && !result.change && !result.undoId && !result.choices) {
        const said = await freeAnswer(work, history, agent, evidenceText(result), signal);
        if (halted(agent)) return;
        if (said) result = { ...result, text: said };
      }
      addResult(withNotes(result.suggestions || result.change || result.undoId || result.choices ? result : { ...result, suggestions: followUps[tool] }), reply.source,
        { tool, asked: work, clarify: work, ...run, ms: elapsed() });
    } else if (parsed?.success && parsed.data.action === "affordability")
      // Affordability never opens a plan form: it checks the accounts that may be used and says OK or not OK.
      addResult(withNotes(executeTool("funds", work, { state, dashboard, asOf })), reply.source, { tool: "funds", asked: work, clarify: work, agent: "budget", via, ms: elapsed() });
    else if (parsed?.success) addDraftMessage(parsed.data, reply.source, { via, ms: elapsed() });
    else if (confirmed) addResult(withNotes(confirmed.result), "Regel", { tool: LEARNED_TOOL, asked: work, agent: "general", via, ms: elapsed(),
      sources: ["Von dir bestätigt"], knowledgeId: confirmed.knowledgeId, ...(confirmed.links?.length ? { links: confirmed.links } : {}) });
    else if (fromWeb?.text) addResult(withNotes({ text: fromWeb.text, suggestions: ["Das hat geholfen", ...agentSuggestions.general.slice(0, 2)] }), fromWeb.byModel ? "KI" : "Regel",
      { tool: WEB_TOOL, asked: work, agent: "general", via, ms: elapsed(), links: fromWeb.links });
    else if (free) addResult(withNotes({ text: free, suggestions: agentSuggestions[agent] }), "KI", { tool: "free", asked: work, ...run, ms: elapsed(),
      ...(wisdom?.hits.length ? { sources: wisdom.hits.map((hit) => hit.title) } : {}) });
    else {
      learn((current) => ({ ...current, assistantGaps: recordGap(current.assistantGaps, work) }));
      // Without a web answer the model was asked for a free answer and gave none.
      if (!web) noteCall(toolCall("free", { ok: false }));
      // A question back with the closest options instead of a refusal; the rephrasing is learned for next time.
      const options = clarifyChoices(work);
      addResult(options ? { text: options.text, suggestions: options.options }
        : { text: "Das habe ich noch nicht ganz verstanden. Worum geht es dir – um deine Ausgaben, ein Sparziel, deine Verträge oder ob sich ein Kauf ausgeht? " +
          "Sag es mir gern mit anderen Worten, die neue Formulierung merke ich mir.",
        suggestions: ["Was kannst du alles?", ...starterSuggestions.slice(0, 2)] }, "Regel", { correcting: work, ...run, ms: elapsed() });
    }
    // Lasting facts in any message ("Mein Gehalt kommt am 25.", "Ich wohne in Wien") are remembered automatically.
    if (tool !== "remember") {
      const memories = extractMemories(work, state, tool ?? (parsed?.success ? parsed.data.action : undefined));
      if (memories.length) remember(memories);
    }
    setStreaming(undefined);
    setStatus(undefined);
  }

  // Stop: ends the running request; send() keeps what was already written.
  const stop = () => activeRun.current?.abort();
  // Ask the last question again without the old answer in the conversation.
  function regenerate(message: AssistantMessage) {
    const index = messages.findIndex((item) => item.id === message.id);
    const question = messages.slice(0, index).findLast((item) => item.role === "user");
    if (!question || busy) return;
    const remove = messages.slice(messages.indexOf(question)).map((item) => item.id);
    save((items) => items.filter((item) => !remove.includes(item.id)));
    void send(undefined, question.text, { without: remove });
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

  // Handlers for the message rows; read when clicked, so the rows never need to re-render for a new handler.
  const rowActions = useRef<RowActions | null>(null);
  useLayoutEffect(() => {
    rowActions.current = { addResult, applyChange, setMessage, undo, setEditing, createGoal, createExpense, regenerate, giveFeedback, commentFeedback, setCommentFor,
      ask: (text) => void send(undefined, text) };
  });
  const lastId = messages.at(-1)?.id;

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
        if (window.confirm("Den gesamten Chatverlauf löschen? Angelegte Ziele, Ausgaben, das Gedächtnis und die Änderungsliste bleiben erhalten.")) writeGlobal((current) => ({ ...current, assistantChat: [] }));
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
      onForgetKnowledge={(id) => { writeGlobal((current) => ({ ...current, assistantKnowledge: (current.assistantKnowledge ?? []).filter((entry) => entry.id !== id) })); toast.success("Vergessen"); }}
      onResetPhrases={() => { writeGlobal((current) => ({ ...current, assistantPhrases: [] })); toast.success("Gelernte Formulierungen zurückgesetzt"); }}
      aliases={state.assistantAliases ?? []} gaps={state.assistantGaps ?? []} rules={state.accountRules ?? []}
      onForgetRule={(id) => { writeGlobal((current) => ({ ...current, accountRules: (current.accountRules ?? []).filter((entry) => entry.id !== id) })); toast.success("Kontoregel gelöscht"); }}
      onForgetAlias={(from) => { writeGlobal((current) => ({ ...current, assistantAliases: (current.assistantAliases ?? []).filter((entry) => entry.from !== from) })); toast.success("Vergessen"); }}
      onRemoveGap={(text) => writeGlobal((current) => ({ ...current, assistantGaps: (current.assistantGaps ?? []).filter((entry) => entry.text !== text) }))} />}
    </div>}
    <section className={panelMode ? "flex min-h-0 flex-1 flex-col border-t border-border/60" : "panel flex min-h-[60vh] flex-col p-4 sm:p-6"} aria-label="Chat mit dem Finanz-Assistenten">
      <FinancialData className={panelMode ? "flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6" : "flex flex-1 flex-col gap-5"} aria-live="polite">
        {!started &&
          <ChatEmptyState prompts={starterPrompts} disabled={busy || !!storageError} onPick={(text) => void send(undefined, text)} />}
        <ChatBusy value={busy}>
          {messages.map((message) => {
            const handoff = message.role === "assistant" ? handoffs.current.get(message.id) : undefined;
            // A question already showed when it was sent, and a streamed answer stays where it was; neither enters a second time.
            return <MessageRow key={message.id} message={message} state={state} dashboard={dashboard} last={message.id === lastId} live={message.id === liveId}
              pending={message.id === pendingId} editing={editing === message.id} commenting={commentFor === message.id} locked={!!storageError} handoff={handoff}
              actions={rowActions}
              enter={!initialIds.has(message.id) && message.role === "assistant" && !handoff?.streamed} />;
          })}
        </ChatBusy>
        {echo && !messages.some((message) => message.role === "user" && message.at >= echo.at) &&
          <MessageEnter animate mine className="group/message flex flex-col gap-2" data-role="user" data-echo="">
            <Bubble role="user" text={echo.text} />
          </MessageEnter>}
        {busy && <LiveAnswer live={live} />}
        <div ref={endRef} />
      </FinancialData>
      <form onSubmit={send} className={panelMode ? "shrink-0 px-4 pt-3 pb-1 sm:px-6" : "mt-5"}>
        <Label htmlFor="assistant-input" className="sr-only">Nachricht an den Finanz-Assistenten</Label>
        <div className="flex items-end gap-2 rounded-2xl border border-input bg-card p-1.5 pl-4 shadow-card transition-[border-color,box-shadow] duration-200 focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/15">
          <textarea id="assistant-input" ref={inputRef} value={input} rows={1} maxLength={1000}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                // An input method (e.g. Japanese) confirms its text with Enter; that must not send yet.
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                void send();
                return;
              }
              if (event.key === "ArrowUp" && !input) {
                const last = messages.findLast((item) => item.role === "user");
                if (last) { event.preventDefault(); setInput(last.text); }
              }
            }}
            aria-keyshortcuts="ArrowUp"
            placeholder="Frag nach Ausgaben, Verträgen, Budget …"
            className="field-sizing-content max-h-48 min-h-10 w-full flex-1 resize-none bg-transparent py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60" />
          <ComposerButton busy={busy} disabled={!input.trim() || !!storageError} onStop={stop} />
        </div>
      </form>
      <p className={cn("mt-2 text-center text-2xs text-muted-foreground", panelMode && "shrink-0 px-4 pb-4 sm:px-6")}>Alle Zahlen rechnet der Code, nicht die KI. Ändern oder speichern tue ich nur nach deiner Bestätigung.</p>
    </section>
  </div>;
}
type RowActions = {
  addResult: (result: AgentResult, source: AssistantMessage["source"]) => void;
  applyChange: (message: AssistantMessage) => void;
  setMessage: (id: string, patch: Partial<AssistantMessage>, reply?: string) => void;
  undo: (logId: string) => void;
  setEditing: (id?: string) => void;
  createGoal: (message: AssistantMessage, draft: AssistantDraft) => void;
  createExpense: (message: AssistantMessage, draft: AssistantDraft) => void;
  ask: (text: string) => void;
  regenerate: (message: AssistantMessage) => void;
  giveFeedback: (message: AssistantMessage, value: "up" | "down") => void;
  commentFeedback: (message: AssistantMessage, comment: string) => void;
  setCommentFor: (id?: string) => void;
};
// Whether an answer is being worked on; only the small row footers read it, so starting a run does not re-render every message.
const ChatBusy = createContext(false);

/** One message with its cards; it renders again only when its own props change, so a new message renders just itself. */
const MessageRow = memo(function MessageRow({ message, state, dashboard, last, live, pending, editing, commenting, locked, enter, handoff, actions }: {
  message: AssistantMessage; state: AppState; dashboard: Dashboard; last: boolean; live: boolean; pending: boolean; editing: boolean; commenting: boolean; locked: boolean;
  enter: boolean; handoff?: { activity: WorkActivity; streamed: boolean }; actions: RefObject<RowActions | null>;
}) {
  const act = () => actions.current;
  return <MessageEnter animate={enter} mine={message.role === "user"}
    className="group/message flex flex-col gap-2" data-role={message.role} data-agent={message.agent}
    data-via={message.via} data-ms={message.ms} data-tool={message.tool} data-source={message.source}>
    <Bubble role={message.role} text={message.text} source={message.source} agent={message.agent} sources={message.sources} links={message.links} faded={message.status === "dismissed"}
      live={live} handoff={handoff}>
      {message.card && message.card.kind !== "homeoffice" && <ResultCard card={message.card} state={state} embedded
        onResult={locked ? undefined : (result) => act()?.addResult(result, "Regel")} />}
    </Bubble>
    {message.card?.kind === "homeoffice" && <div className="pl-11">
      <HomeOfficeCard card={message.card} state={state} disabled={locked} onResult={(result) => act()?.addResult(result, "Regel")} /></div>}
    {message.change && message.status !== "dismissed" && <div className="pl-11">
      <GlowFrame kind="pending" active={message.status === "preview" && pending}>
        <ChangeCard message={message} disabled={locked} onApply={() => act()?.applyChange(message)}
          onDismiss={() => act()?.setMessage(message.id, { status: "dismissed" }, "Alles klar, ich habe nichts geändert.")}
          onUndo={() => message.change?.logId && act()?.undo(message.change.logId)} />
      </GlowFrame>
    </div>}
    {message.undoId && !message.draft && !message.change && message.status !== "dismissed" && <div className="flex flex-wrap items-center gap-2 pl-11">
      {message.status === "preview" ? <>
        <Button type="button" size="sm" className="min-h-10" disabled={locked} onClick={() => act()?.undo(message.undoId!)}><Undo2 aria-hidden="true" className="size-4" />Rückgängig machen</Button>
        <Button type="button" size="sm" variant="ghost" className="min-h-10" onClick={() => act()?.setMessage(message.id, { status: "dismissed" })}><X aria-hidden="true" className="size-4" />Doch nicht</Button>
      </> : message.status === "applied" ? <Button type="button" size="sm" variant="ghost" className="min-h-10 text-muted-foreground" disabled={locked}
        onClick={() => act()?.undo(message.undoId!)}><Undo2 aria-hidden="true" className="size-4" />Nicht merken</Button>
        : message.status === "undone" && <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Undo2 aria-hidden="true" className="size-3.5" />Rückgängig gemacht</p>}
    </div>}
    {message.draft && message.status !== "question" && <div className="pl-11">
      {editing
        ? <DraftEditor draft={message.draft} onCancel={() => act()?.setEditing(undefined)} onSave={(draft) => {
          act()?.setEditing(undefined);
          const question = missingQuestion(draft);
          act()?.setMessage(message.id, { draft, status: question ? "question" : "preview", text: question ?? previewText(draft) });
        }} />
        : <GlowFrame kind="pending" active={message.status === "preview" && pending}>
          <DraftCard key={`${message.id}:${JSON.stringify(message.draft)}`} message={message} state={state} dashboard={dashboard} disabled={locked}
            onEdit={() => act()?.setEditing(message.id)}
            onDismiss={() => act()?.setMessage(message.id, { status: "dismissed" }, "Alles klar, ich habe nichts gespeichert.")}
            onCreateGoal={(draft) => act()?.createGoal(message, draft)} onCreateExpense={(draft) => act()?.createExpense(message, draft)}
            onUndo={() => message.undoId && act()?.undo(message.undoId)} />
        </GlowFrame>}
    </div>}
    <RowFooter message={message} last={last} locked={locked} commenting={commenting} actions={actions} />
  </MessageEnter>;
});

function RowFooter({ message, last, locked, commenting, actions }: {
  message: AssistantMessage; last: boolean; locked: boolean; commenting: boolean; actions: RefObject<RowActions | null>;
}) {
  const busy = useContext(ChatBusy);
  return <>
    {message.suggestions && !busy && last &&
      <QuickReplies items={message.suggestions} disabled={locked} onPick={(text) => actions.current?.ask(text)} />}
    {message.role === "assistant" && message.status !== "dismissed" && <MessageActions text={message.text} disabled={busy || locked}
      // The newest answer and an open comment keep their actions in view; older ones show them on hover or focus, touch screens always.
      className={cn(!last && !commenting && "transition-opacity duration-150 [@media(hover:hover)]:opacity-0 group-hover/message:opacity-100 focus-within:opacity-100")}
      onRegenerate={message.source === "KI" && message.asked && last && !message.change && !message.draft
        ? () => actions.current?.regenerate(message) : undefined}
      feedback={message.feedback} comment={message.feedbackComment} commenting={commenting}
      onFeedback={(value) => actions.current?.giveFeedback(message, value)}
      onComment={message.feedbackId ? (comment) => actions.current?.commentFeedback(message, comment) : undefined}
      onCommenting={(open) => actions.current?.setCommentFor(open ? message.id : undefined)} />}
  </>;
}

function QuickReplies({ items, disabled, onPick }: { items: string[]; disabled: boolean; onPick: (text: string) => void }) {
  return <div className="flex flex-wrap gap-2 pl-11" aria-label="Vorschläge">
    {[...new Set(items)].map((item) => <button key={item} type="button" disabled={disabled} onClick={() => onPick(item)}
      className="assistant-reveal min-h-9 rounded-2xl border border-border bg-card px-3.5 py-2 text-left text-xs leading-snug text-foreground/80 shadow-card transition-[background-color,border-color,color,transform] duration-150 hover:border-primary/50 hover:bg-primary/8 hover:text-foreground active:scale-[0.97] disabled:opacity-50 motion-reduce:active:scale-100">{item}</button>)}
  </div>;
}

function Bubble({ role, text, source, agent, sources, links, faded, live, handoff, children }: {
  role: "user" | "assistant"; text: string; source?: "KI" | "Regel"; agent?: AgentId; sources?: string[]; links?: WebLinkEntry[]; faded?: boolean; live?: boolean;
  handoff?: { activity: WorkActivity }; children?: React.ReactNode;
}) {
  if (role === "user") return <div className={cn("flex justify-end", faded && "opacity-60")}>
    <div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground shadow-card sm:max-w-[75%]">
      <span className="sr-only">Du: </span><span className="whitespace-pre-line">{text}</span>
    </div>
  </div>;
  const label = [agent && agent !== "general" ? agentLabel[agent] : "", source === "KI" ? "KI" : ""].filter(Boolean).join(" · ");
  // Only the newest answer's bot stays awake; older ones keep their pose, so a long chat costs no extra frames.
  return <div className={cn("flex items-start gap-3", faded && "opacity-60")}>
    {handoff ? <HandoffAvatar agent={agent ?? "general"} activity={handoff.activity} live={!!live} />
      : <AgentAvatar agent={agent ?? "general"} still={!live} className="mt-0.5" />}
    <div className={cn("min-w-0 rounded-2xl rounded-tl-md border border-border/60 bg-card px-4 py-3 text-sm leading-relaxed shadow-card", children ? "max-w-[92%] flex-1" : "max-w-[85%]")}>
      <span className="sr-only">Assistent: </span><span className="whitespace-pre-line">{text}</span>
      {(label || sources?.length || links?.length) && <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
        {label && <span>{label}</span>}
        {sources?.length ? <span>{links?.length ? sources.join(" · ") : `Wissen: ${sources.join(" · ")}`}</span> : null}
        {links?.length ? <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1"><span>Quellen:</span>
          {links.map((link, index) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener" title={link.title}
            className="rounded-sm underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            [{index + 1}] {linkSite(link.url)}<span className="sr-only"> (öffnet in neuem Tab)</span></a>)}
        </span> : null}
      </span>}
      {children}
    </div>
  </div>;
}

const linkSite = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
};

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
