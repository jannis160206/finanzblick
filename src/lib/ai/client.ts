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
};

// Qwen3 can emit a reasoning block even when thinking is disabled.
export function stripThinking(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export async function chat(messages: ChatMessage[], options: ChatOptions = {}) {
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
        model: config.model,
        messages,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0,
        stream: false,
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
  const parsed = completionSchema.parse(await response.json());
  const message = parsed.choices[0].message;
  return {
    content: stripThinking(message.content ?? ""),
    toolCalls: (message.tool_calls ?? []) as ToolCall[],
  };
}

export type AiStatus = { available: boolean; model: string; device: "NPU"; error?: string };

export async function aiStatus(config = readAiConfig(), fetcher: typeof fetch = fetch): Promise<AiStatus> {
  const base = { model: config.model, device: "NPU" as const };
  if (!config.enabled) return { ...base, available: false, error: "deaktiviert" };
  try {
    const root = config.baseUrl.replace(/\/v3$/, "");
    const response = await fetcher(`${root}/v1/config`, { signal: AbortSignal.timeout(2_000), cache: "no-store" });
    if (!response.ok) return { ...base, available: false, error: `HTTP ${response.status}` };
    const body = await response.json() as Record<string, { model_version_status?: { state?: string }[] }>;
    const state = body[config.model]?.model_version_status?.[0]?.state;
    return state === "AVAILABLE" ? { ...base, available: true } : { ...base, available: false, error: state ?? "Modell nicht geladen" };
  } catch {
    return { ...base, available: false, error: "nicht erreichbar" };
  }
}
