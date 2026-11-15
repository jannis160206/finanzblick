import { z } from "zod";
import {
  agentDef, agentSources, agentToolSpecs, answerAgent, dataCatalog, dataSource, isSubagentKey, llmAgentKeys, MAX_KNOWLEDGE_CHARS,
  type AgentLimits, type LlmAgentKey,
} from "@/lib/agents/registry";
import { rulesFor, rulesSection, type RuleText } from "@/lib/assistant/feedback-rules";
import { MAX_PROMPT_PREVIEW } from "@/lib/types";
import { liveConfig, type RepoLive } from "@/lib/server/agent-repo-store";
import { promptText } from "./agent-prompts";
import { groundedText, groundingFor, visiblePrefix } from "./answer";
import { chat, chatAgentStream, type ChatMessage, type ChatOptions, type ToolDefinition } from "./client";
import type { ModelUse } from "./models";
import { cleanEvidence, cleanFacts, cleanUntrusted, DATA_RULE } from "./untrusted";

/**
 * One step of an agent in the runtime: the server builds the agent's system prompt from the agent repo (its prompt, knowledge
 * and data sources, the learned rules), offers its tools with the descriptions the model reads, replays the run so far and asks
 * DeepSeek for the next step – tool calls, or the words. The browser runs the tools on the user's data and calls again (AG-UI
 * "frontend tools"), so no figure needs to live on the server. The orchestrator's words stream and are grounded like every
 * answer: each amount must be in the specialists' raw results, the notes or the data overview.
 */

const MAX_TURNS = 12;
const call = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(40), arguments: z.string().max(2000) }).strict();
export const agentStepSchema = z.object({
  agent: z.enum(llmAgentKeys),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // The orchestrator gets the user's message, a specialist its task.
  message: z.string().trim().min(1).max(1500),
  // A specialist's step: the user's own message, for context next to the orchestrator's task.
  question: z.string().trim().min(1).max(1500).optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(800) }).strict()).max(8).optional(),
  correction: z.boolean().optional(),
  overview: z.record(z.string(), z.unknown()).optional(),
  context: z.object({ goals: z.array(z.string().max(80)).max(50), planned: z.array(z.string().max(100)).max(60) }).strict().optional(),
  // Facts the code computed for the question (arithmetic, an answer the user confirmed earlier, a live lookup that failed).
  notes: z.array(z.string().max(1500)).max(4).optional(),
  turns: z.array(z.object({
    calls: z.array(call).min(1).max(8),
    results: z.array(z.object({ id: z.string().min(1).max(80), content: z.string().max(6000) }).strict()).max(8),
  }).strict()).max(MAX_TURNS),
  // Words now, no more tools: a limit of the run is reached.
  final: z.boolean().optional(),
  // Every raw tool result of the run, for the grounding of the orchestrator's answer.
  evidence: z.string().max(16_000).optional(),
}).strict();
export type AgentStepRequest = z.infer<typeof agentStepSchema>;
export type AgentToolCall = z.infer<typeof call>;

/** `limits` comes first: the browser runs the loop with the agent's live limits from the agent repo. */
export type AgentStepEvent = { limits: AgentLimits } | { prompt: string } | { model: ModelUse } | { delta: string } | { replace: string }
  | { calls: AgentToolCall[] } | { done: true; ok: boolean; text?: string };

// Fixed for the orchestrator: an edited prompt can never drop it.
const grounding = "Zahlen zu den Finanzen des Nutzers nimmst du nur aus den Ergebnissen der Spezialisten, den verlässlichen Hinweisen und dem " +
  "Datenüberblick, genau so geschrieben wie dort; rechne nichts selbst aus und lass weg, was dort nicht steht. Anbieter und Angebote nennst du nur, " +
  "wenn die Recherche sie mit Quelle liefert; einzelne Aktien oder Fonds empfiehlst du nie zum Kauf. ";
const correctionNote = "Die Nachricht korrigiert oder präzisiert deine vorige Antwort: Lies im Verlauf, was der Nutzer ursprünglich wollte, und " +
  "erledige genau diese Aufgabe mit der Korrektur neu – Thema, Zeitraum, Konto und Händler bleiben, nur das Korrigierte ändert sich, und du holst " +
  "alle Daten und Recherchen, die die ursprüngliche Aufgabe braucht. aenderung nur, wenn er ausdrücklich etwas anlegen, ändern oder löschen lassen will.";

