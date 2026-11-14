import { z } from "zod";
import { readAiConfig, type AiConfig, type CloudConfig } from "./config";
import { modelLabel, modelTitle, taskLabel, taskTier, type AiTask, type ModelTier, type ModelUse } from "./models";
import { createPseudonymizer, type Pseudonymizer } from "./pseudonymize";

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

/** A finished completion as a cache stores it; streamed answers are cached as their full text. */
export type CachedReply = { content: string; toolCalls: ToolCall[]; use: ModelUse };
/** Keeps identical requests (same model, messages and limits) from being sent twice, e.g. in evals. */
export type ResponseCache = {
  get: (key: object) => CachedReply | undefined;
  set: (key: object, value: CachedReply) => void;
};

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
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    prompt_cache_hit_tokens: z.number().optional(),
  }).passthrough().nullish(),
});

export type ChatOptions = {
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  config?: AiConfig;
  fetcher?: typeof fetch;
  // Overrides config.model of the local model, e.g. for the small router model.
  model?: string;
  /** What the call is for; picks the cloud model and its thinking mode. Default: chat. */
  task?: AiTask;
  /** Forces one cloud tier for every task, e.g. the gold eval runs on the fast model only. */
  tier?: ModelTier;
  /** Skips the cloud model, e.g. for the local benchmark. */
  localOnly?: boolean;
  /** Every model that answered, including a fallback, is appended here. */
  trace?: ModelUse[];
  cache?: ResponseCache;
};

// Qwen3 can emit a reasoning block even when thinking is disabled.
export function stripThinking(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// --- Cloud health: after a failure the cloud model pauses, so later questions do not wait for it again. ---

type CloudFailureKind = "auth" | "balance" | "rate" | "server" | "network" | "timeout" | "model" | "bad";
class CloudError extends Error {
  constructor(readonly kind: CloudFailureKind, message: string, readonly retryAfterMs?: number) { super(message); }
}
const PAUSE_MS: Record<CloudFailureKind, number> = {
  auth: 10 * 60_000, balance: 10 * 60_000, model: 10 * 60_000, rate: 60_000, server: 60_000, network: 60_000, timeout: 60_000, bad: 0,
};
type CloudHealth = { until: number; reason: string };
const health = globalThis as typeof globalThis & { finanzblickCloudHealth?: CloudHealth; finanzblickAiUsage?: Map<string, TokenUsage> };

/** Why the cloud model is paused right now, if it is. */
export function cloudPause(now = Date.now()): string | undefined {
  const state = health.finanzblickCloudHealth;
  return state && state.until > now ? state.reason : undefined;
}
export function resetCloudHealth() {
  health.finanzblickCloudHealth = undefined;
  (globalThis as typeof globalThis & { finanzblickCloudStatus?: unknown }).finanzblickCloudStatus = undefined;
}
function pauseCloud(error: CloudError) {
  const ms = error.retryAfterMs ?? PAUSE_MS[error.kind];
  if (ms > 0) health.finanzblickCloudHealth = { until: Date.now() + ms, reason: error.message };
}

function httpFailure(status: number, retryAfter: string | null): CloudError {
  const seconds = Number(retryAfter);
  const retry = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * 1000 : undefined;
  if (status === 401 || status === 403) return new CloudError("auth", `Key ungültig (HTTP ${status})`);
  if (status === 402) return new CloudError("balance", "Guthaben aufgebraucht (HTTP 402)");
  if (status === 429) return new CloudError("rate", "Rate-Limit (HTTP 429)", retry);
  if (status === 404) return new CloudError("model", "Modell unbekannt (HTTP 404)");
  if (status >= 500) return new CloudError("server", `Dienst gestört (HTTP ${status})`, retry);
  return new CloudError("bad", `Anfrage abgelehnt (HTTP ${status})`);
}

// --- Token usage, for the eval report and the logs. ---

export type TokenUsage = { calls: number; input: number; output: number; cached: number };
function countUsage(model: string, usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | null) {
  const totals = (health.finanzblickAiUsage ??= new Map());
  const entry = totals.get(model) ?? { calls: 0, input: 0, output: 0, cached: 0 };
  entry.calls += 1;
  entry.input += usage?.prompt_tokens ?? 0;
  entry.output += usage?.completion_tokens ?? 0;
  entry.cached += usage?.prompt_cache_hit_tokens ?? 0;
  totals.set(model, entry);
  return usage;
}
/** Tokens per model since the start (or the last reset). */
export function aiUsage(): Record<string, TokenUsage> {
  return Object.fromEntries([...(health.finanzblickAiUsage ?? new Map()).entries()].map(([model, entry]) => [model, { ...entry }]));
}
export function resetAiUsage() {
  health.finanzblickAiUsage = new Map();
}

// --- Logs: one line per model call, so the model choice and every fallback are visible in the server log. ---

const quiet = () => process.env.NODE_ENV === "test" || /^(?:off|false|0)$/i.test(process.env.FINANZBLICK_AI_LOG ?? "");
function logCall(use: ModelUse, ms: number, usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } | null) {
  if (quiet()) return;
  const tokens = usage?.prompt_tokens !== undefined
    ? ` · ${usage.prompt_tokens}→${usage.completion_tokens ?? 0} Token${usage.prompt_cache_hit_tokens ? ` (Cache ${usage.prompt_cache_hit_tokens})` : ""}` : "";
  const fallback = use.fallback ? ` · Fallback${use.reason ? `: DeepSeek ${use.reason}` : ""}` : "";
  console.info(`[KI] ${taskLabel[use.task]} → ${modelTitle(use)} (${use.model}) · ${ms} ms${tokens}${fallback}`);
}
function logFailure(task: AiTask, model: string, error: CloudError) {
  if (!quiet()) console.warn(`[KI] ${taskLabel[task]} · DeepSeek (${model}) fehlgeschlagen: ${error.message}`);
}

