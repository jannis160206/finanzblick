import { describe, expect, it } from "vitest";
import { detectSmallTalk, smallTalk } from "./smalltalk";

describe("small talk", () => {
  it.each([
    ["Hallo", "greet"], ["hi :)", "greet"], ["Hey du!", "greet"], ["Servus", "greet"], ["Guten Morgen", "greet"], ["moin 👋", "greet"],
    ["Hallo, wie geht's dir?", "mood"], ["wie gehts", "mood"], ["Danke!", "thanks"], ["super danke dir", "thanks"], ["Vielen Dank 🙏", "thanks"],
    ["tschüss", "bye"], ["bis später", "bye"], ["Wer bist du?", "who"], ["ok", "ack"], ["alles klar, passt", "ack"],
  ])("%s → %s", (text, kind) => expect(detectSmallTalk(text)).toBe(kind));

  it.each(["Hallo, wie viel hab ich im Oktober fürs Essen ausgegeben?", "Hi, kann ich mir im Mai 900 € leisten?", "Was geht alles im Dashboard?",
    "Danke, und jetzt erhöh Japan auf 4000", "morgen 50 € für Pizza", "Hilfe", "was kannst du"])("%s is a real request", (text) =>
    expect(detectSmallTalk(text)).toBeUndefined());

  it("answers greetings by daytime with quick replies", () => {
    expect(smallTalk("Hallo", { hour: 8 })).toMatchObject({ text: expect.stringMatching(/^Guten Morgen!/), suggestions: expect.any(Array) });
    expect(smallTalk("hi", { hour: 20 })?.text).toMatch(/^Guten Abend!/);
    expect(smallTalk("danke", { hour: 12 })?.text).toMatch(/gern/i);
    expect(smallTalk("Wie viel hab ich ausgegeben?", { hour: 12 })).toBeUndefined();
  });
});