function knowledgeSection(repo: RepoLive, agent: LlmAgentKey): string {
  const docs = repo.knowledge[agent] ?? [];
  let used = 0;
  const parts: string[] = [];
  for (const doc of docs) {
    const text = `### ${doc.title}\n${doc.text}`;
    if (used + text.length > MAX_KNOWLEDGE_CHARS) break;
    used += text.length;
    parts.push(text);
  }
  return parts.length ? `\n\nDein Wissen (gepflegt, verlässlich):\n${parts.join("\n\n")}` : "";
}

function sourcesSection(agent: LlmAgentKey): string {
  const lines = agentSources(agent).map((id) => {
    const entry = dataCatalog.find((item) => item.id === id);
    return `- ${dataSource(id).label}: ${entry?.description ?? dataSource(id).detail}`;
  });
  return lines.length ? `\n\nDeine Datenquellen:\n${lines.join("\n")}` : "";
}

/**
 * The system prompt as a run sends it. It holds no figures – only the prompt from the repo, the knowledge, the data sources,
 * the fixed rules and the rules learned from feedback – so the cached prefix stays the same for every question.
 */
export function agentSystemPrompt(agent: LlmAgentKey, repo: RepoLive, rules: readonly RuleText[] = []): string {
  if (agent === "orchestrator") {
    const learned = [...rulesFor(rules, undefined, "routing"), ...rulesFor(rules, undefined, "answer")];
    return `${promptText("agent.orchestrator", repo.prompts).trim()}\n\n${promptText("answer-rules", repo.prompts).trim()} ${grounding}${DATA_RULE}${rulesSection(learned)}`;
  }
  const scope = answerAgent(agent);
  const learned = scope === "general" ? [] : (rules ?? []).filter((rule) => rule.scope === scope).map((rule) => rule.text);
  return `${promptText(`agent.${agent}`, repo.prompts).trim()}${knowledgeSection(repo, agent)}${sourcesSection(agent)}\n\n${DATA_RULE}${rulesSection(learned)}`;
}

/** The agent's tools as function definitions; the description is the repo's, the parameters stay in the code. */
export function agentToolDefinitions(agent: LlmAgentKey, repo: RepoLive): ToolDefinition[] {
  return agentToolSpecs(agent).filter((tool) => tool.kind !== "change").map((tool) => ({
    type: "function",
    function: { name: tool.name, description: repo.tools[tool.name] ?? tool.description,
      parameters: { type: "object", properties: { [tool.param.name]: { type: "string", description: tool.param.description } }, required: [tool.param.name] } },
  }));
}

function overviewLine(overview: Record<string, unknown> | undefined): string {
  if (!overview) return "";
  const json = JSON.stringify(cleanFacts(overview, 200));
  return json.length <= 9000 ? `Datenüberblick (JSON): ${json}` : "";
}

