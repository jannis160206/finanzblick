// Browser side of `/api/ai/answer?stream=1`: shows the text while it grows and returns it only if the server's final check accepted it.
// `onModel` hears which model took the question (DeepSeek or the local fallback) before the first word.
export async function readAnswerStream(body: ReadableStream<Uint8Array>, onText: (text: string) => void,
  onModel?: (model: unknown) => void): Promise<string | undefined> {
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
        let event: { model?: unknown; delta?: unknown; replace?: unknown; done?: unknown; ok?: unknown; text?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
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
