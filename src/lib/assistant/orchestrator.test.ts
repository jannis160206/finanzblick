import { describe, expect, it } from "vitest";
import { assistantMessageSchema } from "@/lib/types";
import {
  aboutMoney, agentIds, agentTools, chatRequest, parseAgent, routeByRules, specialistIds, toolOwner, type AgentId,
} from "./orchestrator";
import { assistantTools } from "./tools";

const names = ["Japan", "Pickerl"];
const route = (text: string) => routeByRules(text, names);

describe("orchestrator responsibilities", () => {
  it("has at most four specialists plus the general chat, and every tool has exactly one owner", () => {
    expect(specialistIds.length).toBeLessThanOrEqual(4);
    expect(specialistIds).not.toContain("general");
    const owned = agentIds.flatMap((agent) => agentTools(agent));
    expect(owned.toSorted()).toEqual([...assistantTools].toSorted());
    expect(new Set(owned).size).toBe(owned.length);
    for (const agent of specialistIds) expect(agentTools(agent).length).toBeGreaterThan(0);
    expect(toolOwner.ask).toBe("general");
    // The stored chat knows the same agents.
    for (const agent of agentIds) expect(assistantMessageSchema.shape.agent.safeParse(agent).success).toBe(true);
  });
});

describe("routing without the model", () => {
  it.each<[string, AgentId, string?]>([
    ["Wie viel hab ich im Oktober fürs Essen ausgegeben?", "transactions", "query"],
    ["Welche Buchungen sind doppelt?", "transactions"],
    ["Welche Abos habe ich?", "contracts", "contracts"],
    ["Kündige Netflix", "contracts", "cancel"],
    ["Was bleibt mir diesen Monat?", "budget", "budget"],
    ["Kann ich mir im Mai 900 € leisten?", "budget", "funds"],
    ["Wie viel netto bekomme ich im Dezember?", "payroll", "payroll"],
    ["Was bleibt vom Weihnachtsgeld?", "payroll", "payroll"],
    ["Wie viel vom Successbonus wird voll versteuert?", "payroll", "payroll"],
    ["Was kann ich bei der Arbeitnehmerveranlagung absetzen?", "payroll", "tax"],
    ["Hallo!", "general"],
    ["Was ist ein ETF?", "general", "knowledge"],
    ["Was ist der Unterschied zwischen Brutto und Netto?", "payroll", "payroll"],
    ["Warum zahle ich so viel Lohnsteuer?", "payroll", "payroll"],
    ["Wann kommt mein Bonus?", "payroll", "payroll"],
    ["???", "general"],
    ["Werden Überstunden anders versteuert?", "payroll", "payroll"],
    ["Wie viel hab ich bei Shell getankt?", "transactions", "query"],
    ["Ist Spotify teurer geworden?", "contracts", "contracts"],
  ])("typical: %s → %s", (text, agent, tool) => {
    const decision = route(text);
    expect(decision?.agent).toBe(agent);
    if (tool) expect(decision?.tool).toBe(tool);
  });

  it.each<[string, AgentId]>([
    // Borderline wording: signal words of exactly one specialist decide without a tool.
    ["wie viel is am sparkonto", "budget"],
    ["bin ich eigentlich sparsam", "budget"],
    ["wann hab ich japan zusammen", "budget"],
    ["rechne mir aus wie viel ich in 5 jahren hab wenn ich 300 im monat anlege", "budget"],
    ["Lohnt sich mein Fitnessstudio-Vertrag?", "contracts"],
    ["Wie viel Steuer zahle ich auf meine Prämie?", "payroll"],
    ["Reicht mein Gehalt bis Monatsende?", "budget"],
    ["Ist mein Gehalt schon da?", "budget"],
    // Nothing about money: the general chat answers right away.
    ["Erzähl mir einen Witz", "general"],
    ["Schreib mir ein Gedicht über Sparen", "general"],
    ["Was hältst du von Bitcoin?", "general"],
    ["Kannst du mir bei einer E-Mail an meinen Vermieter helfen?", "general"],
    ["Lohnt sich das?", "general"],
    // Compounds, English and questions about people in general.
    ["Sollte ich das Lebensmittelbudget erhöhen?", "budget"],
    ["how much did I spend on food in october", "transactions"],
    ["Kann man mit 3000 netto in Wien gut leben?", "general"],
  ])("borderline: %s → %s", (text, agent) => expect(route(text)?.agent).toBe(agent));

  it("sends spending questions without a tool to the transactions specialist", () =>
    expect(route("wo geht mein ganzes geld hin")).toEqual({ agent: "transactions", via: "signal" }));

  it.each([
    "Ich bin gestresst wegen Geld",
    "Ich hab das Gefühl, ich gebe zu viel aus",
  ])("leaves money questions without a clear owner to the model: %s", (text) => expect(route(text)).toBeUndefined());

  it("recognises chat requests and money topics", () => {
    expect(chatRequest("schreib mir ein gedicht über mein konto")).toBe(true);
    expect(chatRequest("Schreib die Kündigung für Netflix")).toBe(false);
    expect(aboutMoney("Wie wird das Wetter morgen?")).toBe(false);
    expect(aboutMoney("Was kostet mich Spotify?")).toBe(true);
    expect(aboutMoney("Wie viel ist übrig?")).toBe(true);
  });
});

describe("reading the router model", () => {
  it.each<[string, AgentId | undefined]>([
    ["budget", "budget"], ["<think>\n</think>\ngehalt", "payroll"], ["Vertraege.", "contracts"], ["Umsätze", "transactions"],
    ["chat", "general"], ["keine Ahnung", undefined], ["", undefined], ["budget oder gehalt", undefined],
  ])("%j → %s", (answer, agent) => expect(parseAgent(answer)).toBe(agent));
});
