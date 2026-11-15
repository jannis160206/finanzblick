import { answerAgent, CHANGE_TOOL, subagentForTool, type SubagentKey } from "@/lib/agents/registry";
import { callInput } from "@/lib/agents/runtime";
import { orchestrate, type AgentId } from "@/lib/assistant/orchestrator";
import type { RuleText } from "@/lib/assistant/feedback-rules";
import { agentStep, type AgentStepRequest } from "./agent-step";
import { interpretAssistantMessage } from "./assistant";
import { AiUnavailableError, type ChatOptions } from "./client";
import type { ModelUse } from "./models";
import type { RepoLive } from "@/lib/server/agent-repo-store";

/**
 * The agent runtime without the user's data, for the gold eval and the review agent's retest: the orchestrator's first step
 * and, for every specialist it delegated to, that specialist's first step. That shows who answers and with which tools – the
 * tools themselves need the user's data in the browser and do not run here. A change goes through the change workflow.
 */

export type AgentRoute = {
  /** The app agent that leads the answer (the first specialist, or the general chat). */
  agent: AgentId;
  /** local: DeepSeek was unavailable, the local routing decided as in the chat. */
  via: "rule" | "orchestrator" | "local";
  /** The specialists the orchestrator delegated to, with their tasks and the tools they picked. */
  delegated: { agent: SubagentKey; task: string; tools: string[] }[];
  /** Every tool picked: the specialists' tools, or the change workflow's tool. */
  tools: string[];
  change?: { task: string };
  /** The orchestrator's own words when it answered without specialists. */
  text?: string;
  question?: string;
  models: ModelUse[];
};

export type AgentEvalOptions = ChatOptions & { repo: RepoLive; rules?: readonly RuleText[] };
type RouteInput = Pick<AgentStepRequest, "asOf" | "history" | "context" | "correction"> & { message: string };

export async function routeWithAgents(input: RouteInput, options: AgentEvalOptions): Promise<AgentRoute> {
  const names = [...(input.context?.goals ?? []), ...(input.context?.planned ?? [])];
  const models: ModelUse[] = [];
  // System commands stay with the fixed rules, as in the chat.
  if (orchestrate(input.message, names).to === "specialist") {
    const reply = await interpretAssistantMessage({ message: input.message, asOf: input.asOf, ...(input.context ? { context: input.context } : {}) },
      { ...options, prompts: options.repo.prompts });
    return { agent: reply.agent, via: "rule", delegated: [], tools: reply.tool ? [reply.tool] : [], models: reply.models ?? [] };
  }
  let lead: Awaited<ReturnType<typeof agentStep>>;
  try {
    lead = await agentStep({ agent: "orchestrator", asOf: input.asOf, message: input.message, turns: [],
      ...(input.history?.length ? { history: input.history } : {}), ...(input.context ? { context: input.context } : {}), ...(input.correction ? { correction: true } : {}) },
    options);
  } catch (error) {
    if (!(error instanceof AiUnavailableError)) throw error;
    // Without DeepSeek the chat routes locally; the eval does the same.
    const reply = await interpretAssistantMessage({ message: input.message, asOf: input.asOf, ...(input.history?.length ? { history: input.history } : {}),
      ...(input.context ? { context: input.context } : {}) }, { ...options, prompts: options.repo.prompts });
    return { agent: reply.agent, via: "local", delegated: [], tools: reply.tool ? [reply.tool] : reply.draft ? [reply.draft.action] : [], models: reply.models ?? [] };
  }
  models.push(...lead.models);
  const change = lead.calls.find((item) => item.name === CHANGE_TOOL);
  if (change) {
    const reply = await interpretAssistantMessage({ message: input.message, asOf: input.asOf, delegated: true, ...(input.history?.length ? { history: input.history } : {}),
      ...(input.context ? { context: input.context } : {}) }, { ...options, prompts: options.repo.prompts });
    models.push(...reply.models ?? []);
    return { agent: reply.agent, via: "orchestrator", delegated: [], tools: reply.tool ? [reply.tool] : reply.draft ? [reply.draft.action] : [],
      change: { task: callInput(change) || input.message }, ...(reply.question ? { question: reply.question } : {}), models };
  }
  const delegations = lead.calls.flatMap((item) => {
    const agent = subagentForTool(item.name);
    return agent ? [{ agent, task: callInput(item) || input.message }] : [];
  });
  const delegated = await Promise.all(delegations.map(async ({ agent, task }) => {
    const step = await agentStep({ agent, asOf: input.asOf, message: task, question: input.message, turns: [] }, options);
    models.push(...step.models);
    return { agent, task, tools: step.calls.map((item) => item.name) };
  }));
  return { agent: delegated[0] ? answerAgent(delegated[0].agent) : "general", via: "orchestrator", delegated, tools: [...new Set(delegated.flatMap((item) => item.tools))],
    ...(lead.text && !delegated.length ? { text: lead.text } : {}), models };
}

/** How a route reads in the eval log and the review agent's retest. */
export function describeRoute(route: AgentRoute): string {
  if (route.change) return `Änderung → ${route.tools.join(", ") || "Rückfrage"}${route.question ? ` („${route.question}“)` : ""}`;
  if (!route.delegated.length) return route.via === "rule" ? `Regel → ${route.tools.join(", ") || "feste Antwort"}` : `Antwort ohne Spezialisten${route.text ? `: ${route.text.slice(0, 300)}` : ""}`;
  return route.delegated.map((item) => `${item.agent} („${item.task.slice(0, 160)}“) → ${item.tools.join(", ") || "keine Werkzeuge"}`).join("; ");
}

/**
 * The orchestrator's answer from given results, as if a specialist had returned them: for the answer cases of the gold eval and
 * the review agent's retest of an answer rule. Grounded like in the chat.
 */
export async function composeWithAgents(input: { question: string; facts: Record<string, unknown>; agent?: AgentId; asOf: string; history?: AgentStepRequest["history"] },
  options: AgentEvalOptions): Promise<{ text?: string; models: ModelUse[] }> {
  const delegate = { transactions: "umsaetze", contracts: "vertraege", budget: "budget", payroll: "gehalt", general: "recherche" }[input.agent ?? "general"];
  const findings = JSON.stringify(input.facts).slice(0, 5000);
  // The results count as data the answer may quote, like the overview in the chat.
  const step = await agentStep({ agent: "orchestrator", asOf: input.asOf, message: input.question, final: true, overview: input.facts,
    ...(input.history?.length ? { history: input.history } : {}),
    turns: [{ calls: [{ id: "eval_1", name: delegate, arguments: JSON.stringify({ aufgabe: input.question }) }], results: [{ id: "eval_1", content: `Ergebnisse (JSON): ${findings}` }] }] },
  options);
  return { ...(step.text ? { text: step.text } : {}), models: step.models };
}
