import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerTask, streamFreeAnswer } from "./answer";
import { interpretAssistantMessage, interpretTask } from "./assistant";
import {
  AiUnavailableError, aiStatus, aiUsage, chat, chatStream, cloudPause, resetAiUsage, resetCloudHealth, splitRevealable,
  type CachedReply, type ChatMessage, type ResponseCache,
} from "./client";
import { readAiConfig, readCloudConfig, type AiConfig } from "./config";
import { modelLabel, modelTitle, needsReasoning, type ModelUse } from "./models";

const env = { DEEPSEEK_API_KEY: "sk-test-1234567890" };
const config: AiConfig = readAiConfig(env);
const local: AiConfig = { ...config, cloud: undefined };

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
const completion = (content: string, usage = { prompt_tokens: 120, completion_tokens: 8, prompt_cache_hit_tokens: 96 }) =>
  Response.json({ choices: [{ message: { content } }], usage });
const sse = (pieces: string[], usage?: object) => new Response([
  ...pieces.map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`),
  ...(usage ? [`data: ${JSON.stringify({ choices: [], usage })}\n\n`] : []), "data: [DONE]\n\n",
].join(""), { headers: { "Content-Type": "text/event-stream" } });

/** Answers by URL: the cloud endpoint and the local OVMS endpoint each get their own reply. */
function stub(cloud: (call: Call) => Response | Promise<Response>, localReply: (call: Call) => Response = () => completion("lokal")) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {}, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    return call.url.startsWith("https://") ? cloud(call) : localReply(call);
  }) as typeof fetch;
  return { calls, fetcher, cloudCalls: () => calls.filter((call) => call.url.startsWith("https://")) };
}

beforeEach(() => { resetCloudHealth(); resetAiUsage(); });
afterEach(() => resetCloudHealth());

describe("cloud configuration", () => {
  it("turns DeepSeek on only with a key over https and keeps whole statements local", () => {
    expect(readCloudConfig({})).toBeUndefined();
    expect(readCloudConfig({ ...env, FINANZBLICK_CLOUD_AI: "off" })).toBeUndefined();
    expect(readCloudConfig({ ...env, FINANZBLICK_AI: "false" })).toBeUndefined();
    expect(readCloudConfig({ ...env, DEEPSEEK_BASE_URL: "http://api.deepseek.com" })).toBeUndefined();
    expect(readCloudConfig({ DEEPSEEK_API_KEY: "kurz" })).toBeUndefined();
    const cloud = readCloudConfig(env)!;
    expect(cloud).toMatchObject({ baseUrl: "https://api.deepseek.com", effort: "high",
      models: { fast: "deepseek-flash", pro: "deepseek-v4-pro", reasoning: "deepseek-v4-pro" } });
    expect(cloud.tasks).not.toContain("document");
    expect(readCloudConfig({ ...env, DEEPSEEK_DOCUMENTS: "on", DEEPSEEK_MODEL_FAST: "deepseek-v4-flash", DEEPSEEK_REASONING_EFFORT: "max" }))
      .toMatchObject({ effort: "max", models: { fast: "deepseek-v4-flash" }, tasks: expect.arrayContaining(["document"]) });
    // The local model keeps its loopback rule; the cloud is a separate provider.
    expect(readAiConfig({ ...env, FINANZBLICK_AI_URL: "https://example.com/v3" })).toMatchObject({ enabled: false, cloud: { provider: "deepseek" } });
  });

  it("names the models for the status line", () => {
    expect(modelLabel({ provider: "deepseek", model: "deepseek-flash" })).toBe("DeepSeek Flash");
    expect(modelLabel({ provider: "deepseek", model: "deepseek-v4-pro" })).toBe("DeepSeek V4 Pro");
    expect(modelTitle({ provider: "deepseek", model: "deepseek-v4-pro", thinking: true })).toBe("DeepSeek V4 Pro · Denkmodus");
    expect(modelLabel({ provider: "local", model: "OpenVINO/Qwen3-8B-int4-cw-ov" })).toBe("Lokal (Qwen)");
  });
});

describe("task routing", () => {
  it("sends ordinary work to the fast model without thinking and without the local template switch", async () => {
    const { calls, fetcher } = stub(() => completion("Hallo"));
    const trace: ModelUse[] = [];
    const reply = await chat([{ role: "user", content: "Hi" }], { config, fetcher, task: "chat", trace, maxTokens: 150 });
    expect(reply).toMatchObject({ content: "Hallo", use: { provider: "deepseek", model: "deepseek-flash", task: "chat" } });
    expect(trace).toEqual([reply.use]);
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-test-1234567890");
    expect(calls[0].body).toMatchObject({ model: "deepseek-flash", max_tokens: 150, temperature: 0, thinking: { type: "disabled" }, stream: false });
    expect(calls[0].body).not.toHaveProperty("chat_template_kwargs");
    expect(aiUsage()["deepseek-flash"]).toEqual({ calls: 1, input: 120, output: 8, cached: 96 });
  });

  it("plans actions on the pro model and lets analyses think, but never with tools", async () => {
    const { calls, fetcher } = stub(() => completion("ok"));
    await chat([{ role: "user", content: "x" }], { config, fetcher, task: "action" });
    await chat([{ role: "user", content: "x" }], { config, fetcher, task: "reasoning", maxTokens: 300 });
    await chat([{ role: "user", content: "x" }], { config, fetcher, task: "reasoning", tools: [{ type: "function", function: { name: "t", description: "", parameters: {} } }] });
    await chat([{ role: "user", content: "x" }], { config, fetcher, task: "action", tier: "fast" });
    expect(calls.map((call) => [call.body.model, (call.body.thinking as { type: string }).type])).toEqual([
      ["deepseek-v4-pro", "disabled"], ["deepseek-v4-pro", "enabled"], ["deepseek-v4-pro", "disabled"], ["deepseek-flash", "disabled"],
    ]);
    expect(calls[1].body).toMatchObject({ reasoning_effort: "high", max_tokens: 300 + 4096 });
    expect(calls[1].body).not.toHaveProperty("temperature");
  });

  it("keeps whole statements and explicitly local calls on the device", async () => {
    const { calls, fetcher } = stub(() => completion("cloud"));
    expect((await chat([{ role: "user", content: "x" }], { config, fetcher, task: "document" })).use).toEqual({ provider: "local", model: config.model, task: "document" });
    expect((await chat([{ role: "user", content: "x" }], { config, fetcher, localOnly: true })).content).toBe("lokal");
    expect(calls.every((call) => call.url.startsWith("http://127.0.0.1"))).toBe(true);
    expect(calls[0].body).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });

  it("picks the task from the question", () => {
    expect(answerTask({ question: "Wie hoch ist die Pendlerpauschale?", evidence: "Websuche (öffentliche Quellen …)\n[1] bmf.gv.at: …" })).toBe("web");
    expect(answerTask({ question: "Warum bleibt mir am Monatsende so wenig?", agent: "budget" })).toBe("reasoning");
    expect(answerTask({ question: "Wie viel Lohnsteuer zahle ich im Monat?", agent: "payroll" })).toBe("reasoning");
    expect(answerTask({ question: "Hey, wie gehts?" })).toBe("chat");
    expect(needsReasoning("Sollte ich das Lebensmittelbudget erhöhen?")).toBe(true);
    expect(needsReasoning("Danke dir!")).toBe(false);
    expect(interpretTask("Wie viel hab ich im Oktober ausgegeben?", "query", false)).toBe("route");
    expect(interpretTask("Leg einen Vertrag für Netflix an", undefined, false)).toBe("action");
    expect(interpretTask("3000 €", undefined, true)).toBe("action");
    expect(interpretTask("Tagge die Pizzeria Buchungen", "booking", false)).toBe("action");
    expect(interpretTask("Was hast du alles geändert?", undefined, false)).toBe("route");
  });
});

describe("fallback to the local model", () => {
  it("answers locally when the key is rejected and pauses DeepSeek instead of asking it again", async () => {
    const { cloudCalls, fetcher } = stub(() => new Response("{}", { status: 401 }));
    const first = await chat([{ role: "user", content: "x" }], { config, fetcher, task: "chat" });
    expect(first).toMatchObject({ content: "lokal", use: { provider: "local", fallback: true, reason: "Key ungültig (HTTP 401)" } });
    expect(cloudPause()).toBe("Key ungültig (HTTP 401)");
    const second = await chat([{ role: "user", content: "x" }], { config, fetcher, task: "chat" });
    expect(second.use).toMatchObject({ provider: "local", fallback: true, reason: "Key ungültig (HTTP 401)" });
    expect(cloudCalls()).toHaveLength(1);
  });

  it.each([
    ["rate limit", () => new Response("{}", { status: 429, headers: { "Retry-After": "5" } }), "Rate-Limit (HTTP 429)", true],
    ["outage", () => new Response("{}", { status: 503 }), "Dienst gestört (HTTP 503)", true],
    ["network", () => { throw new TypeError("fetch failed"); }, "nicht erreichbar", true],
    ["bad request", () => new Response("{}", { status: 400 }), "Anfrage abgelehnt (HTTP 400)", false],
    ["unreadable answer", () => Response.json({ nope: true }), "Antwort nicht lesbar", false],
  ] as const)("falls back on %s", async (_name, reply, reason, pauses) => {
    const { fetcher } = stub(reply);
    const answer = await chat([{ role: "user", content: "x" }], { config, fetcher });
    expect(answer.use).toMatchObject({ provider: "local", fallback: true, reason });
    expect(!!cloudPause()).toBe(pauses);
  });

  it("names DeepSeek's problem when the local model is switched off", async () => {
    const { fetcher } = stub(() => new Response("{}", { status: 402 }));
    await expect(chat([{ role: "user", content: "x" }], { config: { ...config, enabled: false }, fetcher }))
      .rejects.toThrow(new AiUnavailableError("DeepSeek: Guthaben aufgebraucht (HTTP 402). Die lokale KI ist deaktiviert."));
  });

  it("falls back before the first word of a stream and names the model first", async () => {
    const { fetcher } = stub(() => new Response("{}", { status: 500 }), () => sse(["Dir bleiben ", "420 €."]));
    const trace: ModelUse[] = [];
    const pieces: string[] = [];
    for await (const piece of chatStream([{ role: "user", content: "x" }], { config, fetcher, trace })) pieces.push(piece);
    expect(pieces).toEqual(["", "Dir bleiben ", "420 €."]);
    expect(trace).toMatchObject([{ provider: "local", fallback: true }]);
    const events = [];
    resetCloudHealth();
    for await (const event of streamFreeAnswer({ question: "Was bleibt?", facts: { left: 420 } }, { config, fetcher })) events.push(event);
    expect(events[0]).toEqual({ model: { provider: "local", model: config.model, task: "chat", fallback: true, reason: "Dienst gestört (HTTP 500)" } });
    expect(events.at(-1)).toEqual({ done: true, ok: true, text: "Dir bleiben 420 €." });
  });
});

describe("privacy and tokens", () => {
  it("pseudonymizes people and account numbers for the cloud and puts them back into the answer", async () => {
    const { calls, fetcher } = stub(() => completion("Die Überweisung an Person-1 ging auf IBAN-1."));
    const messages: ChatMessage[] = [
      { role: "system", content: "Antworte kurz." },
      { role: "user", content: "Überweisung an Max Mustermann, IBAN AT61 1904 3002 3457 3201 – wohin ging das?" },
    ];
    const reply = await chat(messages, { config, fetcher });
    const sent = JSON.stringify(calls[0].body.messages);
    expect(sent).not.toMatch(/Mustermann|AT61/);
    expect(sent).toContain("Person-1");
    expect(reply.content).toBe("Die Überweisung an Max Mustermann ging auf AT611904300234573201.");
  });

  it("streams placeholders whole, even when a chunk splits them, and counts the streamed tokens", async () => {
    const { calls, fetcher } = stub(() => sse(["Das ging an Pers", "on-1", " am 3.11."], { prompt_tokens: 50, completion_tokens: 9 }));
    const pieces: string[] = [];
    for await (const piece of chatStream([{ role: "user", content: "Zahlung an Max Mustermann vom 3.11.?" }], { config, fetcher })) pieces.push(piece);
    expect(pieces.join("")).toBe("Das ging an Max Mustermann am 3.11.");
    expect(pieces).not.toContain("Pers");
    expect(calls[0].body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(aiUsage()["deepseek-flash"]).toMatchObject({ calls: 1, input: 50, output: 9 });
    expect(splitRevealable("an Person-")).toEqual(["an ", "Person-"]);
    expect(splitRevealable("an Personal")).toEqual(["an Personal", ""]);
  });

  it("answers repeated identical requests from the cache without a model call", async () => {
    const store = new Map<string, CachedReply>();
    const cache: ResponseCache = { get: (key) => store.get(JSON.stringify(key)), set: (key, value) => { store.set(JSON.stringify(key), value); } };
    const { calls, fetcher } = stub(() => completion("einmal"));
    const ask = () => chat([{ role: "user", content: "gleich" }], { config, fetcher, cache, maxTokens: 150 });
    expect((await ask()).content).toBe("einmal");
    expect((await ask()).content).toBe("einmal");
    expect(calls).toHaveLength(1);
  });

  it("reports the models of an interpretation", async () => {
    const { fetcher } = stub(() => completion("{\"tool\":\"query\",\"category\":\"Lebensmittel\"}"));
    const reply = await interpretAssistantMessage({ message: "Wie viel hab ich im Oktober fürs Essen ausgegeben?", asOf: "2026-11-14" }, { config, fetcher });
    expect(reply).toMatchObject({ tool: "query", source: "KI", models: [{ provider: "deepseek", model: "deepseek-flash", task: "route" }] });
    const offline = await interpretAssistantMessage({ message: "Wie viel hab ich im Oktober fürs Essen ausgegeben?", asOf: "2026-11-14" },
      { config: { ...local, enabled: false }, fetcher });
    expect(offline.models).toBeUndefined();
  });
});

describe("status", () => {
  const status = (models: () => Response) => aiStatus(config, (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/models")) return models();
    return Response.json({ [config.model]: { model_version_status: [{ state: "AVAILABLE" }] } });
  }) as typeof fetch);

  it("shows DeepSeek per task with the local model as fallback", async () => {
    const ready = await status(() => Response.json({ data: [] }));
    expect(ready).toMatchObject({ available: true, device: "Cloud", label: "DeepSeek Flash", cloud: { available: true }, local: { available: true } });
    expect(Object.fromEntries(ready.routing.map((item) => [item.task, item.label]))).toMatchObject({
      chat: "DeepSeek Flash", route: "DeepSeek Flash", action: "DeepSeek V4 Pro", reasoning: "DeepSeek V4 Pro · Denkmodus",
      categorize: "DeepSeek Flash", web: "DeepSeek Flash", document: "Lokal (Qwen)",
    });
  });

  it("reports a rejected key and routes everything to the local model", async () => {
    const rejected = await status(() => new Response("{}", { status: 401 }));
    expect(rejected).toMatchObject({ available: true, device: "NPU", label: "Lokal (Qwen)", cloud: { available: false, error: "Key ungültig (HTTP 401)" } });
    expect(rejected.routing.every((item) => item.label === "Lokal (Qwen)" && item.fallback)).toBe(true);
    expect(cloudPause()).toBe("Key ungültig (HTTP 401)");
  });
});
