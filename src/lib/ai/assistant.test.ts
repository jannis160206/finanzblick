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

  it("answers messages without a money topic in the general chat, without any model call", async () => {
    expect(await interpretAssistantMessage(request("Erzähl mir einen Witz"))).toEqual({ agent: "general", via: "rule", source: "Regel" });
    expect(await interpretAssistantMessage(request("Schreib mir ein Gedicht über Sparen"))).toEqual({ agent: "general", via: "rule", source: "Regel" });
    expect(chat).not.toHaveBeenCalled();
  });

  it("asks the model once for a single word when the owner is unclear, and falls back to the general chat when unsure", async () => {
    chat.mockResolvedValueOnce({ content: "umsaetze" });
    expect(await interpretAssistantMessage(request("Ich hab das Gefühl, ich gebe zu viel aus"))).toEqual({ agent: "transactions", via: "model", source: "KI" });
    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, options] = chat.mock.calls[0] as [{ content: string }[], { maxTokens: number }];
    expect(messages[0].content).toContain("Wenn du nicht sicher bist, antworte chat");
    expect(options.maxTokens).toBeLessThanOrEqual(8);
    chat.mockResolvedValueOnce({ content: "Das ist schwer zu sagen, vielleicht budget oder gehalt." });
    expect(await interpretAssistantMessage(request("Ich bin gestresst wegen Geld"))).toEqual({ agent: "general", via: "fallback", source: "Regel" });
    chat.mockRejectedValueOnce(new AiUnavailableError());
    expect(await interpretAssistantMessage(request("Ich bin gestresst wegen Geld"))).toEqual({ agent: "general", via: "fallback", source: "Regel" });
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it("lets a specialist interpret with its own tools only, in one call", async () => {
    // A tool of another agent is ignored: the specialist answers in words instead.
    chat.mockResolvedValueOnce({ content: JSON.stringify({ tool: "query" }) });
    const reply = await interpretAssistantMessage(request("Werden Überstunden anders versteuert?"));
    expect(reply).toMatchObject({ agent: "payroll", via: "signal", source: "KI" });
    expect(reply.tool).toBeUndefined();
    const [messages] = chat.mock.calls[0] as [{ content: string }[]];
    expect(messages[0].content).toContain("payroll = ");
    expect(messages[0].content).not.toMatch(/\bquery = |\bbudget_plan = /);
    expect(messages[1].content).not.toContain("Kategorien:");
    chat.mockResolvedValueOnce({ content: JSON.stringify({ tool: "payroll" }) });
    expect(await interpretAssistantMessage(request("Werden Überstunden anders versteuert?"))).toMatchObject({ agent: "payroll", tool: "payroll" });
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
