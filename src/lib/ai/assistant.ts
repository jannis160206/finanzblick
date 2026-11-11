import { z } from "zod";
import { assistantDraftSchema, dateSchema, type AssistantDraft } from "@/lib/types";
import { groundModelExtraction, mergeDraft, missingQuestion, parseAssistantMessage, type ModelExtraction } from "@/lib/assistant/intent";
import { normalizeMessage } from "@/lib/assistant/normalize";
import { agentTools, chatRequest, parseAgent, routeByRules, toolOwner, type AgentId, type RouteDecision, type RouteVia } from "@/lib/assistant/orchestrator";
import { detectTool, isAssistantTool, isDraftTool, matchName, type AssistantTool } from "@/lib/assistant/tools";
import { categories } from "@/lib/categories";
import { chat, type ChatMessage, type ChatOptions } from "./client";
import { readAiConfig } from "./config";
import { interpretPrompt, orchestratorPrompt, scopeNeeds } from "./specialists";
import { cleanUntrusted } from "./untrusted";

export const assistantRequestSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  asOf: dateSchema,
  pending: assistantDraftSchema.optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(500) }).strict()).max(6).optional(),
  // Names the model may refer to; nothing else from the data leaves the browser.
  context: z.object({
    goals: z.array(z.string().max(80)).max(50),
    planned: z.array(z.string().max(100)).max(60),
  }).strict().optional(),
}).strict();
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;
export type AssistantHints = { goal?: string; planned?: string; category?: string; merchant?: string };
/** `agent` answers the message; `via` says how the orchestrator decided (rule, signal word, model or fallback). */
export type AssistantReply = {
  agent: AgentId; via: RouteVia; tool?: AssistantTool; hints?: AssistantHints; draft?: AssistantDraft; question?: string; source: "KI" | "Regel";
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
function groundHints(model: z.infer<typeof modelSchema> | undefined, input: AssistantRequest): AssistantHints {
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

// The small router model is tried first when configured; the main model steps in only if it fails.
async function ask<T>(messages: ChatMessage[], options: ChatOptions, maxTokens: number, read: (content: string) => T | undefined): Promise<T | undefined> {
  const run = async (name?: string) => read((await chat(messages, { ...options, ...(name ? { model: name } : {}), maxTokens, temperature: 0 })).content);
  const routerModel = (options.config ?? readAiConfig()).routerModel;
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
export async function classifyAgent(input: AssistantRequest, options: ChatOptions = {}): Promise<AgentId | undefined> {
  const messages: ChatMessage[] = [
    { role: "system", content: orchestratorPrompt },
    { role: "user", content: [...historyLines(input, 1).map((line) => `Davor: ${line.slice(0, 240)}`), `Nachricht: ${input.message}`].join("\n") },
  ];
  return ask(messages, options, 8, parseAgent);
}

export async function interpretAssistantMessage(request: AssistantRequest, options: ChatOptions = {}): Promise<AssistantReply> {
  // Casual spellings ("wv", "fuer", "3k", "Juli 27") are normalized once so rules, model and grounding see the same text.
  const input: AssistantRequest = { ...request, message: normalizeMessage(request.message) };
  const parsed = parseAssistantMessage(input.message, input.asOf);
  const names = [...(input.context?.goals ?? []), ...(input.context?.planned ?? [])];
  // "Schreib mir ein Gedicht über Sparen" is a chat request, not a savings goal.
  if (!input.pending && chatRequest(input.message)) return { agent: "general", via: "rule", source: "Regel" };
  const ruleTool = detectTool(input.message, names);
  // Clear non-draft commands whose tool reads no model hints are answered without waiting for the model.
  if (ruleTool && !input.pending && !isDraftTool(ruleTool) && !hintTools.includes(ruleTool))
    return { agent: toolOwner[ruleTool], via: "rule", tool: ruleTool, hints: {}, source: "Regel" };
  // Orchestrator: an open draft and every rule tool name their owner; otherwise small talk and signal words decide.
  const decision: RouteDecision | undefined = input.pending ? { agent: toolOwner[input.pending.action], via: "rule" }
    : ruleTool ? { agent: toolOwner[ruleTool], tool: ruleTool, via: "rule" } : routeByRules(input.message, names);
  if (!decision) {
    // Still unclear: one short model call picks the agent, which then answers in words. No second interpretation.
    const agent = await classifyAgent(input, options);
    return agent ? { agent, via: "model", source: "KI" } : { agent: "general", via: "fallback", source: "Regel" };
  }
  const { agent, via } = decision;
  if (!ruleTool && !input.pending && agent === "general") return { agent, via, source: "Regel" };
  // The specialist interprets the message with its own tools only.
  const needs = scopeNeeds(agent);
  const messages: ChatMessage[] = [
    { role: "system", content: interpretPrompt(agent) },
    { role: "user", content: [
      `Heute: ${input.asOf}`,
      needs.names ? (input.context?.goals.length ? `Sparziele: ${input.context.goals.join(", ")}` : "Sparziele: keine") : "",
      needs.names && input.context?.planned.length ? `Geplante Ausgaben: ${input.context.planned.join(", ")}` : "",
      needs.categories ? `Kategorien: ${categories.join(", ")}` : "",
      input.pending ? `Offener Entwurf: ${JSON.stringify(input.pending)}` : "",
      input.history?.length ? `Verlauf:\n${historyLines(input, 2).join("\n")}` : "",
      `In der Nachricht gefundene Beträge: ${parsed.numbers.join(", ") || "keine"}`,
      `Nachricht: ${input.message}`,
    ].filter(Boolean).join("\n") },
  ];
  const model = await ask(messages, options, 300, (content) => {
    const candidate = modelSchema.safeParse(extractJsonObject(content));
    return candidate.success ? candidate.data : undefined;
  });
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
