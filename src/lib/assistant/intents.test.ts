import { describe, expect, it, vi } from "vitest";
import { AiUnavailableError } from "@/lib/ai/client";
import { splitQuestion } from "./combined";
import { clarifyChoices, intentFrame, reconcileIntent } from "./intents";
import { detectTool } from "./tools";

vi.mock("@/lib/ai/client", async (original) => ({
  ...(await original<typeof import("@/lib/ai/client")>()),
  chat: () => Promise.reject(new AiUnavailableError("offline")),
}));
const { interpretAssistantMessage } = await import("@/lib/ai/assistant");

const variants: [string, string[]][] = [
  ...["erstelle vertrag", "mach mir einen Vertrag", "ich will einen Vertrag anlegen", "neuer Vertrag für Netflix", "Vertrag hinzufügen",
    "kannst du einen vertrag für spotify eintragen", "trag mein Fitnessstudio-Abo ein", "neues Abo anlegen", "ich hab einen neuen Handyvertrag",
    "Vertrag erstellen", "Netflix als Abo speichern", "ich brauche einen neuen Vertrag", "mach einen neuen Vertrag fürs Fitnessstudio", "erstelle vertarg"]
    .map((text): [string, string[]] => [text, ["contract_new"]]),
  ...["erstelle sparziel", "ich will für ein Auto sparen", "sparziel anlegen", "neues Ziel: Notgroschen 3000", "kannst du mir ein sparziel einrichten"]
    .map((text): [string, string[]] => [text, ["savings_goal"]]),
  ...["budget prüfen", "check mal mein budget", "budget status", "wie viel budget hab ich noch", "zeig mir mein budget", "hab ich mein budget überzogen"]
    .map((text): [string, string[]] => [text, ["budget", "pulse", "check"]]),
  ...["filter umsätze nach lebensmittel", "nur ausgaben im oktober", "alle zahlungen an spotify", "liste die buchungen vom september"]
    .map((text): [string, string[]] => [text, ["query"]]),
  ...["gehalt anzeigen", "was verdiene ich", "meine letzte abrechnung", "was bekomm ich raus", "mein lohn", "zeig mir mein gehlat"]
    .map((text): [string, string[]] => [text, ["payroll"]]),
];

describe("free phrasings of app actions", () => {
  it.each(variants)("%s", async (message, expected) => {
    const reply = await interpretAssistantMessage({ message, asOf: "2026-11-12", history: [], context: { goals: ["Motorrad"], planned: [] } });
    expect(expected).toContain(reply.tool ?? reply.draft?.action);
  });

  it.each([
    "Was ist ein Budget?",
    "Wie lege ich einen Vertrag an?",
    "Soll ich einen neuen Handyvertrag machen?",
    "Kann man mit 3000 netto in Wien gut leben?",
    "Lohnt sich ein Sparziel für Urlaub?",
    "Ich will keinen neuen Vertrag",
  ])("leaves questions and refusals to the other routes: %s", (message) => {
    expect(intentFrame(message)?.action === "create" ? intentFrame(message) : undefined).toBeUndefined();
  });

  it("keeps the specific rules and only corrects known misreads", () => {
    expect(reconcileIntent("contracts", "zeig mir meine verträge")).toBe("contracts");
    expect(reconcileIntent("expense", "meine letzte abrechnung")).toBe("payroll");
    expect(reconcileIntent("expense", "Amex Abrechnung 300 € im März")).toBe("expense");
    expect(reconcileIntent("briefing", "budget status")).toBe("budget");
    expect(reconcileIntent(undefined, "Wetter morgen")).toBeUndefined();
    expect(detectTool("Geringfügigkeitsgrenze 2026 – wie viel ist das?")).toBeUndefined();
    for (const text of ["Wie viel Pension wurde im März überwiesen?", "Wann wurde der Bonus überwiesen?", "Wie viel Kinderbetreuungsgeld kam letzten Monat?"])
      expect(detectTool(text), text).toBe("query");
  });
});

describe("natural conversation", () => {
  it("asks back with the closest options instead of guessing, and every option is understood", () => {
    const asked = clarifyChoices("was ist mit gehalt und budget")!;
    expect(asked.text).toMatch(/dein Gehalt oder dein Budget/);
    expect(asked.options.map((option) => detectTool(option))).toEqual(["payroll", "payroll", "pulse", "budget"]);
    expect(clarifyChoices("blabla")).toBeUndefined();
  });

  it("answers the questions of a combined message first and starts the new contract or goal last", () => {
    expect(splitQuestion("Leg einen Vertrag für Netflix an und zeig mir mein Budget")).toEqual([
      { text: "zeig mir mein Budget", tool: "budget" }, { text: "Leg einen Vertrag für Netflix an", tool: "contract_new" }]);
    expect(splitQuestion("Neuer Vertrag für Spotify, außerdem: was verdiene ich?")?.map((part) => part.tool)).toEqual(["payroll", "contract_new"]);
    expect(splitQuestion("Leg einen Vertrag an und erstelle ein Sparziel")).toBeUndefined();
    expect(splitQuestion("Lösch Netflix und zeig mir mein Budget")).toBeUndefined();
    expect(splitQuestion("Ich zahle zuerst die Miete und dann den Strom, reicht mein Geld?")).toBeUndefined();
    expect(splitQuestion("Wenn ich mir ein Handy um 600 € kaufe, was bleibt mir danach noch?")).toBeUndefined();
  });
});
