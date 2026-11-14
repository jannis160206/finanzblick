import { aiTasks, type AiTask, type ModelTier } from "./models";

/** DeepSeek in the cloud: answers first when a key is set; the local model stays the fallback. */
export type CloudConfig = {
  provider: "deepseek";
  baseUrl: string;
  apiKey: string;
  models: Record<ModelTier, string>;
  /** Thinking effort for analyses and tax questions. */
  effort: "low" | "high" | "max";
  timeoutMs: number;
  /** Without response headers by then the cloud counts as unreachable and the local model answers. */
  connectMs: number;
  /** Tasks that may leave the device; whole bank statements (`document`) stay local unless allowed. */
  tasks: AiTask[];
};

export type AiConfig = {
  // The local model (OVMS on the NPU); the cloud model is configured separately in `cloud`.
  enabled: boolean;
  baseUrl: string;
  model: string;
  // Optional small model that only picks the tool; the main model still writes free answers.
  routerModel?: string;
  // Small local embedding model for the finance knowledge layer; without it the knowledge search uses keywords only.
  embeddingModel?: string;
  minConfidence: number;
  timeoutMs: number;
  cloud?: CloudConfig;
};

export const DEFAULT_AI_URL = "http://127.0.0.1:8000/v3";
export const DEFAULT_AI_MODEL = "OpenVINO/Qwen3-8B-int4-cw-ov";
export const DEFAULT_MIN_CONFIDENCE = 90;
export const DEFAULT_EMBEDDING_MODEL = "OpenVINO/Qwen3-Embedding-0.6B-int8-ov";
export const DEFAULT_DEEPSEEK_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODELS: Record<ModelTier, string> = { fast: "deepseek-flash", pro: "deepseek-v4-pro", reasoning: "deepseek-v4-pro" };

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

// The local model only listens on loopback; a remote endpoint would leak bank text. The cloud model is the separate,
// explicitly configured `cloud` provider, and what it receives is pseudonymized first (client.ts).
export function isLoopbackUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

// The cloud model is only reached over https, without credentials in the URL.
export function isHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

const off = (value: string | undefined) => /^(?:off|false|0|no|aus)$/i.test(value?.trim() ?? "");

export function readCloudConfig(env: Record<string, string | undefined> = process.env): CloudConfig | undefined {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_URL).replace(/\/+$/, "");
  if (env.FINANZBLICK_AI === "false" || off(env.FINANZBLICK_CLOUD_AI) || !apiKey || !/^[\x21-\x7e]{8,200}$/.test(apiKey) || !isHttpsUrl(baseUrl))
    return undefined;
  const model = (value: string | undefined, fallback: string) => value?.trim() && /^[\w.:/-]{1,60}$/.test(value.trim()) ? value.trim() : fallback;
  const effort = env.DEEPSEEK_REASONING_EFFORT?.trim().toLowerCase();
  return {
    provider: "deepseek",
    baseUrl,
    apiKey,
    models: {
      fast: model(env.DEEPSEEK_MODEL_FAST, DEFAULT_DEEPSEEK_MODELS.fast),
      pro: model(env.DEEPSEEK_MODEL_PRO, DEFAULT_DEEPSEEK_MODELS.pro),
      reasoning: model(env.DEEPSEEK_MODEL_REASONING, DEFAULT_DEEPSEEK_MODELS.reasoning),
    },
    effort: effort === "low" || effort === "max" ? effort : "high",
    timeoutMs: boundedNumber(env.DEEPSEEK_TIMEOUT_MS, 120_000, 5_000, 600_000),
    connectMs: boundedNumber(env.DEEPSEEK_CONNECT_TIMEOUT_MS, 20_000, 1_000, 120_000),
    tasks: aiTasks.filter((task) => task !== "document" || /^(?:on|true|1|ja)$/i.test(env.DEEPSEEK_DOCUMENTS?.trim() ?? "")),
  };
}

export function readAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const baseUrl = (env.FINANZBLICK_AI_URL || DEFAULT_AI_URL).replace(/\/+$/, "");
  const routerModel = (env.FINANZBLICK_AI_ROUTER_MODEL ?? env.AI_ROUTER_MODEL)?.trim();
  // "off" or an empty value switches the embedding model off.
  const embeddingModel = env.FINANZBLICK_AI_EMBEDDING_MODEL === undefined ? DEFAULT_EMBEDDING_MODEL : env.FINANZBLICK_AI_EMBEDDING_MODEL.trim();
  const cloud = readCloudConfig(env);
  return {
    enabled: env.FINANZBLICK_AI !== "false" && isLoopbackUrl(baseUrl),
    baseUrl,
    model: env.FINANZBLICK_AI_MODEL?.trim() || DEFAULT_AI_MODEL,
    ...(routerModel ? { routerModel } : {}),
    ...(embeddingModel && embeddingModel !== "off" ? { embeddingModel } : {}),
    minConfidence: boundedNumber(env.FINANZBLICK_AI_MIN_CONFIDENCE, DEFAULT_MIN_CONFIDENCE, 50, 100),
    timeoutMs: boundedNumber(env.FINANZBLICK_AI_TIMEOUT_MS, 180_000, 5_000, 900_000),
    ...(cloud ? { cloud } : {}),
  };
}
