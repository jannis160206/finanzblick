import { z } from "zod";
import { assistantDraftSchema, dateSchema, type AssistantDraft } from "@/lib/types";
import { groundModelExtraction, mergeDraft, missingField, missingQuestion, parseAssistantMessage, type ModelExtraction } from "@/lib/assistant/intent";
import { normalizeMessage } from "@/lib/assistant/normalize";
import { agentTools, chatRequest, orchestrate, parseAgent, routeByRules, routeBySignals, toolOwner, type AgentId, type RouteDecision, type RouteVia } from "@/lib/assistant/orchestrator";
import { detectTool, isAssistantTool, isDraftTool, matchName, splitCommands, type AssistantTool } from "@/lib/assistant/tools";
import { changingTools } from "@/lib/assistant/conversation";
import { categories } from "@/lib/categories";
import { rulesFor, rulesSection, type RuleText } from "@/lib/assistant/feedback-rules";
import { chat, cloudPause, type ChatMessage, type ChatOptions } from "./client";
import { readAiConfig } from "./config";
import type { AiTask, ModelUse } from "./models";
import type { PromptOverrides } from "./agent-prompts";
import { interpretPrompt, orchestratorPrompt, scopeNeeds } from "./specialists";
import { cleanUntrusted } from "./untrusted";

export const assistantRequestSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  asOf: dateSchema,
  pending: assistantDraftSchema.optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(800) }).strict()).max(8).optional(),
  // The message corrects or narrows the previous answer ("Nein, ich meine …"); without DeepSeek no rule reads it as a new request.
  correction: z.boolean().optional(),
  // The orchestrator handed a change to the change workflow: the details are read here, the preview asks first.
  delegated: z.boolean().optional(),
  // Names the model may refer to; nothing else from the data leaves the browser.
  context: z.object({
    goals: z.array(z.string().max(80)).max(50),
    planned: z.array(z.string().max(100)).max(60),
  }).strict().optional(),
}).strict();
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export type AssistantHints = { goal?: string; planned?: string; category?: string; merchant?: string };
/** Model options plus the active rules learned from feedback (the server loads them; the eval passes its own). */
export type AssistantOptions = ChatOptions & { rules?: readonly RuleText[]; prompts?: PromptOverrides };
/** `agent` answers the message; `via` says who decided (rule, the orchestrator for a change, or locally: signal word, model, fallback). */
export type AssistantReply = {
  agent: AgentId; via: RouteVia; tool?: AssistantTool; hints?: AssistantHints; draft?: AssistantDraft; question?: string; source: "KI" | "Regel";
  /** The models that worked on the message (cloud model or the local fallback). */
  models?: ModelUse[];
  /** The agents were meant to answer but are unavailable: the local routing decided, and the browser answers as without DeepSeek. */
  local?: true;
};

const modelSchema = z.object({
  tool: z.string().nullish(),
  goal: z.string().nullish(),
  planned: z.string().nullish(),
  category: z.string().nullish(),
  merchant: z.string().nullish(),
  action: z.string().nullish(),
  name: z.string().nullish(),
  amount: z.number().nullish(),
  monthly: z.number().nullish(),
  startCapital: z.number().nullish(),
  installments: z.number().nullish(),
  fromAccount: z.string().nullish(),
  shared: z.boolean().nullish(),
  whatIf: z.boolean().nullish(),
}).passthrough();

export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

// Words the model sometimes takes for a merchant ("Wofür geb ich am meisten Geld aus", "über 100 Euro").
const genericWords = new Set(["geld", "euro", "eur", "ausgaben", "ausgabe", "buchungen", "buchung", "sachen", "zeug", "kategorie", "kategorien", "monat", "jahr", "konto", "konten", "zahlungen"]);

// Tools whose local execution reads model hints (names, category, merchant); all others are decided by the rules alone.
export const hintTools: readonly AssistantTool[] = ["query", "edit", "booking", "rule"];

const fold = (value: string) => value.toLowerCase().normalize("NFKC");

// The model may only name things that really exist and appear in the message; everything else is dropped.
function groundHints(model: Pick<z.infer<typeof modelSchema>, "goal" | "planned" | "category" | "merchant"> | undefined, input: AssistantRequest): AssistantHints {
  if (!model) return {};
  const hints: AssistantHints = {};
  const text = input.message;
  const goal = model.goal ? matchName(`${model.goal}`, input.context?.goals ?? [], (name) => name) : undefined;
  if (goal && matchName(text, [goal], (name) => name)) hints.goal = goal;
  const planned = model.planned ? matchName(`${model.planned}`, input.context?.planned ?? [], (name) => name) : undefined;
  if (planned && matchName(text, [planned], (name) => name)) hints.planned = planned;
  const category = model.category?.trim();
  if (category && (categories as readonly string[]).includes(category)) hints.category = category;
  const merchant = model.merchant?.trim();
  if (merchant && !genericWords.has(fold(merchant)) && merchant.length >= 2 && merchant.length <= 60 && fold(text).includes(fold(merchant))) hints.merchant = merchant;
  return hints;
}

