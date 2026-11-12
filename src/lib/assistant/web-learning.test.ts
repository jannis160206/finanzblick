import { describe, expect, it } from "vitest";
import { asksForWebSearch, unsureAnswer, wantsWebSearch } from "./orchestrator";
import {
  avoidedSources, correctionNotes, correctsAnswer, helpedReply, learnedCandidates, learnWebAnswer, noteWebAnswer, questionOverlap, recallConfirmed, rejectWebAnswer,
  searchesAgain, webEntryId,
} from "./web-learning";
import { findKnowledge, relevantKnowledge } from "./knowledge";
import { assistantKnowledgeSchema } from "@/lib/types";

const links = [{ title: "oesterreich.gv.at – Pendlerpauschale", url: "https://www.oesterreich.gv.at/pendler" }, { title: "AK", url: "https://www.arbeiterkammer.at/pendler" }];
const answer = (id: string, question = "Wie hoch ist die Pendlerpauschale 2026?") =>
  ({ id, question, text: "Das kleine Pendlerpauschale beträgt ab 20 km 58 € im Monat [1].", links, now: 1_000 });

describe("deciding on the web search", () => {
  it.each([
    "Wie hoch ist die Pendlerpauschale 2026?",
    "Was ist die Geringfügigkeitsgrenze 2026?",
    "Gibt es heuer einen Klimabonus?",
    "Welche Förderungen gibt es für eine Photovoltaikanlage?",
    "google mal den Mindestlohn in Österreich",
  ])("searches for yearly figures, legal rules and explicit requests: %s", (question) => {
    expect(wantsWebSearch(question)).toBe(true);
  });

  it.each([
    "Wie viel habe ich im Oktober ausgegeben?",
    "Wie wird das Wetter morgen?",
    "Schreib mir ein Gedicht über die Pendlerpauschale",
    "Zeig mir mein Budget",
    "Warum sind meine Ausgaben heuer so hoch?",
    "Wie kann ich heuer mein Geld besser einteilen?",
  ])("never searches for own data, small talk or other topics: %s", (question) => {
    expect(wantsWebSearch(question)).toBe(false);
  });

  it("leaves app tools and confidently known questions alone, unless a current figure is asked", () => {
    expect(wantsWebSearch("Wie hoch ist der Familienbonus Plus?", { tool: "payroll" })).toBe(false);
    expect(wantsWebSearch("Wie hoch ist der Familienbonus Plus?", { confident: true })).toBe(false);
    expect(wantsWebSearch("Wie hoch ist der Familienbonus Plus 2026?", { confident: true })).toBe(true);
    expect(asksForWebSearch("Such im Internet nach der KESt auf Zinsen")).toBe(true);
    expect(asksForWebSearch("Such mir meine Verträge")).toBe(false);
  });

  it("notices answers that admit not knowing", () => {
    expect(unsureAnswer("Dazu habe ich leider keine aktuellen Informationen.")).toBe(true);
    expect(unsureAnswer(undefined)).toBe(true);
    expect(unsureAnswer("Der Pendlereuro beträgt ab 2026 6 € pro Kilometer.")).toBe(false);
  });
});

