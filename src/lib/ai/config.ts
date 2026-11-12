export type AiConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  // Optional small model that only picks the tool; the main model still writes free answers.
  routerModel?: string;
  // Small local embedding model for the finance knowledge layer; without it the knowledge search uses keywords only.
  embeddingModel?: string;
  minConfidence: number;
  timeoutMs: number;
};

export const DEFAULT_AI_URL = "http://127.0.0.1:8000/v3";
export const DEFAULT_AI_MODEL = "OpenVINO/Qwen3-8B-int4-cw-ov";
export const DEFAULT_MIN_CONFIDENCE = 90;
export const DEFAULT_EMBEDDING_MODEL = "OpenVINO/Qwen3-Embedding-0.6B-int8-ov";

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

// The model only listens on loopback; remote endpoints would leak bank text.
export function isLoopbackUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function readAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const baseUrl = (env.FINANZBLICK_AI_URL || DEFAULT_AI_URL).replace(/\/+$/, "");
  const routerModel = (env.FINANZBLICK_AI_ROUTER_MODEL ?? env.AI_ROUTER_MODEL)?.trim();
  // "off" or an empty value switches the embedding model off.
  const embeddingModel = env.FINANZBLICK_AI_EMBEDDING_MODEL === undefined ? DEFAULT_EMBEDDING_MODEL : env.FINANZBLICK_AI_EMBEDDING_MODEL.trim();
  return {
    enabled: env.FINANZBLICK_AI !== "false" && isLoopbackUrl(baseUrl),
    baseUrl,
    model: env.FINANZBLICK_AI_MODEL?.trim() || DEFAULT_AI_MODEL,
    ...(routerModel ? { routerModel } : {}),
    ...(embeddingModel && embeddingModel !== "off" ? { embeddingModel } : {}),
    minConfidence: boundedNumber(env.FINANZBLICK_AI_MIN_CONFIDENCE, DEFAULT_MIN_CONFIDENCE, 50, 100),
    timeoutMs: boundedNumber(env.FINANZBLICK_AI_TIMEOUT_MS, 180_000, 5_000, 900_000),
  };
}
