type StreamEvent = { prompt?: unknown; model?: unknown; delta?: unknown; replace?: unknown; done?: unknown; ok?: unknown; text?: unknown; calls?: unknown; limits?: unknown };

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const parts = buffer.split("\n");
      buffer = done ? "" : parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as StreamEvent;
        } catch {
          // A broken line carries nothing usable.
        }
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export type AgentStreamCall = { id: string; name: string; arguments: string };
const isCall = (value: unknown): value is AgentStreamCall => !!value && typeof value === "object" && typeof (value as AgentStreamCall).id === "string"
  && typeof (value as AgentStreamCall).name === "string" && typeof (value as AgentStreamCall).arguments === "string";

/**
 * Browser side of `/api/ai/agent?stream=1`: the orchestrator's words while they grow (`onText`), or the tool calls that end its
 * step. The text comes back only if the server's final check accepted it; `limits` are the agent's live limits.
 */
export async function readAgentStream(body: ReadableStream<Uint8Array>, handlers: { onText: (text: string) => void; onModel?: (model: unknown) => void;
  onPrompt?: (prompt: string) => void }): Promise<{ calls: AgentStreamCall[]; text?: string; limits?: unknown }> {
  let shown = "";
  let limits: unknown;
  for await (const event of lines(body)) {
    if (event.limits && typeof event.limits === "object") limits = event.limits;
    if (typeof event.prompt === "string") handlers.onPrompt?.(event.prompt);
    if (event.model && typeof event.model === "object") handlers.onModel?.(event.model);
    if (typeof event.delta === "string" || typeof event.replace === "string") {
      shown = typeof event.replace === "string" ? event.replace : shown + event.delta;
      if (!shown.trimStart().startsWith("{")) handlers.onText(shown);
    }
    if (Array.isArray(event.calls)) return { calls: event.calls.filter(isCall), limits };
    if (event.done) return { calls: [], limits, ...(event.ok === true && typeof event.text === "string" && event.text.trim() ? { text: event.text.trim() } : {}) };
  }
  return { calls: [], limits };
}

// Browser side of `/api/ai/answer?stream=1`: shows the text while it grows and returns it only if the server's final check accepted it.
// `onModel` hears which model took the question (DeepSeek or the local fallback) before the first word, `onPrompt` the
// system prompt the answer is written with.
export async function readAnswerStream(body: ReadableStream<Uint8Array>, onText: (text: string) => void,
  onModel?: (model: unknown) => void, onPrompt?: (prompt: string) => void): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let shown = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: { prompt?: unknown; model?: unknown; delta?: unknown; replace?: unknown; done?: unknown; ok?: unknown; text?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof event.prompt === "string") onPrompt?.(event.prompt);
        if (event.model && typeof event.model === "object") onModel?.(event.model);
        if (typeof event.delta === "string" || typeof event.replace === "string") {
          // `replace` withdraws a sentence the server could not back after all.
          shown = typeof event.replace === "string" ? event.replace : shown + event.delta;
          if (!shown.trimStart().startsWith("{")) onText(shown);
        }
        if (event.done) return event.ok === true && typeof event.text === "string" && event.text.trim() ? event.text.trim() : undefined;
      }
      if (done) return undefined;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
