import { describe, expect, it } from "vitest";
import { AiUnavailableError } from "./client";
import { readAiConfig } from "./config";
import type { ModelUse } from "./models";
import { cleanSupervision, supervise } from "./supervisor";

const config = readAiConfig({ DEEPSEEK_API_KEY: "sk-test-1234567890" });

describe("supervisor", () => {
  it("keeps reading steps only: no changing tool, the monthly plan instead of a calculator without an amount, at most four", () => {
    expect(cleanSupervision({ spezialist: "budget", art: "antwort", schritte: [
      { werkzeug: "pulse", frage: "Wie viel bleibt mir diesen Monat?" },
      { werkzeug: "budget_plan", frage: "Setz Tanken auf 150 €" },
      { werkzeug: "depot", frage: "Lohnt sich ein Sparplan?" },
      { werkzeug: "web", frage: "Wie hat sich Bitcoin entwickelt?" },
      { werkzeug: "depot", frage: "Was bringen 50 € im Monat in 10 Jahren?" },
      { werkzeug: "forecast", frage: "Wird mein Konto knapp?" },
    ] })).toEqual({ kind: "answer", agent: "budget", steps: [
      { tool: "pulse", question: "Wie viel bleibt mir diesen Monat?" }, { tool: "budget", question: "Lohnt sich ein Sparplan?" },
      { tool: "web", question: "Wie hat sich Bitcoin entwickelt?" }, { tool: "depot", question: "Was bringen 50 € im Monat in 10 Jahren?" },
    ] });
  });

  it.each<[string, unknown, ReturnType<typeof cleanSupervision>]>([
    ["a term is always researched on the web, too", { spezialist: "chat", art: "antwort", schritte: [{ werkzeug: "knowledge", frage: "Was ist eine Vorabpauschale?" }] },
      { kind: "answer", agent: "general", steps: [{ tool: "knowledge", question: "Was ist eine Vorabpauschale?" }, { tool: "web", question: "Was ist eine Vorabpauschale?" }] }],
    ["one tool is an answer with one step, owned by its specialist", { art: "werkzeug", schritte: [{ werkzeug: "contracts", frage: "Welche Abos habe ich?" }] },
      { kind: "answer", agent: "contracts", steps: [{ tool: "contracts", question: "Welche Abos habe ich?" }] }],
    ["a change goes to the specialist", { spezialist: "vertraege", art: "aktion" }, { kind: "action", agent: "contracts" }],
    ["a question back needs a real question", { spezialist: "umsaetze", art: "rueckfrage", rueckfrage: "Welche der zwei Buchungen bei Billa meinst du?" },
      { kind: "ask", agent: "transactions", question: "Welche der zwei Buchungen bei Billa meinst du?" }],
    ["anything vague becomes a written answer", { art: "rueckfrage", rueckfrage: "Betrag" }, { kind: "answer", agent: "general", steps: [] }],
  ])("%s", (_label, raw, expected) => expect(cleanSupervision(raw)).toEqual(expected));

  it("answers from the user's figures instead of asking for a price, an amount or a duration", () => {
    expect(cleanSupervision({ spezialist: "budget", art: "rueckfrage", rueckfrage: "Wie viel soll das neue Handy kosten?" }, undefined, "Kann ich mir ein neues Handy leisten?"))
      .toEqual({ kind: "answer", agent: "budget", steps: [{ tool: "budget", question: "Kann ich mir ein neues Handy leisten?" }] });
    expect(cleanSupervision({ spezialist: "budget", art: "rueckfrage", rueckfrage: "Über welchen Zeitraum willst du sparen?", schritte: [{ werkzeug: "pulse", frage: "Was ist frei?" }] }))
      .toEqual({ kind: "answer", agent: "budget", steps: [{ tool: "pulse", question: "Was ist frei?" }] });
    // Which of several bookings is meant stays a real question, even when it names an amount.
    expect(cleanSupervision({ spezialist: "umsaetze", art: "rueckfrage", rueckfrage: "Welche Buchung meinst du, die mit dem Betrag 49,99 € oder 59,99 €?" }))
      .toMatchObject({ kind: "ask" });
  });

  it("asks DeepSeek Flash with the team, the data overview and the rule hint, and fails without DeepSeek instead of asking the local model", async () => {
    let body: { model?: string; messages?: { content: string }[] } = {};
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: '{"spezialist": "budget", "art": "antwort", "schritte": []}' } }] });
    }) as typeof fetch;
    const trace: ModelUse[] = [];
    const plan = await supervise({ message: "Kann ich mir ein neues Handy leisten?", hint: "funds", overview: { freeUntilSalary: { freeUntilSalary: 412.5 } } },
      { config, fetcher, trace, rules: ["Nenne immer den Monat."] });
    expect(plan).toEqual({ kind: "answer", agent: "budget", steps: [] });
    expect(trace).toMatchObject([{ model: "deepseek-flash", task: "supervise" }]);
    expect(body.messages?.[0].content).toMatch(/budget_plan\* = [\s\S]*\nweb = /);
    expect(body.messages?.[0].content).toContain("Nenne immer den Monat.");
    expect(body.messages?.[1].content).toContain('Datenüberblick (JSON): {"freeUntilSalary":{"freeUntilSalary":412.5}}');
    expect(body.messages?.[1].content).toContain("Die Regeln würden funds nehmen");
    await expect(supervise({ message: "x" }, { config: { ...config, cloud: undefined }, fetcher })).rejects.toThrow(AiUnavailableError);
  });
});
