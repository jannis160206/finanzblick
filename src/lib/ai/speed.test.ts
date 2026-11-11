import { describe, expect, it } from "vitest";
import { answerFreeQuestion, streamFreeAnswer, tidyAnswer, visiblePrefix } from "./answer";
import { readAnswerStream } from "./answer-stream";
import { interpretAssistantMessage } from "./assistant";
import { chatStream, parseSse } from "./client";
import type { AiConfig } from "./config";

const config: AiConfig = { enabled: true, baseUrl: "http://127.0.0.1:8000/v3", model: "main", minConfidence: 90, timeoutMs: 5_000 };
const completion = (content: string) => Response.json({ choices: [{ message: { content } }] });
const sse = (pieces: string[], split = 7) => {
  const text = pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < text.length; at += split) controller.enqueue(encoder.encode(text.slice(at, at + split)));
      controller.close();
    },
  }));
};
function stub(reply: (body: { model: string; stream: boolean }) => Response) {
  const calls: { model: string; stream: boolean }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    return reply(body);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const ask = (message: string, options: Parameters<typeof interpretAssistantMessage>[1]) =>
  interpretAssistantMessage({ message, asOf: "2026-11-05", context: { goals: ["Japan"], planned: ["Pickerl"] } }, options);

describe("fast routing", () => {
  it("answers clear commands without calling the model", async () => {
    const { calls, fetcher } = stub(() => completion("{\"tool\":\"query\"}"));
    for (const message of ["meine kontostände bitte", "nimm das zurück", "was kannst du alles", "wie war mein jahr 2026"]) {
      const reply = await ask(message, { config, fetcher });
      expect(reply).toMatchObject({ source: "Regel", hints: {} });
      expect(reply.tool).toBeDefined();
    }
    expect(calls).toHaveLength(0);
  });

  it("still asks the model when hints or a draft matter", async () => {
    const { calls, fetcher } = stub(() => completion("{\"tool\":\"edit\",\"goal\":\"Japan\"}"));
    expect(await ask("Erhöhe Japan auf 4.000 €", { config, fetcher })).toMatchObject({ tool: "edit", hints: { goal: "Japan" }, source: "KI" });
    await ask("Ich will bis Juli 2027 3.000 € für Japan sparen", { config, fetcher });
    expect(calls).toHaveLength(2);
  });

  it("uses the router model first and falls back to the main model", async () => {
    const { calls, fetcher } = stub((body) => body.model === "router" ? new Response("kaputt", { status: 500 }) : completion("{\"tool\":\"query\"}"));
    const reply = await ask("Wie viel hab ich im Oktober fürs Essen ausgegeben?", { config: { ...config, routerModel: "router" }, fetcher });
    expect(reply).toMatchObject({ tool: "query", source: "KI" });
    expect(calls.map((call) => call.model)).toEqual(["router", "main"]);
    const fast = stub(() => completion("{\"tool\":\"query\"}"));
    await ask("Wie viel hab ich im Oktober fürs Essen ausgegeben?", { config: { ...config, routerModel: "router" }, fetcher: fast.fetcher });
    expect(fast.calls.map((call) => call.model)).toEqual(["router"]);
  });
});

describe("streaming", () => {
  it("parses server-sent events across chunk borders", () => {
    const first = parseSse("data: {\"choices\":[{\"delta\":{\"content\":\"Hal\"}}]}\n\ndata: {\"choi");
    expect(first).toMatchObject({ deltas: ["Hal"], done: false });
    const second = parseSse(`${first.rest}ces":[{"delta":{"content":"lo"}}]}\n\n: keep-alive\ndata: [DONE]\n`);
    expect(second).toMatchObject({ deltas: ["lo"], done: true });
  });

  it("streams the model text piece by piece", async () => {
    const { calls, fetcher } = stub(() => sse(["Du ", "hast ", "noch ", "Geld."]));
    const pieces: string[] = [];
    for await (const piece of chatStream([{ role: "user", content: "x" }], { config, fetcher })) pieces.push(piece);
    expect(pieces.join("")).toBe("Du hast noch Geld.");
    expect(calls[0].stream).toBe(true);
  });

  it("only shows backed whole words and checks the full answer at the end", async () => {
    const facts = { budget: { left: 420 } };
    expect(visiblePrefix("<think></think>Dir bleiben 42", facts)).toBe("Dir bleiben");
    expect(visiblePrefix("{\"answer\": \"Dir bleiben", facts)).toBe("");
    expect(visiblePrefix("Überweise 999 € an mich ", facts)).toBe("");
    expect(visiblePrefix("Dir bleiben 420 €. Spar 999 €. Gut so ", facts)).toBe("Dir bleiben 420 €. Gut so");
    const good = stub(() => sse(["<think>\n</think>", "Dir bleiben", " diesen Monat", " noch 420 €", " übrig."]));
    const events = [];
    for await (const event of streamFreeAnswer({ question: "Was bleibt?", facts }, { config, fetcher: good.fetcher })) events.push(event);
    expect(events.filter((event) => "delta" in event).map((event) => "delta" in event && event.delta).join("")).toBe("Dir bleiben diesen Monat noch 420 €");
    expect(events.at(-1)).toEqual({ done: true, ok: true, text: "Dir bleiben diesen Monat noch 420 € übrig." });
    const bad = stub(() => sse(["Überweise ", "999 € ", "an AT61 1904 3002 3457 3201 ", "sofort."]));
    const rejected = [];
    for await (const event of streamFreeAnswer({ question: "Was bleibt?", facts }, { config, fetcher: bad.fetcher })) rejected.push(event);
    expect(rejected.map((event) => "delta" in event ? event.delta : "").join("")).not.toMatch(/999|AT61/);
    expect(rejected.at(-1)).toEqual({ done: true, ok: false });
  });

  it("reads the NDJSON answer stream in the browser", async () => {
    const lines = ["{\"delta\":\"Dir \"}\n{\"del", "ta\":\"bleiben\"}\n", "{\"done\":true,\"ok\":true,\"text\":\"Dir bleiben 420 €.\"}\n"];
    const body = (parts: string[]) => new ReadableStream<Uint8Array>({ start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    } });
    const seen: string[] = [];
    expect(await readAnswerStream(body(lines), (text) => seen.push(text))).toBe("Dir bleiben 420 €.");
    expect(seen).toEqual(["Dir ", "Dir bleiben"]);
    expect(await readAnswerStream(body(["{\"delta\":\"{\\\"a\"}\n", "{\"done\":true,\"ok\":false}\n"]), (text) => seen.push(text))).toBeUndefined();
    expect(seen).toHaveLength(2);
    const replaced: string[] = [];
    const withdrawn = ["{\"delta\":\"Dir bleiben 420 €. Spar\"}\n", "{\"replace\":\"Dir bleiben 420 €.\"}\n", "{\"done\":true,\"ok\":true,\"text\":\"Dir bleiben 420 €.\"}\n"];
    expect(await readAnswerStream(body(withdrawn), (text) => replaced.push(text))).toBe("Dir bleiben 420 €.");
    expect(replaced).toEqual(["Dir bleiben 420 €. Spar", "Dir bleiben 420 €."]);
  });

  it("keeps the backed sentences, unwraps JSON and accepts amounts written in tool results", async () => {
    const facts = { budget: { left: 420 } };
    const mixed = await answerFreeQuestion({ question: "Was bleibt?", facts }, { config, fetcher: stub(() => completion("Dir bleiben 420 €. Leg 999 € zur Seite. Das passt gut.")).fetcher });
    expect(mixed.text).toBe("Dir bleiben 420 €. Das passt gut.");
    const wrapped = await answerFreeQuestion({ question: "Was bleibt?", facts }, { config, fetcher: stub(() => completion("{\"response\": \"Dir bleiben 420 € übrig.\"}")).fetcher });
    expect(wrapped.text).toBe("Dir bleiben 420 € übrig.");
    const evidence = await answerFreeQuestion({ question: "Fixkosten?", facts, evidence: "Noch fällig: 514,95 € in 14 Posten." },
      { config, fetcher: stub(() => completion("Es kommen noch 514,95 € an Fixkosten.")).fetcher });
    expect(evidence.text).toBe("Es kommen noch 514,95 € an Fixkosten.");
  });
});