// --- Routing: which model answers this call. ---

type CloudTarget = { cloud: CloudConfig; model: string; thinking: boolean };
type Plan = { task: AiTask; target?: CloudTarget; skipped?: string };

function plan(config: AiConfig, options: ChatOptions): Plan {
  const task = options.task ?? "chat";
  const cloud = config.cloud;
  if (!cloud || options.localOnly || !cloud.tasks.includes(task)) return { task };
  const paused = cloudPause();
  if (paused) return { task, skipped: paused };
  const tier = options.tier ?? taskTier[task];
  // Tool calls stay without thinking: the thinking mode would need its reasoning passed back on every turn.
  return { task, target: { cloud, model: cloud.models[tier], thinking: tier === "reasoning" && !options.tools?.length } };
}

/** Which model would answer each task right now; for the status view. */
export function aiRouting(config = readAiConfig()): { task: AiTask; use: ModelUse }[] {
  return (Object.keys(taskTier) as AiTask[]).map((task) => {
    const route = plan(config, { config, task });
    return { task, use: route.target
      ? { provider: "deepseek", model: route.target.model, task, ...(route.target.thinking ? { thinking: true } : {}) }
      : { provider: "local", model: config.model, task, ...(route.skipped ? { fallback: true, reason: route.skipped } : {}) } };
  });
}

// Personal details never leave the device in clear text: names, IBANs, e-mails, phone, card and account numbers become
// placeholders before the cloud call and are put back into its answer.
function maskMessages(messages: ChatMessage[], guard: Pseudonymizer): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "system") return message;
    if (message.role === "assistant") return { ...message, content: message.content === null ? null : guard.maskText(message.content),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: guard.maskText(call.function.arguments) } })) } : {}) };
    return { ...message, content: guard.maskText(message.content) };
  });
}

const TOKEN_WORDS = ["Person", "IBAN", "email", "Telefon", "Karte", "Nummer"];
/** Holds back a placeholder that may continue in the next chunk ("Pers", "Person-1"), so it is revealed whole. */
export function splitRevealable(text: string): [string, string] {
  const tail = /([A-Za-z]+(?:-\d*)?)$/.exec(text)?.[1];
  if (!tail) return [text, ""];
  const word = tail.replace(/-\d*$/, "");
  const open = tail.includes("-") ? TOKEN_WORDS.includes(word) : TOKEN_WORDS.some((token) => token.startsWith(word));
  return open ? [text.slice(0, -tail.length), tail] : [text, ""];
}

