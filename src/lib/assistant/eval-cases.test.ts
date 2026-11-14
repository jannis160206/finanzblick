import { describe, expect, it } from "vitest";
import { interpretAssistantMessage } from "@/lib/ai/assistant";
import {
  agentCases, deepActionCases, deepAnswerCases, goldRouterCases, injectionCases, routerCases, smokeAnswerCases, smokeRouterCases,
} from "./eval-cases";
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

describe("eval tiers stay small and cheap", () => {
  it("keeps gold at most 80 questions, smoke about 25 requests and deep between 10 and 15 cases", () => {
    const gold = [...goldRouterCases, ...agentCases.map((item) => ({ message: item.message })), ...injectionCases];
    expect(gold.length).toBeLessThanOrEqual(80);
    expect(new Set(goldRouterCases.map((item) => item.message)).size).toBe(goldRouterCases.length);
    // Two pings, the routing questions and the short answers.
    expect(2 + smokeRouterCases.length + smokeAnswerCases.length).toBeGreaterThanOrEqual(20);
    expect(2 + smokeRouterCases.length + smokeAnswerCases.length).toBeLessThanOrEqual(30);
    expect(deepActionCases.length + deepAnswerCases.length).toBeGreaterThanOrEqual(10);
    expect(deepActionCases.length + deepAnswerCases.length).toBeLessThanOrEqual(15);
  });

  it("never lets the rules pick a wrong tool for the deep actions", async () => {
    for (const item of deepActionCases) {
      const { tool } = await route(item);
      if (tool) expect(item.tools).toContain(tool);
    }
  });
});
