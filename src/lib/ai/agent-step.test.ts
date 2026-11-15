import { describe, expect, it } from "vitest";
import { defaultPrompts } from "./agent-prompts";
import { agentSystemPrompt, agentToolDefinitions, runAgentStep, type AgentStepEvent, type AgentStepRequest } from "./agent-step";
import { readAiConfig } from "./config";
import { DATA_RULE } from "./untrusted";
import { codeRepo } from "@/lib/server/agent-repo-store";

const config = readAiConfig({ DEEPSEEK_API_KEY: "sk-test-1234567890" });
const sse = (chunks: object[]) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    controller.close();
  },
}), { headers: { "Content-Type": "text/event-stream" } });
const text = (content: string) => ({ choices: [{ delta: { content } }] });

/** A DeepSeek stub that records the request bodies and answers with the given response. */
function stub(answer: () => Response) {
  const bodies: { messages: { role: string; content: string | null; tool_calls?: unknown[] }[]; tools?: { function: { name: string } }[]; model: string }[] = [];
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return answer();
  }) as typeof fetch;
  return { bodies, fetcher };
}

async function collect(input: AgentStepRequest, fetcher: typeof fetch) {
  const events: AgentStepEvent[] = [];
  for await (const event of runAgentStep(input, { config, fetcher, repo: codeRepo() })) events.push(event);
  return events;
}

describe("agent step", () => {
  it("builds each agent's prompt from the repo: the orchestrator with answer rules and grounding, a specialist with knowledge and data sources", () => {
    const repo = codeRepo();
    const lead = agentSystemPrompt("orchestrator", repo, [{ text: "Nenne immer den Stand.", scope: "all", target: "answer" }]);
    expect(lead.startsWith(defaultPrompts["agent.orchestrator"])).toBe(true);
    expect(lead).toContain(defaultPrompts["answer-rules"]);
    expect(lead).toContain("Zahlen zu den Finanzen des Nutzers nimmst du nur aus den Ergebnissen der Spezialisten");
    expect(lead).toMatch(/1\) Nenne immer den Stand\.$/);
    const payroll = agentSystemPrompt("payroll", repo, [{ text: "Nenne das Jahressechstel.", scope: "payroll", target: "answer" }, { text: "Fremd.", scope: "budget", target: "answer" }]);
    expect(payroll).toContain("### Lohnsteuer und Sonderzahlungen in Österreich");
    expect(payroll).toContain("Deine Datenquellen:\n- Lohnabrechnungen:");
    expect(payroll).toContain(DATA_RULE);
    expect(payroll).toContain("1) Nenne das Jahressechstel.");
    expect(payroll).not.toContain("Fremd.");
    // The orchestrator's tools are its specialists and the change workflow; a specialist only gets its reading tools.
    expect(agentToolDefinitions("orchestrator", repo).map((tool) => tool.function.name)).toEqual(["umsaetze", "vertraege", "budget", "gehalt", "recherche", "aenderung"]);
    const budget = agentToolDefinitions("budget", { ...repo, tools: { ...repo.tools, pulse: "Was heute frei ist." } });
    expect(budget.find((tool) => tool.function.name === "pulse")?.function).toMatchObject({ description: "Was heute frei ist.",
      parameters: { required: ["frage"] } });
    expect(budget.map((tool) => tool.function.name)).not.toContain("budget_plan");
  });

  it("streams the orchestrator's answer grounded in the specialists' raw results and replays the run so far", async () => {
    const { bodies, fetcher } = stub(() => sse([text("Dir bleiben **412,50 €** frei."), text(" Dazu kommen 999 € Bonus."), text(" Gut so.")]));
    const events = await collect({ agent: "orchestrator", asOf: "2026-11-15", message: "Wie viel ist frei?", evidence: "Monats-Puls: Frei 412,50 €",
      turns: [{ calls: [{ id: "o1", name: "budget", arguments: "{\"aufgabe\":\"Frei?\"}" }], results: [{ id: "o1", content: "Frei: 412,50 €" }] }] }, fetcher);
    expect(events[0]).toMatchObject({ limits: { maxSteps: 5, maxToolCalls: 8 } });
    expect(events.at(-1)).toEqual({ done: true, ok: true, text: "Dir bleiben **412,50 €** frei. Gut so." });
    expect(events.some((event) => "model" in event && event.model.task === "orchestrate")).toBe(true);
    const [body] = bodies;
    expect(body.model).toBe(config.cloud?.models.pro);
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[1].content).toContain("Nachricht: Wie viel ist frei?");
    expect(body.tools?.map((tool) => tool.function.name)).toContain("aenderung");
  });

  it("ends a step with the tool calls the model made, and forces words on the last step", async () => {
    const calls = sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "budget", arguments: "{\"aufga" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "be\":\"Frei?\"}" } }] } }] }]);
    const { fetcher } = stub(() => calls);
    const events = await collect({ agent: "orchestrator", asOf: "2026-11-15", message: "Wie viel ist frei?", turns: [] }, fetcher);
    expect(events.at(-1)).toEqual({ calls: [{ id: "c1", name: "budget", arguments: "{\"aufgabe\":\"Frei?\"}" }] });
    const last = stub(() => Response.json({ choices: [{ message: { content: "Frei: 412,50 €" } }] }));
    expect((await collect({ agent: "budget", asOf: "2026-11-15", message: "Frei?", final: true, turns: [] }, last.fetcher)).at(-1))
      .toEqual({ done: true, ok: true, text: "Frei: 412,50 €" });
    expect(last.bodies[0].tools).toBeUndefined();
    expect(last.bodies[0].messages.at(-1)?.content).toContain("keine weiteren Werkzeuge");
  });
});