function requestBody(target: CloudTarget, messages: ChatMessage[], options: ChatOptions, stream: boolean) {
  const maxTokens = options.maxTokens ?? 1024;
  return {
    model: target.model,
    messages,
    // The thinking mode reasons before the answer; its tokens must not eat the answer's budget.
    max_tokens: target.thinking ? maxTokens + 4096 : maxTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    thinking: { type: target.thinking ? "enabled" : "disabled" },
    ...(target.thinking ? { reasoning_effort: target.cloud.effort } : { temperature: options.temperature ?? 0 }),
    ...(options.tools?.length ? { tools: options.tools, tool_choice: "auto" } : {}),
  };
}

async function postCloud(target: CloudTarget, messages: ChatMessage[], options: ChatOptions, stream: boolean) {
  const { cloud } = target;
  const timeout = AbortSignal.timeout(cloud.timeoutMs);
  const connect = new AbortController();
  const timer = setTimeout(() => connect.abort(), cloud.connectMs);
  const signal = AbortSignal.any([timeout, connect.signal, ...(options.signal ? [options.signal] : [])]);
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(`${cloud.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cloud.apiKey}` },
      body: JSON.stringify(requestBody(target, messages, options, stream)),
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw timeout.aborted || connect.signal.aborted ? new CloudError("timeout", "Zeitüberschreitung") : new CloudError("network", "nicht erreichbar");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw httpFailure(response.status, response.headers.get("retry-after"));
  }
  return response;
}

async function postLocal(messages: ChatMessage[], options: ChatOptions, config: AiConfig, stream: boolean) {
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

const cacheKey = (use: ModelUse, messages: ChatMessage[], options: ChatOptions, stream: boolean) => ({
  provider: use.provider, model: use.model, thinking: !!use.thinking, messages, stream,
  maxTokens: options.maxTokens ?? 1024, temperature: options.temperature ?? 0, tools: options.tools ?? [],
});

function localUse(config: AiConfig, options: ChatOptions, route: Plan, reason?: string): ModelUse {
  const fallback = !!(reason ?? route.skipped);
  return { provider: "local", model: options.model ?? config.model, task: route.task,
    ...(fallback ? { fallback: true, reason: reason ?? route.skipped } : {}) };
}

function unavailable(error: CloudError | string) {
  return new AiUnavailableError(`DeepSeek: ${typeof error === "string" ? error : error.message}. Die lokale KI ist deaktiviert.`);
}

function finish(options: ChatOptions, use: ModelUse) {
  options.trace?.push(use);
  return use;
}

export type ChatReply = { content: string; toolCalls: ToolCall[]; use: ModelUse };

export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatReply> {
  const config = options.config ?? readAiConfig();
  const route = plan(config, options);
  let reason: string | undefined;
  if (route.target) {
    const target = route.target;
    const use: ModelUse = { provider: "deepseek", model: target.model, task: route.task, ...(target.thinking ? { thinking: true } : {}) };
    const cached = options.cache?.get(cacheKey(use, messages, options, false));
    if (cached) return { ...cached, use: finish(options, cached.use) };
    const started = Date.now();
    const guard = createPseudonymizer();
    try {
      const response = await postCloud(target, maskMessages(messages, guard), options, false);
      const parsed = completionSchema.parse(await response.json());
      const message = parsed.choices[0].message;
      logCall(use, Date.now() - started, countUsage(target.model, parsed.usage));
      const reply = {
        content: stripThinking(guard.reveal(message.content ?? "")),
        toolCalls: ((message.tool_calls ?? []) as ToolCall[]).map((call) => ({ ...call, function: { ...call.function, arguments: guard.reveal(call.function.arguments) } })),
        use,
      };
      options.cache?.set(cacheKey(use, messages, options, false), reply);
      return { ...reply, use: finish(options, use) };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = error instanceof CloudError ? error : new CloudError("bad", "Antwort nicht lesbar");
      logFailure(route.task, target.model, failure);
      pauseCloud(failure);
      if (!config.enabled) throw unavailable(failure);
      reason = failure.message;
    }
  }
  if (route.skipped && !config.enabled) throw unavailable(route.skipped);
  const use = localUse(config, options, route, reason);
  const cached = options.cache?.get(cacheKey(use, messages, options, false));
  if (cached) return { ...cached, use: finish(options, cached.use) };
  const started = Date.now();
  const response = await postLocal(messages, options, config, false);
  const parsed = completionSchema.parse(await response.json());
  const message = parsed.choices[0].message;
  logCall(use, Date.now() - started, countUsage(use.model, parsed.usage));
  const reply = { content: stripThinking(message.content ?? ""), toolCalls: (message.tool_calls ?? []) as ToolCall[], use };
  options.cache?.set(cacheKey(use, messages, options, false), reply);
  return { ...reply, use: finish(options, use) };
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };

// Splits OpenAI-style server-sent events into text deltas; `rest` keeps an incomplete last line for the next chunk.
// Reasoning deltas of the thinking mode carry no answer text; the last chunk may carry the token usage.
export function parseSse(buffer: string): { deltas: string[]; rest: string; done: boolean; usage?: Usage } {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  const deltas: string[] = [];
  let done = false;
  let usage: Usage | undefined;
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") { done = true; break; }
    try {
      const event = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[]; usage?: Usage | null };
      const content = event.choices?.[0]?.delta?.content;
      if (typeof content === "string" && content) deltas.push(content);
      if (event.usage) usage = event.usage;
    } catch {
      // Keep-alive or malformed lines carry no text.
    }
  }
  return { deltas, rest, done, ...(usage ? { usage } : {}) };
}

