import type { AssistantChange, AssistantMessage, AssistantOperation, AssistantToolCall } from "@/lib/types";
import { modelTitle, taskLabel, type ModelUse } from "@/lib/ai/models";
import { changingTools } from "./conversation";
import { agentIds, agentTools, specialistIds, type AgentId, type RouteVia } from "./orchestrator";
import { isAssistantTool, type AssistantTool } from "./tools";

/** What each agent is for, in the words of the admin view (read-only). */
export const agentInfo: Record<AgentId, { summary: string; scope: string }> = {
  transactions: { summary: "Buchungen, Ausgaben und Einnahmen",
    scope: "Vergangene Buchungen, Händler und Kategorien, Monats- und Jahresrückblick, doppelte oder verdächtige Buchungen, Rückerstattungen, offene Bestellungen; Buchungen bearbeiten, löschen und taggen" },
  contracts: { summary: "Abos und Verträge", scope: "Welche Verträge es gibt, Kosten pro Monat und Jahr, Laufzeit, Kündigungsfrist und Kündigen; Verträge Schritt für Schritt anlegen, ändern, bestätigen, ausblenden und als gekündigt markieren" },
  budget: { summary: "Monatsplan, Konten und Ziele",
    scope: "Was übrig bleibt, Kontostände, Prognose, Sparziele und geplante Ausgaben, ob sich ein Kauf ausgeht, Spartipps, Anlegen und Kredite; Budgets, Monatsplan-Positionen und Kontoregeln ändern" },
  payroll: { summary: "Gehalt und Steuern",
    scope: "Lohnabrechnung, netto und brutto, Sonderzahlungen mit Anteil zu 6 % und voll versteuert, Jahressechstel, Arbeitnehmerveranlagung; Abrechnungen prüfen, ins Budget übernehmen oder entfernen" },
  general: { summary: "Allgemeiner Chat, Rückfall bei Unklarheit",
    scope: "Begrüßung, allgemeine Geldfragen, Finanzbegriffe, Bedienung der App, Marktdaten und Gedächtnis, Einstellungen wie Design, Töne und Benachrichtigungen; fachfremde Themen lehnt er höflich ab" },
};

/** Short names for the tool list. */
export const toolLabel: Record<AssistantTool, string> = {
  query: "Ausgaben & Einnahmen", booking: "Buchung bearbeiten", rule: "Kategorie-Regel", cleanup: "Offene Buchungen zuordnen",
  why: "Warum diese Kategorie?", security: "Sicherheits-Check", refunds: "Rückerstattungen", context: "Angezeigte Buchungen",
  orders: "Offene Bestellungen", shared: "Geteilte Kosten", month_review: "Monatsbericht", review: "Jahresrückblick",
  contracts: "Vertragsordner", cancel: "Kündigungshilfe", contract_new: "Vertrag anlegen", contract_edit: "Vertrag ändern",
  budget: "Monatsplan", budget_plan: "Budget anpassen", pulse: "Monats-Puls", forecast: "Kontoprognose", funds: "Leistbarkeit",
  account_rule: "Kontoregeln", affordability: "Kauf durchrechnen", savings_goal: "Sparziel anlegen", expense: "Ausgabe planen",
  edit: "Ziel, Ausgabe oder Planposition ändern", batch: "Mehrere Änderungen", whatif: "Was wäre wenn", coach: "Spar-Coach", check: "Finanz-Check",
  briefing: "Wochenüberblick", insights: "Hinweise", accounts: "Kontostände", amex: "Amex-Abrechnung", networth: "Vermögen",
  depot: "Depot-Rechner", loan: "Kreditrechner",
  payroll: "Gehaltsübersicht", tax: "Arbeitnehmerveranlagung", homeoffice: "Home-Office-Rechner", payroll_action: "Abrechnungen bearbeiten",
  help: "Hilfe", explain: "App erklären", knowledge: "Begriffe nachschlagen", market: "Marktdaten", memory: "Gedächtnis",
  remember: "Merken", forget: "Vergessen", changes: "Änderungsprotokoll", undo: "Rückgängig", reminder: "Erinnerungen", ask: "Freie Antwort", settings: "Einstellungen ändern",
};

/** Tools that change data; they only run after the user confirms. */
export const changesData = (tool: AssistantTool) => changingTools.includes(tool);

/** Lookups a run can make besides its tool; the web search keeps its tool name `web`. */
export const lookupTool = { knowledge: "knowledge_search", lexicon: "lexicon", market: "market_data" } as const;

