import { describe, expect, it } from "vitest";
import { figuresOf, onlyAssistantChanged, parseAssistantChanges, shareFigures, withAssistantState } from "@/lib/assistant-state";
import { createSeed } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const message = (text: string) => ({ id: crypto.randomUUID(), role: "user" as const, text, at: 1 });

describe("assistant-only state changes", () => {
  it("tells chat and learned phrasings apart from figures; memories feed forecasts and count as figures", () => {
    const base = createSeed();
    expect(onlyAssistantChanged(base, { ...base, assistantChat: [message("Hallo")], assistantPhrases: [] })).toBe(true);
    expect(onlyAssistantChanged(base, { ...base, assistantMemory: [] })).toBe(false);
    expect(onlyAssistantChanged(base, { ...base, transactions: [...base.transactions] })).toBe(false);
    expect(onlyAssistantChanged(base, { ...base, settings: { ...base.settings } })).toBe(false);
  });

  it("puts the chat written in the meantime onto a result computed from an older state", () => {
    const base = createSeed();
    const assigned: AppState = { ...base, transactions: [], assistantChat: [message("alt")] };
    const chatted: AppState = { ...base, assistantChat: [message("neu")] };
    const merged = withAssistantState(assigned, chatted);
    expect(merged.transactions).toBe(assigned.transactions);
    expect(merged.assistantChat).toBe(chatted.assistantChat);
    expect("assistantPhrases" in withAssistantState({ ...assigned, assistantPhrases: [] }, chatted)).toBe(false);
  });

  it("validates only the assistant fields that changed", () => {
    const base = createSeed();
    const chat = [message("Wie viel ist noch frei?")];
    expect(parseAssistantChanges(base, { ...base, assistantChat: chat }).assistantChat).toEqual(chat);
    expect(() => parseAssistantChanges(base, { ...base, assistantChat: [{ ...chat[0], role: "robot" }] } as unknown as AppState)).toThrow();
  });

  it("keys computed figures by the first state that had them", () => {
    const base = createSeed();
    const first = { ...base, assistantChat: [message("a")] };
    const second = { ...first, assistantChat: [message("b")] };
    shareFigures(first, base);
    shareFigures(second, first);
    expect(figuresOf(second)).toBe(base);
    expect(figuresOf(base)).toBe(base);
  });
});
