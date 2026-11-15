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
    chat.mockResolvedValue({ content: JSON.stringify({ action: "savings_goal", name: "Japan", amount: 3000, startCapital: 500, monthly: 278 }) });
    const reply = await interpretAssistantMessage({ message: "Japan 3.000 € bis Juli 2027 sparen, 500 € habe ich schon am Sparkonto", asOf: "2026-10-07" });
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

  it("routes agent tools and keeps only hints the message and context back", async () => {
    chat.mockResolvedValue({ content: JSON.stringify({ tool: "edit", goal: "Japan", planned: "Erfunden", merchant: "Billa", category: "Gibtsnicht" }) });
    const reply = await interpretAssistantMessage({ message: "Erhöhe Japan auf 4.000 €", asOf: "2026-10-07", context: { goals: ["Japan"], planned: [] } });
    expect(reply).toEqual({ agent: "budget", via: "rule", source: "KI", tool: "edit", hints: { goal: "Japan" } });
  });

  it("lets clear rule words win over the model tool", async () => {
    chat.mockResolvedValue({ content: JSON.stringify({ tool: "query" }) });
    const reply = await interpretAssistantMessage({ message: "Mach das rückgängig", asOf: "2026-10-07" });
    expect(reply.tool).toBe("undo");
    chat.mockRejectedValue(new AiUnavailableError());
    expect((await interpretAssistantMessage({ message: "Wie viel hab ich im Oktober für Lebensmittel ausgegeben?", asOf: "2026-10-07" })).tool).toBe("query");
  });
});

describe("orchestrator", () => {
  const request = (message: string) => ({ message, asOf: "2026-10-07", context: { goals: ["Japan"], planned: [] } });

  it("lets the supervisor decide small talk and creative requests, too; without DeepSeek the rules answer them without a model", async () => {
    chat.mockResolvedValueOnce({ content: JSON.stringify({ spezialist: "chat", art: "antwort", schritte: [] }) });
    expect(await interpretAssistantMessage(request("Schreib mir ein Gedicht über Sparen"))).toEqual({ agent: "general", via: "supervisor", source: "KI", supervised: true });
    chat.mockRejectedValue(new AiUnavailableError());
    expect(await interpretAssistantMessage(request("Schreib mir ein Gedicht über Sparen"))).toEqual({ agent: "general", via: "rule", source: "Regel", local: true });
    expect(await interpretAssistantMessage(request("Erzähl mir einen Witz"))).toEqual({ agent: "general", via: "rule", source: "Regel", local: true });
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it("keeps clear changes with their specialist, without the supervisor", async () => {
    chat.mockResolvedValueOnce({ content: JSON.stringify({ tool: "edit", goal: "Japan" }) });
    expect(await interpretAssistantMessage(request("Erhöhe Japan auf 4.000 €"))).toMatchObject({ agent: "budget", via: "rule", tool: "edit" });
    const [, options] = chat.mock.calls[0] as [unknown, { task: string }];
    expect(options.task).toBe("action");
  });

  it("lets the supervisor answer advice from reading steps instead of asking for an amount", async () => {
    chat.mockResolvedValueOnce({ content: JSON.stringify({ spezialist: "budget", art: "antwort", schritte: [
      { werkzeug: "pulse", frage: "Wie viel bleibt mir im Monat übrig?" }, { werkzeug: "depot", frage: "Lohnt sich ein Sparplan?" },
      { werkzeug: "web", frage: "Wie hat sich Bitcoin in 30 Tagen entwickelt?" }] }) });
    const reply = await interpretAssistantMessage(request("Lohnt sich ein Bitcoin-Sparplan für mein Budget?"));
    expect(reply).toEqual({ agent: "budget", via: "supervisor", source: "KI", supervised: true, steps: [
      { tool: "pulse", question: "Wie viel bleibt mir im Monat übrig?" }, { tool: "budget", question: "Lohnt sich ein Sparplan?" },
      { tool: "web", question: "Wie hat sich Bitcoin in 30 Tagen entwickelt?" }] });
    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, options] = chat.mock.calls[0] as [{ content: string }[], { task: string; cloudOnly: boolean }];
    expect(options).toMatchObject({ task: "supervise", cloudOnly: true });
    expect(messages[1].content).toContain("Die Regeln würden depot nehmen");
  });

  it("routes locally without the supervisor: one word from the model, the general chat when unsure", async () => {
    chat.mockRejectedValueOnce(new AiUnavailableError()).mockResolvedValueOnce({ content: "umsaetze" });
    expect(await interpretAssistantMessage(request("Ich hab das Gefühl, ich gebe zu viel aus"))).toEqual({ agent: "transactions", via: "model", source: "KI", local: true });
    const [messages, options] = chat.mock.calls[1] as [{ content: string }[], { maxTokens: number }];
    expect(messages[0].content).toContain("Wenn du nicht sicher bist, antworte chat");
    expect(options.maxTokens).toBeLessThanOrEqual(8);
    chat.mockRejectedValueOnce(new AiUnavailableError()).mockResolvedValueOnce({ content: "Das ist schwer zu sagen, vielleicht budget oder gehalt." });
    expect(await interpretAssistantMessage(request("Ich bin gestresst wegen Geld"))).toEqual({ agent: "general", via: "fallback", source: "Regel", local: true });
    chat.mockRejectedValue(new AiUnavailableError());
    expect(await interpretAssistantMessage(request("Ich bin gestresst wegen Geld"))).toEqual({ agent: "general", via: "fallback", source: "Regel", local: true });
  });

  it("hands a change to its specialist, who interprets with its own tools only", async () => {
    // A tool of another agent is ignored: the specialist answers in words instead.
    chat.mockResolvedValueOnce({ content: JSON.stringify({ spezialist: "gehalt", art: "aktion" }) }).mockResolvedValueOnce({ content: JSON.stringify({ tool: "query" }) });
    const reply = await interpretAssistantMessage(request("Wie wird meine Rufbereitschaft abgerechnet?"));
    expect(reply).toMatchObject({ agent: "payroll", via: "supervisor", source: "KI" });
    expect(reply.tool).toBeUndefined();
    const [messages, options] = chat.mock.calls[1] as [{ content: string }[], { task: string }];
    expect(options.task).toBe("action");
    expect(messages[0].content).toContain("payroll = ");
    expect(messages[0].content).not.toMatch(/\bquery = |\bbudget_plan = /);
    expect(messages[1].content).not.toContain("Kategorien:");
  });
});