// Calls that are no assistant tool of their own: lookups, the web search and answers without a tool.
const lookupLabel: Partial<Record<string, string>> = {
  knowledge_search: "Finanzwissen", lexicon: "Lexikon", market_data: "Marktdaten", web: "Websuche", web_fix: "Web-Korrektur",
  free: "Freie Antwort", learned: "Bestätigte Antwort",
};
// What a call did, in a few words; tools without a phrase use their name.
const callAction: Partial<Record<string, string>> = {
  knowledge_search: "Wissen nachschlagen", lexicon: "Begriff nachschlagen", market_data: "Marktdaten abrufen", web: "Websuche",
  free: "Antwort formulieren", learned: "Bestätigte Antwort abrufen",
  savings_goal: "Plane Sparziel", expense: "Plane Ausgabe", affordability: "Rechne Kauf durch", booking: "Bearbeite Buchung", batch: "Mehrere Änderungen",
  rule: "Lege Kategorie-Regel an", edit: "Ändere Planung", remember: "Merke mir etwas", forget: "Vergesse Eintrag", undo: "Mache Änderung rückgängig",
  reminder: "Lege Erinnerung an", account_rule: "Lege Kontoregel an", budget_plan: "Passe Budget an", contract_new: "Lege Vertrag an",
  contract_edit: "Ändere Vertrag", payroll_action: "Bearbeite Abrechnung", settings: "Ändere Einstellung",
};
const emptyAction: Partial<Record<string, string>> = { knowledge_search: "Kein Wissen gefunden", lexicon: "Begriff nicht gefunden", web: "Websuche ohne Treffer" };
const operationAction: Record<AssistantOperation["op"], string> = {
  goal_update: "Ändere Sparziel", goal_pause: "Pausiere Sparziel", goal_extras: "Plane Extra-Raten", goal_complete: "Schließe Sparziel ab",
  goal_delete: "Lösche Sparziel", planned_update: "Ändere geplante Ausgabe", planned_delete: "Lösche geplante Ausgabe",
  transaction_update: "Bearbeite Buchung", categorize: "Kategorisiere Buchung", review_resolve: "Ordne offene Buchungen zu", setting: "Ändere Sparvorgabe",
  memory_add: "Merke mir etwas", memory_delete: "Vergesse Eintrag", budget_plan: "Passe Budget an", contract_create: "Lege Vertrag an",
  contract_update: "Ändere Vertrag", contract_bookings: "Ordne Buchungen dem Vertrag zu", payslip_confirm: "Übernehme Abrechnung",
  payslip_remove: "Entferne Abrechnung", payroll_sync: "Gleiche Budget mit Gehalt ab", setting_flag: "Ändere Einstellung", seasonal_theme: "Ändere Design",
  contract_action: "Ändere Vertragsstatus", transaction_delete: "Lösche Buchung", transaction_tag: "Tagge Buchung", plan_row_save: "Speichere Planposition",
  plan_row_delete: "Lösche Planposition", plan_value: "Ändere Planwert", account_rule: "Lege Kontoregel an", account_rule_delete: "Lösche Kontoregel",
  bonus_percent: "Ändere Bonusanteil",
};
const severalAction: Partial<Record<AssistantOperation["op"], string>> = {
  transaction_update: "Bearbeite Buchungen", categorize: "Kategorisiere Buchungen", transaction_delete: "Lösche Buchungen", transaction_tag: "Tagge Buchungen",
};

function operationPhrase(operation: AssistantOperation) {
  if (operation.op === "categorize" && operation.learn) return "Lege Kategorie-Regel an";
  return "ids" in operation && operation.ids.length > 1 ? severalAction[operation.op] ?? operationAction[operation.op] : operationAction[operation.op];
}
function changeAction(operations: readonly AssistantOperation[]) {
  const phrases = [...new Set(operations.map(operationPhrase))];
  if (phrases.length <= 1) return phrases[0];
  const more = phrases.length - 1;
  return `${phrases[0]} und ${more === 1 ? "eine weitere Änderung" : `${more} weitere Änderungen`}`;
}

/** The name of a called tool or lookup, as in the tool list. */
export const callLabel = (tool: string) => isAssistantTool(tool) ? toolLabel[tool] : lookupLabel[tool] ?? tool;

/** The answer every tool gives when it throws. */
export const failedAnswer = (text: string) => /^Dabei ist etwas schiefgegangen/m.test(text);

/**
 * One tool call for the run's record: tool, success and a short action phrase. The phrase comes from the tool or the kinds of
 * operations of its change, never from arguments, amounts or the user's words. `empty`: a lookup that worked but found nothing.
 */
export function toolCall(tool: string, { ok = true, change, empty = false }: { ok?: boolean; change?: Pick<AssistantChange, "operations">; empty?: boolean } = {}): AssistantToolCall {
  const summary = (change ? changeAction(change.operations) : undefined) ?? (empty ? emptyAction[tool] : undefined) ?? callAction[tool] ?? callLabel(tool);
  return { tool: tool.slice(0, 40), ok, summary: summary.slice(0, 80) };
}

export const viaLabel: Record<RouteVia, string> = { rule: "Regel", signal: "Signalwort", model: "Modell", fallback: "Rückfall" };