const historyLines = (input: AssistantRequest, count: number) => (input.history ?? []).slice(-count)
  .map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${item.role === "user" ? item.text : cleanUntrusted(item.text)}`);

// With DeepSeek, one call answers (the local main model steps in on failure). Locally, the small router model is tried
// first when configured; the main model steps in only if it fails.
async function ask<T>(messages: ChatMessage[], options: ChatOptions, maxTokens: number, read: (content: string) => T | undefined, task: AiTask): Promise<T | undefined> {
  const run = async (name?: string) => read((await chat(messages, { ...options, task, ...(name ? { model: name } : {}), maxTokens, temperature: 0 })).content);
  const config = options.config ?? readAiConfig();
  const routerModel = config.cloud && !options.localOnly && !cloudPause() ? undefined : config.routerModel;
  if (routerModel) {
    try {
      return await run(routerModel);
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
  }
  try {
    return await run();
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return undefined;
  }
}

/** The orchestrator's model fallback: one short call that names the agent; unsure or unreachable means general chat. */
export async function classifyAgent(input: AssistantRequest, options: AssistantOptions = {}): Promise<AgentId | undefined> {
  const messages: ChatMessage[] = [
    { role: "system", content: orchestratorPrompt(options.prompts) + rulesSection(rulesFor(options.rules, undefined, "routing")) },
    { role: "user", content: [...historyLines(input, 1).map((line) => `Davor: ${line.slice(0, 240)}`), `Nachricht: ${input.message}`].join("\n") },
  ];
  return ask(messages, options, 8, parseAgent, "route");
}

// Changing data, a form in progress or several commands in one message: the stronger model plans the action.
const actionWords = /(?<![\p{L}\d])(?:leg\p{L}*|anleg\p{L}*|erstell\p{L}*|lösch\p{L}*|loesch\p{L}*|änder\p{L}*|aender\p{L}*|setz\p{L}*|verschieb\p{L}*|trag\p{L}*|eintrag\p{L}*|kündig\p{L}*|buch\p{L}* um|teil\p{L}* auf)(?![\p{L}\d])/iu;
export function interpretTask(message: string, ruleTool: AssistantTool | undefined, pending: boolean, names: string[] = []): AiTask {
  if (pending || ruleTool && changingTools.includes(ruleTool)) return "action";
  if ((splitCommands(message, names)?.length ?? 0) > 1) return "action";
  return actionWords.test(message) ? "action" : "route";
}

export async function interpretAssistantMessage(request: AssistantRequest, options: AssistantOptions = {}): Promise<AssistantReply> {
  const models: ModelUse[] = [];
  const reply = await interpret(request, { ...options, trace: models });
  options.trace?.push(...models);
  return models.length ? { ...reply, models } : reply;
}

/** A change the orchestrator handed to the change workflow, with the specialist that fills it in. */
type ChangePlan = { kind: "action"; agent: AgentId };

async function interpret(request: AssistantRequest, options: AssistantOptions): Promise<AssistantReply> {
  // Casual spellings ("wv", "fuer", "3k", "Juli 27") are normalized once so rules, model and grounding see the same text.
  const input: AssistantRequest = { ...request, message: normalizeMessage(request.message) };
  const parsed = parseAssistantMessage(input.message, input.asOf);
  const names = [...(input.context?.goals ?? []), ...(input.context?.planned ?? [])];
  const detected = detectTool(input.message, names);
  // System commands by rule; an open draft stays with its specialist. A change the orchestrator handed over goes to the change
  // workflow; any other message only comes here without DeepSeek (or when the agents failed) and is routed locally.
  const handoff: ReturnType<typeof orchestrate> | undefined = input.pending || input.delegated ? undefined : orchestrate(input.message, names);
  const plan: ChangePlan | undefined = input.delegated && !input.pending
    ? { kind: "action", agent: detected ? toolOwner[detected] : routeBySignals(input.message, names)?.agent ?? "general" } : undefined;
  // Without DeepSeek a correction is answered in words with the conversation, never by the tool its words look like.
  if (input.correction && !plan) return { agent: routeBySignals(input.message, names)?.agent ?? "general", via: "fallback", source: "Regel", local: true };
  const local = handoff?.to === "agents" ? { local: true as const } : {};
  const reply = await specialist(input, parsed, names, detected, handoff, plan, options);
  return { ...reply, ...local };
}

async function specialist(input: AssistantRequest, parsed: ReturnType<typeof parseAssistantMessage>, names: string[], detected: AssistantTool | undefined,
  handoff: ReturnType<typeof orchestrate> | undefined, plan: ChangePlan | undefined, options: AssistantOptions): Promise<AssistantReply> {
  // "Schreib mir ein Gedicht über Sparen" is a chat request, not a savings goal.
  if (!input.pending && !plan && chatRequest(input.message)) return { agent: "general", via: "rule", source: "Regel" };
  // A change the orchestrator handed over is filled in by its specialist; a reading tool the rules saw does not override it.
  const ruleTool = plan && detected && !changingTools.includes(detected) ? undefined : detected;
  // Clear non-draft commands whose tool reads no model hints are answered without waiting for the model, also after a handover.
  if (ruleTool && !input.pending && !isDraftTool(ruleTool) && !hintTools.includes(ruleTool))
    return { agent: toolOwner[ruleTool], via: plan ? "orchestrator" : "rule", tool: ruleTool, hints: {}, source: plan ? "KI" : "Regel" };
  // A plain answer to the open draft's question ("3000 €", "bis Juni 2027", "Urlaub in Japan") needs no model: the rules fill it in.
  if (input.pending && !ruleTool) {
    const quick = mergeDraft(input.pending, { ...parsed, action: parsed.action ?? input.pending.action }, {}, input.message, input.asOf);
    if (quick && quick.action === input.pending.action && missingField(quick) !== missingField(input.pending)) {
      const question = missingQuestion(quick);
      return { agent: toolOwner[quick.action], via: "rule", tool: quick.action, hints: {}, draft: quick, ...(question ? { question } : {}), source: "Regel" };
    }
  }
  // The specialist who works on it: for a handed-over change the tool's owner, an open draft's owner, a system command, and
  // without DeepSeek the local routing (rule tool, small talk and signal words).
  const decision: RouteDecision | undefined = plan ? { agent: ruleTool ? toolOwner[ruleTool] : plan.agent, via: "orchestrator" }
    : input.pending ? { agent: toolOwner[input.pending.action], via: "rule" }
    : handoff?.to === "specialist" ? handoff.decision
    : ruleTool ? { agent: toolOwner[ruleTool], tool: ruleTool, via: "rule" } : routeByRules(input.message, names);
  if (!decision) {
    // Still unclear: one short model call picks the agent, which then answers in words. No second interpretation.
    const agent = await classifyAgent(input, options);
    return agent ? { agent, via: "model", source: "KI" } : { agent: "general", via: "fallback", source: "Regel" };
  }
  const { agent, via } = decision;
  if (!plan && !ruleTool && !input.pending && agent === "general") return { agent, via, source: "Regel" };
  // The specialist interprets the message with its own tools only.
  const needs = scopeNeeds(agent);
  const messages: ChatMessage[] = [
    { role: "system", content: interpretPrompt(agent, rulesFor(options.rules, agent, "routing"), options.prompts) },
    { role: "user", content: [
      `Heute: ${input.asOf}`,
      needs.names ? (input.context?.goals.length ? `Sparziele: ${input.context.goals.join(", ")}` : "Sparziele: keine") : "",
      needs.names && input.context?.planned.length ? `Geplante Ausgaben: ${input.context.planned.join(", ")}` : "",
      needs.categories ? `Kategorien: ${categories.join(", ")}` : "",
      input.pending ? `Offener Entwurf: ${JSON.stringify(input.pending)}` : "",
      input.history?.length ? `Verlauf:\n${historyLines(input, 4).join("\n")}` : "",
      `In der Nachricht gefundene Beträge: ${parsed.numbers.join(", ") || "keine"}`,
      `Nachricht: ${input.message}`,
    ].filter(Boolean).join("\n") },
  ];
  const model = await ask(messages, options, 300, (content) => {
    const candidate = modelSchema.safeParse(extractJsonObject(content));
    return candidate.success ? candidate.data : undefined;
  }, plan ? "action" : interpretTask(input.message, ruleTool, !!input.pending, names));
  const source: AssistantReply["source"] = model ? "KI" : "Regel";
  // Only the specialist's own tools count; "ask" or anything else means: answer in words.
  const own = (value: unknown): AssistantTool | undefined => isAssistantTool(value) && value !== "ask" && agentTools(agent).includes(value) ? value : undefined;
  const modelTool = own(model?.tool) ?? own(model?.action);
  // Clear commands stay deterministic; an open draft keeps priority for answers to its question.
  let tool: AssistantTool | undefined = ruleTool ?? modelTool;
  if (input.pending && (!ruleTool || isDraftTool(ruleTool)) && (!modelTool || isDraftTool(modelTool))) tool = ruleTool ?? input.pending.action;
  const hints = groundHints(model, input);
  if (!tool) return { agent, via, hints, source };
  if (!isDraftTool(tool)) return { agent, via, tool, hints, source };
  const extraction: ModelExtraction | undefined = model ? { ...model, action: tool } : undefined;
  const grounded = groundModelExtraction(extraction, parsed, input.message);
  const draft = mergeDraft(input.pending, { ...parsed, action: parsed.action ?? tool }, grounded, input.message, input.asOf);
  if (!draft) return { agent, via, tool, hints, source };
  const question = missingQuestion(draft);
  return { agent, via, tool: draft.action, hints, draft, ...(question ? { question } : {}), source };
}
