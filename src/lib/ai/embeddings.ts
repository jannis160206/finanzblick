import { z } from "zod";
import { AiUnavailableError } from "./client";
import { readAiConfig, type AiConfig } from "./config";

const responseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().int().optional() })).min(1),
});

export type EmbedOptions = { config?: AiConfig; signal?: AbortSignal; fetcher?: typeof fetch; timeoutMs?: number };

/** Embeddings from the local model server (OpenAI-compatible `/embeddings`); texts never leave the machine. */
export async function embedTexts(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
  const config = options.config ?? readAiConfig();
  if (!config.enabled || !config.embeddingModel) throw new AiUnavailableError("Kein lokales Embedding-Modell eingerichtet.");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(`${config.baseUrl}/embeddings`, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal,
      body: JSON.stringify({ model: config.embeddingModel, input: texts }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AiUnavailableError(timeout.aborted ? "Das Embedding-Modell hat nicht rechtzeitig geantwortet." : "Das Embedding-Modell ist nicht erreichbar.");
  }
  if (!response.ok) throw new AiUnavailableError(`Das Embedding-Modell hat mit HTTP ${response.status} geantwortet.`);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.data.length !== texts.length) throw new AiUnavailableError("Das Embedding-Modell hat eine unerwartete Antwort geliefert.");
  return [...parsed.data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding);
}
