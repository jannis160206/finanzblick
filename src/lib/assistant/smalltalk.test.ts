import { describe, expect, it } from "vitest";
import { detectSmallTalk, smallTalk } from "./smalltalk";

describe("small talk", () => {
  it.each([
    ["Hallo", "greet"], ["hi :)", "greet"], ["Hey du!", "greet"], ["Servus", "greet"], ["Guten Morgen", "greet"], ["moin 👋", "greet"],
    ["Hallo, wie geht's dir?", "mood"], ["wie gehts", "mood"], ["Danke!", "thanks"], ["super danke dir", "thanks"], ["Vielen Dank 🙏", "thanks"],
    ["tschüss", "bye"], ["bis später", "bye"], ["Wer bist du?", "who"], ["ok", "ack"], ["alles klar, passt", "ack"],
    ["???", "unclear"], ["hmm", "unclear"], ["äh", "unclear"], ["asdfgh", "unclear"], ["...", "unclear"], ["Wie viel?", "unclear"],
    ["Na, alles gut?", "mood"], ["Hey, wie war dein Tag so?", "mood"], ["Was machst du gerade?", "mood"], ["Wer hat dich gebaut?", "maker"], ["Danke, das hilft mir", "thanks"], ["ich weiß nicht", "unsure"], ["keine Ahnung", "unsure"],
    ["Wer hat Finanzblick gemacht?", "maker"], ["Mach mal", "unsure"], ["und jetzt?", "unsure"],
    ["Sag mal, bist du eine KI?", "who"],
  ])("%s → %s", (text, kind) => expect(detectSmallTalk(text)).toBe(kind));

  it("answers \"bist du eine KI?\" and leaves jokes, the date and the clock to the scope gate", () => {
    expect(smallTalk("Bist du eine KI?", { hour: 10 })?.text).toMatch(/^Ja, ich bin eine KI/);
    expect(smallTalk("Bist du ein Mensch?", { hour: 10 })?.text).toMatch(/^Nein, ich bin kein Mensch, sondern eine KI/);
    for (const text of ["Erzähl mir einen Witz", "Was ist heute für ein Tag?", "Wie spät ist es in Tokio?"]) expect(detectSmallTalk(text), text).toBeUndefined();
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
  });
});