async function* readSse(response: Response, reveal: (text: string) => string = (text) => text): AsyncGenerator<string, Usage | undefined> {
  if (!response.body) throw new AiUnavailableError("Die KI hat keine Antwort gestreamt.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let held = "";
  let usage: Usage | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      const parsed = parseSse(buffer + (value ?? "") + (done ? "\n" : ""));
      buffer = parsed.rest;
      usage = parsed.usage ?? usage;
      for (const delta of parsed.deltas) {
        const [ready, rest] = splitRevealable(held + delta);
        held = rest;
        if (ready) yield reveal(ready);
      }
      if (parsed.done || done) break;
    }
    if (held) yield reveal(held);
    return usage;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Streams the raw model text piece by piece (no thinking removal; callers decide what to show).
 * An empty piece comes first, as soon as a model has accepted the request: `options.trace` then names it.
 */
export async function* chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string> {
  const config = options.config ?? readAiConfig();
  const route = plan(config, options);
  let reason: string | undefined;
  if (route.target) {
    const target = route.target;
    const use: ModelUse = { provider: "deepseek", model: target.model, task: route.task, ...(target.thinking ? { thinking: true } : {}) };
    const cached = options.cache?.get(cacheKey(use, messages, options, true));
    if (cached) {
      finish(options, cached.use);
      yield "";
      yield cached.content;
      return;
    }
    const started = Date.now();
    const guard = createPseudonymizer();
    let response: Response | undefined;
    try {
      response = await postCloud(target, maskMessages(messages, guard), options, true);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = error instanceof CloudError ? error : new CloudError("bad", "Antwort nicht lesbar");
      logFailure(route.task, target.model, failure);
      pauseCloud(failure);
      if (!config.enabled) throw unavailable(failure);
      reason = failure.message;
    }
    if (response) {
      finish(options, use);
      yield "";
      let text = "";
      const pieces = readSse(response, (piece) => guard.reveal(piece));
      while (true) {
        const next = await pieces.next();
        if (next.done) {
          logCall(use, Date.now() - started, countUsage(target.model, next.value));
          break;
        }
        text += next.value;
        yield next.value;
      }
      options.cache?.set(cacheKey(use, messages, options, true), { content: text, toolCalls: [], use });
      return;
    }
  }
  if (route.skipped && !config.enabled) throw unavailable(route.skipped);
  const use = localUse(config, options, route, reason);
  const cached = options.cache?.get(cacheKey(use, messages, options, true));
  if (cached) {
    finish(options, cached.use);
    yield "";
    yield cached.content;
    return;
  }
  const started = Date.now();
  const response = await postLocal(messages, options, config, true);
  finish(options, use);
  yield "";
  let text = "";
  const pieces = readSse(response);
  while (true) {
    const next = await pieces.next();
    if (next.done) {
      logCall(use, Date.now() - started, countUsage(use.model, next.value));
      break;
    }
    text += next.value;
    yield next.value;
  }
  options.cache?.set(cacheKey(use, messages, options, true), { content: text, toolCalls: [], use });
}

export type CloudStatus = {
  provider: "deepseek";
  available: boolean;
  models: Record<ModelTier, string>;
  error?: string;
};
export type AiStatus = {
  /** Any model can answer: the cloud model, or the local one as fallback. */
  available: boolean;
  /** The model that answers ordinary questions right now. */
  model: string;
  label: string;
  device: "NPU" | "Cloud";
  error?: string;
  router?: { model: string; available: boolean };
  local: { available: boolean; model: string; error?: string };
  cloud?: CloudStatus;
  /** Which model answers each task right now. */
  routing: { task: AiTask; label: string; model: string; fallback?: boolean }[];
};

type LocalStatus = { available: boolean; error?: string; router?: { model: string; available: boolean } };
async function localStatus(config: AiConfig, fetcher: typeof fetch): Promise<LocalStatus> {
  if (!config.enabled) return { available: false, error: "deaktiviert" };
  try {
    const root = config.baseUrl.replace(/\/v3$/, "");
    const response = await fetcher(`${root}/v1/config`, { signal: AbortSignal.timeout(2_000), cache: "no-store" });
    if (!response.ok) return { available: false, error: `HTTP ${response.status}` };
    const body = await response.json() as Record<string, { model_version_status?: { state?: string }[] }>;
    const state = body[config.model]?.model_version_status?.[0]?.state;
    const router = config.routerModel
      ? { router: { model: config.routerModel, available: body[config.routerModel]?.model_version_status?.[0]?.state === "AVAILABLE" } } : {};
    return state === "AVAILABLE" ? { ...router, available: true } : { ...router, available: false, error: state ?? "Modell nicht geladen" };
  } catch {
    return { available: false, error: "nicht erreichbar" };
  }
}

const statusCache = globalThis as typeof globalThis & { finanzblickCloudStatus?: { at: number; key: string; value: CloudStatus } };
// The model list costs no tokens; it is asked at most once a minute.
async function cloudStatus(cloud: CloudConfig, fetcher: typeof fetch): Promise<CloudStatus> {
  const base = { provider: "deepseek" as const, models: cloud.models };
  const paused = cloudPause();
  if (paused) return { ...base, available: false, error: paused };
  const key = `${cloud.baseUrl}|${cloud.apiKey.slice(-6)}`;
  const known = statusCache.finanzblickCloudStatus;
  if (known && known.key === key && Date.now() - known.at < 60_000) return known.value;
  let value: CloudStatus;
  try {
    const response = await fetcher(`${cloud.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cloud.apiKey}` }, signal: AbortSignal.timeout(4_000), cache: "no-store",
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) value = { ...base, available: true };
    else {
      const failure = httpFailure(response.status, response.headers.get("retry-after"));
      if (failure.kind !== "bad") pauseCloud(failure);
      value = { ...base, available: false, error: failure.message };
    }
  } catch {
    value = { ...base, available: false, error: "nicht erreichbar" };
  }
  statusCache.finanzblickCloudStatus = { at: Date.now(), key, value };
  return value;
}

