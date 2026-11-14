import { describe, expect, it } from "vitest";
import { AiUnavailableError } from "./client";
import { readAiConfig } from "./config";
import { cleanPlan, planLookups } from "./planner";

const config = readAiConfig({ DEEPSEEK_API_KEY: "sk-test-1234567890" });

describe("free choice of lookups", () => {
  it("keeps up to three known reading tools with a question each and never a changing one", () => {
    expect(cleanPlan({ schritte: [
      { werkzeug: "query", frage: "Ausgaben für Lebensmittel im Oktober" },
      { werkzeug: "booking", frage: "Lösch die Buchung vom 3.11." },
      { werkzeug: "web", frage: "aktueller Bitcoin-Preis" },
      { werkzeug: "query", frage: "Ausgaben für Lebensmittel im Oktober" },
      { werkzeug: "forecast", frage: "Wird mein Konto bis Jänner knapp?" },
      { werkzeug: "contracts", frage: "Welche Abos habe ich?" },
      { werkzeug: "budget_plan", frage: "Setz Tanken auf 150 €" },
    ] })).toEqual([
      { tool: "query", question: "Ausgaben für Lebensmittel im Oktober" }, { tool: "web", question: "aktueller Bitcoin-Preis" },
      { tool: "forecast", question: "Wird mein Konto bis Jänner knapp?" },
    ]);
    expect(cleanPlan({ schritte: [] })).toEqual([]);
    expect(cleanPlan("kein Plan")).toEqual([]);
  });

  it("asks DeepSeek's pro model with the reading tools only, and fails without DeepSeek instead of asking the local model", async () => {
    let body: { model?: string; messages?: { content: string }[] } = {};
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: '{"schritte": [{"werkzeug": "pulse", "frage": "Wie viel kann ich heute ausgeben?"}]}' } }] });
    }) as typeof fetch;
    const plan = await planLookups({ question: "Kann ich heute noch essen gehen?", agent: "budget" }, { config, fetcher });
    expect(plan).toEqual({ steps: [{ tool: "pulse", question: "Wie viel kann ich heute ausgeben?" }], models: [{ provider: "deepseek", model: "deepseek-v4-pro", task: "plan" }] });
    expect(body.messages?.[0].content).toContain("web = aktuelle öffentliche Informationen");
    expect(body.messages?.[0].content).not.toMatch(/\bbooking =|\bbudget_plan =|\bedit =/);
    await expect(planLookups({ question: "x" }, { config: { ...config, cloud: undefined }, fetcher })).rejects.toThrow(AiUnavailableError);
  });
});