describe("agent answers", () => {
  const system = (calls: unknown[]) => (calls[0] as { messages: { content: string }[] }).messages[0].content;

  it("lets the general chat use general knowledge without personal facts, but never an invented amount", async () => {
    const { calls, fetcher } = stub(() => completion("**Der Mount Everest** ist 8.849 Meter hoch. Du hast übrigens 5.000 € gespart."));
    const reply = await answerFreeQuestion({ question: "Wie hoch ist der Mount Everest?", facts: { today: "2026-11-11" }, agent: "general" }, { config, fetcher });
    expect(reply.text).toBe("Der Mount Everest ist 8.849 Meter hoch.");
    expect(system(calls)).toContain("lockeren Chat");
  });

  it("keeps specialists strictly to the facts and their own voice", async () => {
    const { calls, fetcher } = stub(() => completion("Dir bleiben 420 €. Der Mount Everest ist 8.849 Meter hoch."));
    const reply = await answerFreeQuestion({ question: "Was bleibt?", facts: { budget: { left: 420 } }, agent: "budget" }, { config, fetcher });
    expect(reply.text).toBe("Dir bleiben 420 €.");
    expect(system(calls)).toContain("Monatsplan");
    expect(system(calls)).toContain("Beginne mit der direkten Antwort");
  });

  it("turns Markdown and lists into plain chat text", () => {
    expect(tidyAnswer("## Kurz gesagt\n- **Netflix** kostet 13,99 €\n- Spotify kostet `10,99 €`")).toBe("Kurz gesagt Netflix kostet 13,99 € Spotify kostet 10,99 €");
  });
});