describe("learning from feedback", () => {
  it("stores a confirmed web answer once and counts further confirmations", () => {
    const first = learnWebAnswer([], answer("a"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "web", votes: 1, url: links[0].url, source: "Websuche · oesterreich.gv.at, arbeiterkammer.at" });
    expect(assistantKnowledgeSchema.safeParse(first[0]).success).toBe(true);
    const again = learnWebAnswer(first, answer("b", "Pendlerpauschale 2026 wie hoch?"));
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ id: "a", votes: 2 });
    expect(learnedCandidates(again)).toEqual([expect.objectContaining({ id: "a", votes: 2, question: "Wie hoch ist die Pendlerpauschale 2026?" })]);
  });

  it("rejects an answer, skips its sources next time and keeps the correction as a hint", () => {
    const rejected = rejectWebAnswer(learnWebAnswer([], answer("a")), answer("b"));
    expect(rejected[0]).toMatchObject({ rejected: true, votes: -1 });
    expect(learnedCandidates(rejected)).toEqual([]);
    expect(relevantKnowledge(rejected, "Pendlerpauschale 2026")).toEqual([]);
    expect(avoidedSources(rejected, "Wie hoch ist die Pendlerpauschale heuer 2026?")).toEqual(links.map((link) => link.url));
    const noted = noteWebAnswer(rejected, { question: "Wie hoch ist die Pendlerpauschale 2026?" }, "Das große Pendlerpauschale fehlt.");
    expect(correctionNotes(noted, "Pendlerpauschale 2026 bitte")).toEqual(["Das große Pendlerpauschale fehlt."]);
    expect(assistantKnowledgeSchema.safeParse(noted[0]).success).toBe(true);
  });

  it("recognises the same question in other words, but not a related or personal one", () => {
    const entries = learnWebAnswer([], answer("a", "Wie hoch ist die Geringfügigkeitsgrenze 2026?"));
    expect(recallConfirmed(entries, "Geringfügigkeitsgrenze 2026 – wie viel ist das?")?.id).toBe("a");
    expect(recallConfirmed(entries, "Darf ich neben der Karenz geringfügig arbeiten?")).toBeUndefined();
    const short = learnWebAnswer(learnWebAnswer([], answer("k", "Wie hoch ist die KESt?")), answer("p", "Wie hoch ist die Pendlerpauschale 2026?"));
    expect(recallConfirmed(short, "Wie hoch war meine KESt im Oktober?")).toBeUndefined();
    expect(recallConfirmed(short, "Wie hoch ist die Pendlerpauschale 2026 laut Lohnzettel?")).toBeUndefined();
    expect(recallConfirmed(rejectWebAnswer(entries, answer("b", "Wie hoch ist die Geringfügigkeitsgrenze 2026?")), "Geringfügigkeitsgrenze 2026")).toBeUndefined();
  });

  it("sends feedback on a recalled answer to exactly the entry it came from", () => {
    const entries = learnWebAnswer([], answer("a", "Wie viel Notgroschen brauche ich?"));
    const recalled = { id: "new", question: "Wie groß sollte meine Reserve für Notfälle sein?", text: entries[0].text, links, target: "a" };
    expect(webEntryId(entries, recalled)).toBe("a");
    const rejected = rejectWebAnswer(entries, recalled);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ id: "a", rejected: true, question: "Wie viel Notgroschen brauche ich?" });
    expect(noteWebAnswer(rejected, { question: recalled.question, target: "a" }, "Sechs Monate sind besser.")[0].note).toBe("Sechs Monate sind besser.");
    expect(learnWebAnswer(entries, recalled)[0]).toMatchObject({ id: "a", votes: 2, question: "Wie viel Notgroschen brauche ich?" });
  });

  it("takes only real corrections as a note and only topic-free requests as a new search", () => {
    const question = "Wie hoch ist die Geringfügigkeitsgrenze 2026?";
    for (const text of ["Die Angabe ist veraltet", "Das gilt so nicht in Österreich", "Die Geringfügigkeitsgrenze 2026 liegt bei 551,10 €"])
      expect(correctsAnswer(text, question), text).toBe(true);
    for (const text of ["Wie hoch ist die Familienbeihilfe 2026", "Und was ist mit dem Klimabonus", "Danke", "Zeig mir mein Budget"])
      expect(correctsAnswer(text, question), text).toBe(false);
    expect(searchesAgain("Such im Internet nochmal danach")).toBe(true);
    expect(searchesAgain("Such im Internet nach Neuem dazu")).toBe(true);
    expect(searchesAgain("Such im Internet nach der neuen Geringfügigkeitsgrenze")).toBe(false);
    expect(searchesAgain("Google mal, was es dazu beim Familienbonus gibt")).toBe(false);
  });

  it("keeps web answers out of the encyclopedia lookup", () => {
    expect(findKnowledge(learnWebAnswer([], answer("a")), "Pendlerpauschale")).toBeUndefined();
  });

  it("understands thanks after a web answer as confirmation, not new questions", () => {
    for (const text of ["Das hat geholfen", "Danke, das hat mir sehr geholfen!", "Super, danke", "hilft mir weiter"]) expect(helpedReply(text), text).toBe(true);
    for (const text of ["Hat mir nicht geholfen", "Danke, und wie hoch ist der Pendlereuro?", "Hat das geholfen?"]) expect(helpedReply(text), text).toBe(false);
    expect(questionOverlap("Wie hoch ist die Pendlerpauschale 2026?", "Pendlerpauschale 2026")).toBe(1);
  });
});