/** The orchestrator's decision steps, in the order it tries them. */
export const orchestratorSteps: { title: string; detail: string; calls: string }[] = [
  { title: "Regeln", detail: "Begrüßung, fachfremde Themen, klare Befehle, Folgefragen", calls: "0 KI" },
  { title: "Signalwörter", detail: "Genau ein Spezialist passt, oder gar kein Geldthema", calls: "0 KI" },
  { title: "Modell-Rückfall", detail: "Ein Wort, höchstens 8 Token – im Zweifel Chat", calls: "1 KI" },
];

export const agentOrder: readonly AgentId[] = [...specialistIds, "general"];
export const agentToolList = (agent: AgentId) => agentTools(agent).filter((tool) => tool !== "ask" || agent === "general");

export type RunStatus = "answered" | "question" | "unclear" | "error";
export const runStatusLabel: Record<RunStatus, string> = {
  answered: "Beantwortet", question: "Rückfrage", unclear: "Nicht verstanden", error: "Fehler",
};
/** How a call ended; a call that changes data follows its answer: open, applied, dismissed or undone. */
export type CallState = "ok" | "failed" | "pending" | "applied" | "dismissed" | "undone";
export const callStateLabel: Record<CallState, string> = {
  ok: "Erfolgreich", failed: "Fehlgeschlagen", pending: "Wartet auf Bestätigung", applied: "Übernommen", dismissed: "Verworfen", undone: "Rückgängig gemacht",
};
export type RunCall = { tool: string; label: string; summary: string; state: CallState };
/** A model that worked on the run: its label, the task ("Werkzeugwahl", "Antwort" …) and whether it stepped in as fallback. */
export type RunModel = { label: string; model: string; task: string; fallback: boolean; reason?: string };
export type AssistantRun = {
  id: string;
  at: number;
  question: string;
  agent?: AgentId;
  via?: RouteVia;
  status: RunStatus;
  /** Roughly from sending the question to the answer, in milliseconds. */
  ms?: number;
  /** The tools the run called, in order; older answers only know the one tool that answered. */
  calls: RunCall[];
  /** The models of the run in order; empty for runs the rules answered alone and for older runs. */
  models: RunModel[];
};

const isAgent = (value: unknown): value is AgentId => typeof value === "string" && (agentIds as readonly string[]).includes(value);

function statusOf(reply: AssistantMessage): RunStatus {
  if (reply.correcting) return "unclear";
  if (failedAnswer(reply.text)) return "error";
  if (reply.draft && reply.status === "question" || reply.clarify) return "question";
  return "answered";
}

const changeState: Record<NonNullable<AssistantMessage["status"]>, CallState> = {
  question: "pending", preview: "pending", created: "applied", applied: "applied", dismissed: "dismissed", undone: "undone",
};
function runCalls(reply: AssistantMessage): RunCall[] {
  const calls = reply.calls ?? (reply.tool ? [toolCall(reply.tool, { ok: !failedAnswer(reply.text), change: reply.change })] : []);
  return calls.map((call) => ({ tool: call.tool, label: callLabel(call.tool), summary: call.summary,
    state: !call.ok ? "failed" : isAssistantTool(call.tool) && changesData(call.tool) && reply.status ? changeState[reply.status] : "ok" }));
}

const runModel = (use: ModelUse): RunModel => ({ label: modelTitle(use), model: use.model, task: taskLabel[use.task], fallback: !!use.fallback,
  ...(use.reason ? { reason: use.reason } : {}) });

/** The latest runs, newest first: each question with the first answer that followed it and the tools of all its answers. */
export function assistantRuns(chat: readonly AssistantMessage[], limit = 50): AssistantRun[] {
  const runs: AssistantRun[] = [];
  chat.forEach((message, index) => {
    if (message.role !== "user") return;
    const reply = chat.slice(index + 1).find((item) => item.role === "assistant");
    const next = chat.slice(index + 1).findIndex((item) => item.role === "user");
    if (!reply || next >= 0 && chat.indexOf(reply) > index + 1 + next) return;
    const ms = reply.ms ?? (reply.at >= message.at ? reply.at - message.at : undefined);
    const replies = chat.slice(index + 1, next >= 0 ? index + 1 + next : undefined).filter((item) => item.role === "assistant");
    runs.push({
      id: message.id, at: message.at, question: message.text, status: statusOf(reply),
      ...(isAgent(reply.agent) ? { agent: reply.agent } : {}), ...(reply.via ? { via: reply.via } : {}),
      ...(ms !== undefined ? { ms } : {}), calls: replies.flatMap(runCalls).slice(0, 8),
      models: replies.flatMap((item) => item.models ?? []).slice(0, 4).map(runModel),
    });
  });
  return runs.reverse().slice(0, limit);
}