export async function aiStatus(config = readAiConfig(), fetcher: typeof fetch = fetch): Promise<AiStatus> {
  const [local, cloud] = await Promise.all([
    localStatus(config, fetcher),
    config.cloud ? cloudStatus(config.cloud, fetcher) : Promise.resolve(undefined),
  ]);
  const cloudReady = !!cloud?.available;
  const routing = aiRouting(config).map(({ task, use }) => ({ task, label: modelTitle(use), model: use.model,
    ...(use.provider === "local" && config.cloud ? { fallback: true } : {}) }))
    .map((item) => cloudReady || !config.cloud ? item : { ...item, label: modelTitle({ provider: "local", model: config.model }), model: config.model, fallback: true });
  const primary = cloudReady && config.cloud ? { provider: "deepseek" as const, model: config.cloud.models.fast } : { provider: "local" as const, model: config.model };
  const error = !cloudReady && !local.available
    ? [cloud?.error ? `DeepSeek: ${cloud.error}` : "", local.error ? `Lokal: ${local.error}` : ""].filter(Boolean).join(" · ") || undefined
    : undefined;
  return {
    available: cloudReady || local.available,
    model: primary.model,
    label: modelLabel(primary),
    device: cloudReady ? "Cloud" : "NPU",
    ...(error ? { error } : {}),
    ...(local.router ? { router: local.router } : {}),
    local: { available: local.available, model: config.model, ...(local.error ? { error: local.error } : {}) },
    ...(cloud ? { cloud } : {}),
    routing,
  };
}
