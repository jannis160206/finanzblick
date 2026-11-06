import { z } from "zod";
import { readAiConfig, type AiConfig } from "./config";

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export class AiUnavailableError extends Error {}

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullish(),
      tool_calls: z.array(z.object({
        id: z.string(),
        type: z.literal("function").default("function"),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).nullish(),
    }),
  })).min(1),
});

export type ChatOptions = {
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  config?: AiConfig;
  fetcher?: typeof fetch;
  // Overrides config.model, e.g. for the small router model.
  model?: string;
};

// Qwen3 can emit a reasoning block even when thinking is disabled.
export function stripThinking(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function post(messages: ChatMessage[], options: ChatOptions, stream: boolean) {
  const config = options.config ?? readAiConfig();
  if (!config.enabled) throw new AiUnavailableError("Die lokale KI ist deaktiviert.");
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model ?? config.model,
        messages,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0,
        stream,
        chat_template_kwargs: { enable_thinking: false },
        ...(options.tools?.length ? { tools: options.tools, tool_choice: "auto" } : {}),
      }),
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AiUnavailableError(timeout.aborted
      ? "Die lokale KI hat nicht rechtzeitig geantwortet."
      : "Die lokale KI ist nicht erreichbar. Läuft `npm run ai:server`?");
  }
  if (!response.ok)
    throw new AiUnavailableError(`Die lokale KI hat mit HTTP ${response.status} geantwortet.`);
  return response;
}

export async function chat(messages: ChatMessage[], options: ChatOptions = {}) {
  const response = await post(messages, options, false);
  const parsed = completionSchema.parse(await response.json());
  const message = parsed.choices[0].message;
  return {
    content: stripThinking(message.content ?? ""),
    toolCalls: (message.tool_calls ?? []) as ToolCall[],
  };
}

// Splits OpenAI-style server-sent events into text deltas; `rest` keeps an incomplete last line for the next chunk.
export function parseSse(buffer: string): { deltas: string[]; rest: string; done: boolean } {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  const deltas: string[] = [];
  let done = false;
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") { done = true; break; }
    try {
      const content = (JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta?.content;
      if (typeof content === "string" && content) deltas.push(content);
    } catch {
      // Keep-alive or malformed lines carry no text.
    }
  }
  return { deltas, rest, done };
}

// Streams the raw model text piece by piece (no thinking removal; callers decide what to show).
export async function* chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string> {
  const response = await post(messages, options, true);
  if (!response.body) throw new AiUnavailableError("Die lokale KI hat keine Antwort gestreamt.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      const parsed = parseSse(buffer + (value ?? "") + (done ? "\n" : ""));
      buffer = parsed.rest;
      yield* parsed.deltas;
      if (parsed.done || done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export type AiStatus = { available: boolean; model: string; device: "NPU"; error?: string; router?: { model: string; available: boolean } };

export async function aiStatus(config = readAiConfig(), fetcher: typeof fetch = fetch): Promise<AiStatus> {
  const base = { model: config.model, device: "NPU" as const };
  if (!config.enabled) return { ...base, available: false, error: "deaktiviert" };
  try {
    const root = config.baseUrl.replace(/\/v3$/, "");
    const response = await fetcher(`${root}/v1/config`, { signal: AbortSignal.timeout(2_000), cache: "no-store" });
    if (!response.ok) return { ...base, available: false, error: `HTTP ${response.status}` };
    const body = await response.json() as Record<string, { model_version_status?: { state?: string }[] }>;
    const state = body[config.model]?.model_version_status?.[0]?.state;
    const router = config.routerModel
      ? { router: { model: config.routerModel, available: body[config.routerModel]?.model_version_status?.[0]?.state === "AVAILABLE" } } : {};
    return state === "AVAILABLE" ? { ...base, ...router, available: true } : { ...base, ...router, available: false, error: state ?? "Modell nicht geladen" };
  } catch {
    return { ...base, available: false, error: "nicht erreichbar" };
  }
}
