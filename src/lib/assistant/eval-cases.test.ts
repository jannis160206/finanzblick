import { describe, expect, it } from "vitest";
import { interpretAssistantMessage } from "@/lib/ai/assistant";
import { agentCases, injectionCases, routerCases } from "./eval-cases";
import { toolOwner } from "./orchestrator";

const offline = { enabled: false, baseUrl: "http://127.0.0.1:1/v3", model: "test", minConfidence: 90, timeoutMs: 5_000 };
const route = (item: typeof routerCases[number]) => interpretAssistantMessage({
  message: item.message, asOf: "2026-11-05", context: { goals: ["Japan"], planned: ["Pickerl"] }, ...(item.history ? { history: item.history } : {}),
}, { config: offline });

describe("assistant golden questions without the model", () => {
  it("never routes to a wrong tool; unclear wording is left to the model", async () => {
    const wrong: string[] = [];
    let hits = 0;
    for (const item of [...routerCases, ...injectionCases]) {
      const { tool } = await route(item);
      if (tool && !(item.tools as string[]).includes(tool)) wrong.push(`${item.message} → ${tool}`);
      if (tool) hits += 1;
    }
    expect(wrong).toEqual([]);
    expect(hits / (routerCases.length + injectionCases.length)).toBeGreaterThanOrEqual(0.9);
  });
});

describe("orchestrator golden questions without the model", () => {
  it("sends every golden question to the owner of its tool, and borderline wording never to a wrong specialist", async () => {
    const wrong: string[] = [];
    for (const item of routerCases) {
      const reply = await route(item);
      if (reply.tool && reply.agent !== toolOwner[reply.tool]) wrong.push(`${item.message} → ${reply.agent}/${reply.tool}`);
    }
    for (const item of agentCases) {
      const reply = await route({ message: item.message, tools: [] });
      // Offline the model cannot decide: unclear wording must land in the general chat, never with a guessed specialist.
      if (!item.agents.includes(reply.agent) && reply.agent !== "general") wrong.push(`${item.message} → ${reply.agent}`);
    }
    expect(wrong).toEqual([]);
  });
});