/** The run so far as the model reads it: the task, then every tool call with its result. */
export function agentMessages(input: AgentStepRequest, system: string): ChatMessage[] {
  const orchestrator = input.agent === "orchestrator";
  const history = (input.history ?? []).slice(-8)
    .map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${item.role === "user" ? item.text.slice(0, 400) : cleanUntrusted(item.text, 600)}`);
  const user = orchestrator ? [
    `Heute: ${input.asOf}`,
    overviewLine(input.overview),
    input.context?.goals.length ? `Sparziele: ${input.context.goals.join(", ")}` : "",
    input.context?.planned.length ? `Geplante Ausgaben: ${input.context.planned.join(", ")}` : "",
    history.length ? `Verlauf (das bisherige Gespräch):\n${history.join("\n")}` : "",
    input.notes?.length ? `Verlässliche Hinweise (vom Code):\n${input.notes.map((note) => `- ${cleanUntrusted(note, 1500)}`).join("\n")}` : "",
    input.correction ? correctionNote : "",
    `Nachricht: ${input.message}`,
  ] : [`Heute: ${input.asOf}`, input.question && input.question !== input.message ? `Nachricht des Nutzers (zur Einordnung): ${input.question}` : "",
    `Aufgabe vom Orchestrator: ${input.message}`];
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: user.filter(Boolean).join("\n\n") }];
  for (const turn of input.turns) {
    messages.push({ role: "assistant", content: null, tool_calls: turn.calls.map((item) => ({ id: item.id, type: "function", function: { name: item.name, arguments: item.arguments } })) });
    for (const item of turn.calls) {
      const result = turn.results.find((entry) => entry.id === item.id);
      messages.push({ role: "tool", tool_call_id: item.id, content: cleanEvidence(result?.content ?? "Kein Ergebnis.", 6000) });
    }
  }
  if (input.final || input.turns.length >= MAX_TURNS) messages.push({ role: "user", content: orchestrator
    ? "Schreib jetzt die Antwort aus dem, was da ist; keine weiteren Werkzeuge."
    : "Gib jetzt zurück, was die Werkzeuge ergeben haben; keine weiteren Werkzeuge." });
  return messages;
}

export type AgentStepOptions = ChatOptions & { repo: RepoLive; rules?: readonly RuleText[] };

const callsOf = (calls: { id: string; function: { name: string; arguments: string } }[]): AgentToolCall[] =>
  calls.slice(0, 8).map((item, index) => ({ id: (item.id || `call_${index}`).slice(0, 80), name: item.function.name.slice(0, 40), arguments: item.function.arguments.slice(0, 2000) }));

/**
 * The next step of one agent. The orchestrator's step streams: its words appear sentence by sentence, each grounded; tool calls
 * end the step instead. A specialist's step is one call: tool calls, or its findings for the orchestrator.
 */
export async function* runAgentStep(input: AgentStepRequest, options: AgentStepOptions): AsyncGenerator<AgentStepEvent> {
  const { repo, rules, ...chatOptions } = options;
  const agent = input.agent;
  const config = liveConfig(repo, agent) ?? agentDef(agent).config!;
  const system = agentSystemPrompt(agent, repo, rules);
  const final = !!input.final || input.turns.length >= MAX_TURNS;
  const tools = final ? [] : agentToolDefinitions(agent, repo);
  const messages = agentMessages(input, system);
  const trace: ModelUse[] = [];
  let named = 0;
  const models = function* () {
    while (named < trace.length) yield { model: trace[named++] };
  };
  yield { limits: { maxSteps: config.maxSteps, maxToolCalls: config.maxToolCalls, timeoutMs: config.timeoutMs, maxTokens: config.maxTokens } };
  yield { prompt: system.slice(0, MAX_PROMPT_PREVIEW) };
  // The agent's model from the repo; an eval may force one tier for every agent (the gold eval runs on the fast model).
  const stepOptions: ChatOptions = { temperature: agent === "orchestrator" ? 0.3 : 0, ...chatOptions, task: agent === "orchestrator" ? "orchestrate" : "delegate",
    tier: chatOptions.tier ?? config.tier, maxTokens: config.maxTokens, cloudOnly: true, tools, trace };
  if (isSubagentKey(agent)) {
    const reply = await chat(messages, stepOptions);
    yield* models();
    if (reply.toolCalls.length && !final) {
      yield { calls: callsOf(reply.toolCalls) };
      return;
    }
    const text = reply.content.trim().slice(0, 4000);
    yield text ? { done: true, ok: true, text } : { done: true, ok: false };
    return;
  }
  const facts = cleanFacts(input.overview ?? {}, 1500);
  const evidence = [input.evidence ? cleanEvidence(input.evidence, 16_000) : "", ...(input.notes ?? [])].filter(Boolean).join("\n\n") || undefined;
  const { source, check } = groundingFor(input.message, facts, evidence);
  let content = "";
  let shown = "";
  for await (const piece of chatAgentStream(messages, stepOptions)) {
    yield* models();
    if ("calls" in piece) {
      if (piece.calls.length && !final) {
        yield { calls: callsOf(piece.calls) };
        return;
      }
      break;
    }
    content += piece.text;
    const visible = visiblePrefix(content, source, check);
    if (visible === shown) continue;
    if (visible.startsWith(shown)) yield { delta: visible.slice(shown.length) };
    else yield { replace: visible };
    shown = visible;
  }
  const text = groundedText(content, source, check);
  yield text ? { done: true, ok: true, text } : { done: true, ok: false };
}

/** The whole step at once, for evals and the review agent's retest. */
export type AgentStepResult = { calls: AgentToolCall[]; text?: string; models: ModelUse[]; prompt: string; limits?: AgentLimits };
export async function agentStep(input: AgentStepRequest, options: AgentStepOptions): Promise<AgentStepResult> {
  const result: AgentStepResult = { calls: [], models: [], prompt: "" };
  for await (const event of runAgentStep(input, options)) {
    if ("limits" in event) result.limits = event.limits;
    else if ("prompt" in event) result.prompt = event.prompt;
    else if ("model" in event) result.models.push(event.model);
    else if ("calls" in event) result.calls = event.calls;
    else if ("done" in event && event.text) result.text = event.text;
  }
  return result;
}
