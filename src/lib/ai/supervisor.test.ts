import { describe, expect, it } from "vitest";
import { AiUnavailableError } from "./client";
import { readAiConfig } from "./config";
import type { ModelUse } from "./models";
import { cleanSupervision, supervise } from "./supervisor";

const config = readAiConfig({ DEEPSEEK_API_KEY: "sk-test-1234567890" });

describe("supervisor", () => {
  it("keeps reading steps only: no changing tool, the monthly plan instead of a calculator without an amount, at most three", () => {
    expect(cleanSupervision({ spezialist: "budget", art: "antwort", schritte: [
      { werkzeug: "pulse", frage: "Wie viel bleibt mir diesen Monat?" },
      { werkzeug: "budget_plan", frage: "Setz Tanken auf 150 €" },
      { werkzeug: "depot", frage: "Lohnt sich ein Sparplan?" },
      { werkzeug: "web", frage: "Wie hat sich Bitcoin entwickelt?" },
      { werkzeug: "depot", frage: "Was bringen 50 € im Monat in 10 Jahren?" },
      { werkzeug: "forecast", frage: "Wird mein Konto knapp?" },
    ] })).toEqual({ kind: "answer", agent: "budget", steps: [
      { tool: "pulse", question: "Wie viel bleibt mir diesen Monat?" }, { tool: "budget", question: "Lohnt sich ein Sparplan?" },
      { tool: "web", question: "Wie hat sich Bitcoin entwickelt?" },
    ] });
    expect(cleanSupervision({ art: "werkzeug", schritte: [{ werkzeug: "funds", frage: "Kann ich mir ein Handy leisten?" }] }))
      .toEqual({ kind: "answer", agent: "budget", steps: [{ tool: "budget", question: "Kann ich mir ein Handy leisten?" }] });
  });

  it.each<[string, unknown, ReturnType<typeof cleanSupervision>]>([
    ["one reading tool answers directly, owned by its specialist", { spezialist: "chat", art: "werkzeug", schritte: [{ werkzeug: "query", frage: "essen oktober" }], kategorie: "Lebensmittel & Haushalt" },
      { kind: "tool", agent: "transactions", tool: "query", category: "Lebensmittel & Haushalt" }],
    ["a changing tool is never run directly", { spezialist: "budget", art: "werkzeug", schritte: [{ werkzeug: "edit", frage: "Japan auf 4000" }] },
      { kind: "answer", agent: "budget", steps: [] }],
    ["a change goes to the specialist", { spezialist: "vertraege", art: "aktion" }, { kind: "action", agent: "contracts" }],
    ["a question back needs a real question", { spezialist: "umsaetze", art: "rueckfrage", rueckfrage: "Welche der zwei Buchungen bei Billa meinst du?" },
      { kind: "ask", agent: "transactions", question: "Welche der zwei Buchungen bei Billa meinst du?" }],
    ["anything vague becomes a written answer", { art: "rueckfrage", rueckfrage: "Betrag" }, { kind: "answer", agent: "general", steps: [] }],
  ])("%s", (_label, raw, expected) => expect(cleanSupervision(raw)).toEqual(expected));

  it("asks DeepSeek V4 Pro with the whole team and the rule hint, and fails without DeepSeek instead of asking the local model", async () => {
    let body: { model?: string; messages?: { content: string }[] } = {};
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: '{"spezialist": "budget", "art": "antwort", "schritte": [{"werkzeug": "pulse", "frage": "Wie viel bleibt mir?"}]}' } }] });
    }) as typeof fetch;
    const trace: ModelUse[] = [];
    const plan = await supervise({ message: "Kann ich mir ein neues Handy leisten?", hint: "funds" }, { config, fetcher, trace, rules: ["Nenne immer den Monat."] });
    expect(plan).toEqual({ kind: "answer", agent: "budget", steps: [{ tool: "pulse", question: "Wie viel bleibt mir?" }] });
    expect(trace).toMatchObject([{ model: "deepseek-v4-pro", task: "supervise" }]);
    expect(body.messages?.[0].content).toMatch(/budget_plan\* = [\s\S]*\nweb = /);
    expect(body.messages?.[0].content).toContain("Nenne immer den Monat.");
    expect(body.messages?.[1].content).toContain("Die Regeln würden funds nehmen");
    await expect(supervise({ message: "x" }, { config: { ...config, cloud: undefined }, fetcher })).rejects.toThrow(AiUnavailableError);
  });
});
