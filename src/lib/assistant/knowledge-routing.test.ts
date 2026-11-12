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
  it("names what each step does", () => {
    expect(statusFor("query", "transactions")).toBe("Analysiere deine Buchungen…");
    expect(statusFor("contracts", "contracts")).toBe("Prüfe deine Verträge…");
    expect(statusFor("pulse", "budget")).toBe("Berechne dein freies Budget…");
    expect(statusFor("knowledge", "general")).toBe(workStatus.knowledge);
    expect(statusFor(undefined, "payroll")).toBe("Lese deine Lohnabrechnungen…");
  });
});
