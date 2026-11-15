import { changingTools } from "@/lib/assistant/conversation";
import { rulesSection } from "@/lib/assistant/feedback-rules";
import { agentIds, agentLabel, agentTools, agentWords, amountTools, parseAgent, toolOwner, type AgentId } from "@/lib/assistant/orchestrator";
import { assistantTools, isAssistantTool, toolDescriptions, type AssistantTool } from "@/lib/assistant/tools";
import { promptText, type PromptOverrides } from "./agent-prompts";
import { AiUnavailableError, chat, type ChatOptions } from "./client";
import { cleanFacts, cleanUntrusted, DATA_RULE } from "./untrusted";

/**
 * The supervisor (DeepSeek V4 Pro) decides for every message that is no clear change what the answer needs: it sees an
 * overview of the user's data and picks up to four reading steps – the specialists' tools on the user's own data, the local
 * finance knowledge or the web – whose raw results it then turns into the answer. A change goes to the owning specialist,
 * and only a truly missing detail becomes a question back. It never runs a changing tool: changes keep their confirmation.
 */

/** Tools a worker may run for the supervisor: everything that changes nothing. */
export const readingTools: readonly AssistantTool[] = assistantTools.filter((tool) => tool !== "ask" && !changingTools.includes(tool));
export type WorkerTool = AssistantTool | "web";
export type SupervisorStep = { tool: WorkerTool; question: string };
export const MAX_STEPS = 4;

export type Supervision =
  | { kind: "answer"; agent: AgentId; steps: SupervisorStep[] }
  | { kind: "action"; agent: AgentId }
  | { kind: "ask"; agent: AgentId; question: string };

export type SupervisorInput = {
  message: string;
  history?: { role: "user" | "assistant"; text: string }[];
  context?: { goals: string[]; planned: string[] };
  /** A compact overview of the user's data (accounts, month, budgets, contracts, goals, forecast, salary, latest bookings). */
  overview?: Record<string, unknown>;
  /** The tool the fixed rules recognised; the supervisor may keep it or decide otherwise. */
  hint?: AssistantTool;
  /** The message corrects or narrows the previous answer ("Nein, ich meine …"). */
  correction?: boolean;
};

/** How much of the conversation the supervisor and the answer see: the last eight messages. */
export const HISTORY_MESSAGES = 8;
// Corrections need the whole conversation understood: V4 Pro plans them, everything else the fast model.
const correctionNote = "Korrektur: Die Nachricht korrigiert oder präzisiert deine vorige Antwort. Lies im Verlauf, was der Nutzer ursprünglich wollte, " +
  "und erledige genau diese Aufgabe mit der Korrektur neu: Thema, Zeitraum, Konto und Händler bleiben, nur das Korrigierte ändert sich, und du holst alle " +
  "Daten und Recherchen, die die ursprüngliche Aufgabe braucht (sucht er etwa ein günstigeres Angebot, auch web). Wähle art antwort – eine aktion nur, " +
  "wenn er ausdrücklich etwas anlegen, ändern oder löschen lassen will.";

const team = agentIds.map((agent) => `${agentWords[agent]} (${agentLabel[agent]}): ` + agentTools(agent).filter((tool) => tool !== "ask")
  .map((tool) => `${tool}${changingTools.includes(tool) ? "*" : ""} = ${toolDescriptions[tool]}`).join("; ")).join("\n") +
  "\nweb = Websuche: aktuelle Werte (Kurse, Preise, Zinsen, Steuersätze, Nachrichten), Begriffe, Produkte, Regeln und alles, was recherchiert werden muss";

/** The supervisor's system prompt: the editable text with the team and the calculators filled in, then the data rule. */
export function supervisorPrompt(prompts?: PromptOverrides): string {
  const text = promptText("supervisor", prompts);
  const filled = text.includes("{werkzeuge}") ? text.replace("{werkzeuge}", team) : `${text}\nSpezialisten und Werkzeuge (* = ändert Daten):\n${team}`;
  return `${filled.replace("{rechner}", amountTools.join(", ")).trim()} ${DATA_RULE}`;
}

const kinds: Record<string, Supervision["kind"]> = {
  antwort: "answer", answer: "answer", werkzeug: "answer", tool: "answer", aktion: "action", action: "action", rueckfrage: "ask", "rückfrage": "ask", ask: "ask",
};
const isWorkerTool = (value: unknown): value is WorkerTool => value === "web" || isAssistantTool(value) && readingTools.includes(value);
const text = (value: unknown, max: number) => typeof value === "string" ? cleanUntrusted(value, max) : "";
// A calculator without an amount could only ask for one; the monthly plan shows what is free instead.
const worker = (tool: WorkerTool, question: string): WorkerTool => tool !== "web" && amountTools.includes(tool) && !/\d/.test(question) ? "budget" : tool;
const entries = (raw: unknown) => (Array.isArray(raw) ? raw : []).filter((item): item is Record<string, unknown> => !!item && typeof item === "object");

