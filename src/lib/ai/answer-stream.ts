// Browser side of `/api/ai/answer?stream=1`: shows the text while it grows and returns it only if the server's final check accepted it.
export async function readAnswerStream(body: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<string | undefined> {
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
        let event: { delta?: unknown; done?: unknown; ok?: unknown; text?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof event.delta === "string") {
          shown += event.delta;
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
