import { describe, expect, it } from "vitest";
import { detectSmallTalk, smallTalk } from "./smalltalk";

describe("small talk", () => {
  it.each([
    ["Hallo", "greet"], ["hi :)", "greet"], ["Hey du!", "greet"], ["Servus", "greet"], ["Guten Morgen", "greet"], ["moin 👋", "greet"],
    ["Hallo, wie geht's dir?", "mood"], ["wie gehts", "mood"], ["Danke!", "thanks"], ["super danke dir", "thanks"], ["Vielen Dank 🙏", "thanks"],
    ["tschüss", "bye"], ["bis später", "bye"], ["Wer bist du?", "who"], ["ok", "ack"], ["alles klar, passt", "ack"],
    ["???", "unclear"], ["hmm", "unclear"], ["äh", "unclear"], ["asdfgh", "unclear"], ["...", "unclear"], ["Wie viel?", "unclear"],
    ["Na, alles gut?", "mood"], ["Wer hat dich gebaut?", "maker"], ["Danke, das hilft mir", "thanks"], ["ich weiß nicht", "unsure"], ["keine Ahnung", "unsure"],
    ["Wer hat Finanzblick gemacht?", "maker"], ["Mach mal", "unsure"], ["und jetzt?", "unsure"],
    ["Sag mal, bist du eine KI?", "who"], ["Was ist heute für ein Tag?", "date"], ["Erzähl mir einen Witz", "joke"], ["Erzähl mir was Lustiges", "joke"],
  ])("%s → %s", (text, kind) => expect(detectSmallTalk(text)).toBe(kind));

  it("answers the date, jokes and \"bist du eine KI?\" without the model", () => {
    expect(smallTalk("Was ist heute für ein Tag?", { hour: 10, now: new Date("2026-11-11T10:00:00") })?.text).toBe("Heute ist Mittwoch, der 11. November 2026.");
    expect(smallTalk("Erzähl mir einen Witz", { hour: 10, seed: 1 })?.text).toMatch(/Sparschwein/);
    expect(smallTalk("Bist du eine KI?", { hour: 10 })?.text).toMatch(/^Ja, ich bin eine KI/);
    expect(smallTalk("Bist du ein Mensch?", { hour: 10 })?.text).toMatch(/^Nein, ich bin kein Mensch, sondern eine KI/);
    expect(detectSmallTalk("Erzähl mir einen Witz über Katzen")).toBeUndefined();
  });

  it.each(["Hallo, wie viel hab ich im Oktober fürs Essen ausgegeben?", "Hi, kann ich mir im Mai 900 € leisten?", "Was geht alles im Dashboard?",
    "Danke, und jetzt erhöh Japan auf 4000", "morgen 50 € für Pizza", "Hilfe", "was kannst du", "?", "Netflix", "Billa", "Abos", "Wie viel hab ich ausgegeben?",
    "Ich weiß nicht, ob ich mir das leisten kann"])("%s is a real request", (text) =>
    expect(detectSmallTalk(text)).toBeUndefined());

  it("answers greetings by daytime with quick replies", () => {
    expect(smallTalk("Hallo", { hour: 8 })).toMatchObject({ text: expect.stringMatching(/^Guten Morgen!/), suggestions: expect.any(Array) });
    expect(smallTalk("hi", { hour: 20 })?.text).toMatch(/^Guten Abend!/);
    expect(smallTalk("danke", { hour: 12 })?.text).toMatch(/gern/i);
    expect(smallTalk("Wie viel hab ich ausgegeben?", { hour: 12 })).toBeUndefined();
    expect(smallTalk("???", { hour: 12 })).toMatchObject({ text: expect.stringMatching(/\?$/), suggestions: expect.any(Array) });
    const now = new Date("2026-11-11T12:00:00Z");
    expect(smallTalk("Wie spät ist es in Tokio?", { hour: 13, now })?.text).toBe("In Tokio ist es gerade 21:00 Uhr.");
    expect(smallTalk("wie viel uhr ist es in new york", { hour: 13, now })?.text).toBe("In New York ist es gerade 07:00 Uhr.");
    expect(smallTalk("Wie spät ist es in Atlantis?", { hour: 13, now })?.text).toMatch(/^Die genaue Uhrzeit in Atlantis kenne ich nicht/);
  });
});
