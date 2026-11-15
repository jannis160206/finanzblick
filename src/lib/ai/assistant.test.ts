import { afterEach, describe, expect, it, vi } from "vitest";
import { AiUnavailableError } from "./client";

const chat = vi.fn();
vi.mock("./client", async (original) => ({ ...(await original<typeof import("./client")>()), chat: (...args: unknown[]) => chat(...args) }));
const { extractJsonObject, interpretAssistantMessage } = await import("./assistant");

afterEach(() => chat.mockReset());

describe("assistant AI interpretation", () => {
  it("extracts the JSON object around thinking text", () => {
    expect(extractJsonObject("Antwort: {\"action\":\"expense\"} fertig")).toEqual({ action: "expense" });
    expect(extractJsonObject("kein json")).toBeUndefined();
  });

  it("keeps model roles that the message backs and drops invented numbers", async () => {
    chat.mockResolvedValueOnce({ content: JSON.stringify({ action: "savings_goal", name: "Japan", amount: 3000, startCapital: 500, monthly: 278 }) });
    const reply = await interpretAssistantMessage({ message: "Japan 3.000 € bis Juli 2027 sparen, 500 € habe ich schon am Sparkonto", asOf: "2026-10-07", delegated: true });
    expect(reply).toMatchObject({ source: "KI", tool: "savings_goal", draft: { action: "savings_goal", name: "Japan", amount: 3000, startCapital: 500, fromAccount: "Sparkonto", date: "2027-07-31" } });
  });

  it("fills a plain answer to the open draft's question without asking the model", async () => {
    const pending = { action: "savings_goal" as const, name: "Urlaub in Japan" };
    const reply = await interpretAssistantMessage({ message: "3000 €", asOf: "2026-10-07", pending });
    expect(chat).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ source: "Regel", via: "rule", tool: "savings_goal", draft: { name: "Urlaub in Japan", amount: 3000 }, question: expect.stringMatching(/Bis wann/) });
  });

  it("falls back to the rule parser when the NPU is offline", async () => {
    chat.mockRejectedValue(new AiUnavailableError());
    const reply = await interpretAssistantMessage({ message: "Im März kommt das Pickerl", asOf: "2026-10-07" });
    expect(reply).toMatchObject({ source: "Regel", tool: "expense", draft: { action: "expense", name: "Pickerl", date: "2027-03-01" }, question: expect.stringContaining("Pickerl") });
  });

  it("routes a handed-over change to its specialist and keeps only hints the message and context back", async () => {
    chat.mockResolvedValueOnce({ content: JSON.stringify({ tool: "edit", goal: "Japan", planned: "Erfunden", merchant: "Billa", category: "Gibtsnicht" }) });
    const reply = await interpretAssistantMessage({ message: "Erhöhe Japan auf 4.000 €", asOf: "2026-10-07", context: { goals: ["Japan"], planned: [] }, delegated: true });
    expect(reply).toEqual({ agent: "budget", via: "orchestrator", source: "KI", tool: "edit", hints: { goal: "Japan" } });
    expect((chat.mock.calls[0] as [unknown, { task: string }])[1].task).toBe("action");
  });

  it("lets clear rule words win over the model tool; a handed-over change without model hints costs no call", async () => {
    expect(await interpretAssistantMessage({ message: "Mach das rückgängig", asOf: "2026-10-07", delegated: true })).toMatchObject({ tool: "undo", via: "orchestrator" });
    expect(chat).not.toHaveBeenCalled();
    chat.mockRejectedValue(new AiUnavailableError());
    expect((await interpretAssistantMessage({ message: "Wie viel hab ich im Oktober für Lebensmittel ausgegeben?", asOf: "2026-10-07" })).tool).toBe("query");
  });
});

describe("change workflow and local routing", () => {
  const request = (message: string) => ({ message, asOf: "2026-10-07", context: { goals: ["Japan"], planned: [] } });

  it("answers system commands by rule; without the agents small talk and creative requests are answered locally without a model", async () => {
    expect(await interpretAssistantMessage(request("Wie spät ist es?"))).toMatchObject({ agent: "general", via: "rule" });
    expect(await interpretAssistantMessage(request("Schreib mir ein Gedicht über Sparen"))).toEqual({ agent: "general", via: "rule", source: "Regel", local: true });
    expect(await interpretAssistantMessage(request("Erzähl mir einen Witz"))).toEqual({ agent: "general", via: "rule", source: "Regel", local: true });
    expect(chat).not.toHaveBeenCalled();
  });

  it("answers a correction without DeepSeek in words, never by the form its words look like", async () => {
    const message = "Nein das ist für American Express ich meine mein Raiffeisen Bankkonto das mich im quartal 36€ kostet ca.";
    const history = [{ role: "user" as const, text: "Welche Kontogebühren zahle ich?" }, { role: "assistant" as const, text: "Für American Express zahlst du 72 € im Jahr." }];
    expect(await interpretAssistantMessage({ ...request(message), history, correction: true })).toEqual({ agent: "general", via: "fallback", source: "Regel", local: true });
    expect(chat).not.toHaveBeenCalled();
  });

  it("routes locally: one word from the model, the general chat when unsure", async () => {
    chat.mockResolvedValueOnce({ content: "umsaetze" });
    expect(await interpretAssistantMessage(request("Ich hab das Gefühl, ich gebe zu viel aus"))).toEqual({ agent: "transactions", via: "model", source: "KI", local: true });
    const [messages, options] = chat.mock.calls[0] as [{ content: string }[], { maxTokens: number }];
    expect(messages[0].content).toContain("Wenn du nicht sicher bist, antworte chat");
    expect(options.maxTokens).toBeLessThanOrEqual(8);
    chat.mockResolvedValueOnce({ content: "Das ist schwer zu sagen, vielleicht budget oder gehalt." });
    expect(await interpretAssistantMessage(request("Ich bin gestresst wegen Geld"))).toEqual({ agent: "general", via: "fallback", source: "Regel", local: true });
    chat.mockRejectedValue(new AiUnavailableError());
    expect(await interpretAssistantMessage(request("Ich bin gestresst wegen Geld"))).toEqual({ agent: "general", via: "fallback", source: "Regel", local: true });
  });

  it("hands a change to its specialist, who interprets with its own tools only", async () => {
    // A tool of another agent is ignored: the specialist answers in words instead.
    chat.mockResolvedValueOnce({ content: JSON.stringify({ tool: "query" }) });
    const reply = await interpretAssistantMessage({ ...request("Wie wird meine Rufbereitschaft abgerechnet?"), delegated: true });
    expect(reply).toMatchObject({ agent: "payroll", via: "orchestrator", source: "KI" });
    expect(reply.tool).toBeUndefined();
    const [messages, options] = chat.mock.calls[0] as [{ content: string }[], { task: string }];
    expect(options.task).toBe("action");
    expect(messages[0].content).toContain("payroll = ");
    expect(messages[0].content).not.toMatch(/\bquery = |\bbudget_plan = /);
    expect(messages[1].content).not.toContain("Kategorien:");
  });
});
