import { describe, expect, it } from "vitest";
import { fixedReply } from "./fixed-replies";
import { routeByRules } from "./orchestrator";
import { offTopic, offTopicReply } from "./scope";
import { detectTool } from "./tools";

describe("finance-only scope", () => {
  it.each([
    ["Kannst du mir einen guten Film empfehlen?", "media"], ["Gib mir einen Buchtipp", "media"], ["Welche Serie soll ich schauen?", "media"],
    ["Wie wird das Wetter morgen?", "weather"], ["Regnet es heute?", "weather"], ["Wie mache ich Palatschinken?", "food"],
    ["Gib mir ein einfaches Rezept für Pfannkuchen", "food"], ["Was soll ich heute kochen?", "food"], ["Was ist die Hauptstadt von Australien?", "facts"],
    ["Wie hoch ist der Großglockner?", "facts"], ["Wer hat die Relativitätstheorie entwickelt?", "facts"], ["Wann wurde der Stephansdom gebaut?", "facts"],
    ["Wo liegt Kärnten?", "facts"], ["Erzähl mir einen Witz", "creative"], ["Erzähl mir einen Witz über Banken", "creative"],
    ["Schreib mir ein Gedicht über Sparen", "creative"], ["Erzähl mir was Lustiges", "creative"], ["Wie spät ist es in Tokio?", "time"],
    ["Was ist heute für ein Tag?", "time"], ["Wer gewinnt die Bundesliga?", "other"], ["Was ist der Sinn des Lebens?", "other"],
    ["Was ist dein Lieblingsessen?", "other"], ["Kannst du mir Spanisch beibringen?", "other"], ["Wann spielt Rapid Wien?", "other"], ["Erklär mir Quantenphysik", "facts"], ["Wie schreibe ich einen Lebenslauf?", "other"], ["Kannst du mir bei einer E-Mail an meinen Vermieter helfen?", "other"],
  ])("turns away %s (%s)", (text, topic) => {
    expect(offTopic(text)).toBe(topic);
    expect(fixedReply(text)?.text, text).toMatch(/ich bin nur für deine Finanzen und die App da/);
    expect(routeByRules(text, [])).toEqual({ agent: "general", via: "rule" });
  });

  it.each([
    "Was hältst du von Bitcoin?", "Wie viel hab ich fürs Kino ausgegeben?", "Was kostet mich Netflix im Jahr?", "Wie hoch ist mein Gehalt?",
    "Wie hoch ist die Inflation?", "Wie hoch ist der Leitzins?", "Wo liegt mein Geld?", "Was ist ein ETF?", "Lohnt sich ein Bausparvertrag?",
    "Ich bin gestresst wegen Geld", "Wann war ich zuletzt bei Billa?", "Kündige Netflix", "Hallo", "Wer bist du?", "Was kannst du?",
    "Kann man mit 3000 netto in Wien gut leben?", "Wie viel hab ich für Bücher ausgegeben?", "Öffne die Verträge", "Netflix",
    "Wie viel gebe ich für Musik-Streaming aus?", "Ich will ins Kino, geht sich das diesen Monat noch aus?",
    "Wie hoch ist die Geringfügigkeitsgrenze 2026?", "Wie hoch ist die Pendlerpauschale?", "Wie hoch ist der Familienbonus Plus?",
])("keeps %s", (text) => expect(offTopic(text)).toBeUndefined());

  it("points back to the finances with suggestions", () => {
    expect(offTopicReply("Wie wird das Wetter morgen?")).toMatchObject({ suggestions: expect.arrayContaining(["Welche Abos habe ich?"]) });
    expect(detectTool("Wie hoch ist der Großglockner?")).toBeUndefined();
  });
});
