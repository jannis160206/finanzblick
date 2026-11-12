import { describe, expect, it } from "vitest";
import { routeByRules, wantsKnowledge } from "./orchestrator";
import { statusFor, workStatus } from "./status";

const decide = (text: string) => routeByRules(text, []) ?? { agent: "general" as const };

describe("knowledge decision of the orchestrator", () => {
  it.each([
    "Wie viel sollte man als Notgroschen haben?", "Lohnt sich ein Bausparvertrag?", "Was hältst du von Bitcoin?", "Was ist ein ETF?",
    "Ist mein Geld bei einer Bankpleite sicher?", "Wie funktioniert die 50/30/20-Regel?",
  ])("searches the finance knowledge for %s", (text) => expect(wantsKnowledge(text, decide(text))).toBe(true));

  it.each([
    "Wie viel hab ich im Oktober für Lebensmittel ausgegeben?", "Welche Abos habe ich?", "Leg einen neuen Vertrag an", "Was bleibt mir diesen Monat?",
    "Lösch die Buchung vom 24.10.", "Hallo", "Wie viel netto bekomme ich?",
  ])("leaves %s to the tools without a knowledge search", (text) => expect(wantsKnowledge(text, decide(text))).toBe(false));
});

describe("live status", () => {
  it("names what each step does, how the orb moves and which agent works on it", () => {
    expect(statusFor("query", "transactions")).toEqual({ text: "Analysiere deine Buchungen…", activity: "working", agent: "transactions" });
    expect(statusFor("contracts", "contracts")).toMatchObject({ text: "Prüfe deine Verträge…", agent: "contracts" });
    expect(statusFor("pulse", "budget")).toMatchObject({ text: "Berechne dein freies Budget…", activity: "solving" });
    expect(statusFor("knowledge", "general")).toEqual({ ...workStatus.knowledge, agent: "general" });
    expect(workStatus.knowledge.activity).toBe("searching");
    expect(statusFor("booking", "transactions").activity).toBe("shaping");
    expect(statusFor(undefined, "payroll")).toEqual({ text: "Lese deine Lohnabrechnungen…", activity: "solving", agent: "payroll" });
  });
});
