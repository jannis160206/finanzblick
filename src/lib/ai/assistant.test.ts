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
    expect(reply).toEqual({ source: "KI", draft: { action: "savings_goal", name: "Japan", amount: 3000, startCapital: 500, fromAccount: "Sparkonto", date: "2027-07-31" } });
  });

  it("falls back to the rule parser when the NPU is offline", async () => {
    chat.mockRejectedValue(new AiUnavailableError());
    const reply = await interpretAssistantMessage({ message: "Im März kommt das Pickerl", asOf: "2026-10-07" });
    expect(reply).toEqual({ source: "Regel", draft: { action: "expense", name: "Pickerl", date: "2027-03-01" }, question: expect.stringContaining("Pickerl") });
  });
});