/**
 * Reading steps only, each with its own question, no repeats, a calculator only with an amount, at most four. A term looked
 * up in the local knowledge is always researched on the web, too.
 */
export function cleanSteps(raw: unknown): SupervisorStep[] {
  const steps: SupervisorStep[] = [];
  for (const item of entries(raw)) {
    const named = item.werkzeug ?? item.tool;
    const question = text(item.frage ?? item.question, 200);
    if (!isWorkerTool(named) || question.length < 3) continue;
    const tool = worker(named, question);
    if (steps.some((step) => step.tool === tool && (tool !== named || step.question === question))) continue;
    steps.push({ tool, question });
  }
  const term = steps.find((step) => step.tool === "knowledge");
  if (term && !steps.some((step) => step.tool === "web")) steps.splice(steps.indexOf(term) + 1, 0, { tool: "web", question: term.question });
  return steps.slice(0, MAX_STEPS);
}

// A price, an amount or a duration is never worth a question back: the user's own figures show what is possible.
const amountQuestion = /^(?:(?:und|okay|ok|gut),?\s+)?(?:wie ?viel|wie hoch|wie teuer|wie lange|was kostet|was (?:soll|darf|würde|wird)\b.*\bkosten|(?:über |für )?welche[nrs]? (?:betrag|summe|preis|rate|laufzeit|zeitraum))\b/i;
const lookup: Record<AgentId, AssistantTool> = { transactions: "query", contracts: "contracts", budget: "budget", payroll: "payroll", general: "budget" };

/**
 * The model's decision, cleaned: known specialists and reading tools only; anything unclear becomes a written answer, and a
 * question back for an amount or a duration becomes an answer from the user's figures.
 */
export function cleanSupervision(raw: unknown, hint?: AssistantTool, message?: string): Supervision | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const steps = cleanSteps(entry.schritte ?? entry.steps);
  const named = parseAgent(text(entry.spezialist ?? entry.agent, 40));
  const first = steps.find((step) => step.tool !== "web")?.tool as AssistantTool | undefined;
  const agent = named ?? (first ? toolOwner[first] : hint ? toolOwner[hint] : "general");
  const kind = kinds[text(entry.art ?? entry.kind, 20).toLowerCase()] ?? "answer";
  if (kind === "action") return { kind, agent: hint && changingTools.includes(hint) ? toolOwner[hint] : agent };
  const question = text(entry.rueckfrage ?? entry.question, 200);
  if (kind === "ask" && amountQuestion.test(question))
    return { kind: "answer", agent, steps: steps.length || !message ? steps : [{ tool: lookup[agent], question: cleanUntrusted(message, 200) }] };
  if (kind === "ask" && question.length >= 8 && question.endsWith("?")) return { kind, agent, question };
  return { kind: "answer", agent, steps };
}

function parseJson(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// The overview goes along as JSON; an unexpectedly large one is left out rather than cut in half.
function overviewLine(overview: Record<string, unknown> | undefined): string {
  if (!overview) return "";
  const json = JSON.stringify(cleanFacts(overview, 200));
  return json.length <= 8000 ? `Datenüberblick (JSON): ${json}` : "";
}

/** One call to the supervisor; DeepSeek only. Without it (or without a readable plan) the caller routes locally. */
export async function supervise(input: SupervisorInput, options: ChatOptions & { rules?: readonly string[]; prompts?: PromptOverrides } = {}): Promise<Supervision> {
  const { rules = [], prompts, ...chatOptions } = options;
  const history = (input.history ?? []).slice(-HISTORY_MESSAGES)
    .map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${item.role === "user" ? item.text.slice(0, 400) : cleanUntrusted(item.text, 500)}`);
  const reply = await chat([
    { role: "system", content: supervisorPrompt(prompts) + rulesSection(rules) },
    { role: "user", content: [
      overviewLine(input.overview),
      input.context?.goals.length ? `Sparziele: ${input.context.goals.join(", ")}` : "",
      input.context?.planned.length ? `Geplante Ausgaben: ${input.context.planned.join(", ")}` : "",
      history.length ? `Verlauf:\n${history.join("\n")}` : "",
      input.hint ? `Die Regeln würden ${input.hint} nehmen (${toolDescriptions[input.hint]}).` : "",
      input.correction ? correctionNote : "",
      `Nachricht: ${input.message}`,
    ].filter(Boolean).join("\n") },
  ], { task: "supervise", cloudOnly: true, maxTokens: 320, temperature: 0, ...(input.correction ? { tier: "pro" as const } : {}), ...chatOptions });
  const plan = cleanSupervision(parseJson(reply.content), input.hint, input.message);
  if (!plan) throw new AiUnavailableError("Der Supervisor hat keinen lesbaren Plan geliefert.");
  return plan;
}
