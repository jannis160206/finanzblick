import { describe, expect, it } from "vitest";
import { asksForWebSearch, unsureAnswer, wantsWebSearch } from "./orchestrator";
import {
  avoidedSources, correctionNotes, correctsAnswer, helpedReply, learnedCandidates, learnWebAnswer, noteWebAnswer, questionOverlap, rateStoredAnswer, recallConfirmed,
  rejectWebAnswer, rememberAnswer, searchesAgain, webEntryId,
} from "./web-learning";
import { storableAnswer, volatility } from "./answer-memory";
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

describe("keeping answers as local knowledge", () => {
  const now = Date.UTC(2026, 10, 14, 12);
  const day = 24 * 60 * 60 * 1000;
  const etf = { id: "e", kind: "answer" as const, question: "Was ist der Unterschied zwischen ETF und Aktienfonds?",
    text: "Ein ETF bildet einen Index nach und wird an der Börse gehandelt; ein Aktienfonds wird aktiv gemanagt und kostet meist mehr.", now };

  it("keeps a general answer at once and answers the same question locally, but not a related one", () => {
    const { entries, id } = rememberAnswer([], etf);
    expect(id).toBe("e");
    expect(entries[0]).toMatchObject({ kind: "answer", votes: 0, source: "Chat-Antwort", question: etf.question });
    expect(entries[0]).not.toHaveProperty("url");
    expect(entries[0]).not.toHaveProperty("expiresAt");
    expect(assistantKnowledgeSchema.safeParse(entries[0]).success).toBe(true);
    expect(learnedCandidates(entries, 60, now)).toEqual([expect.objectContaining({ id: "e", votes: 0 })]);
    expect(recallConfirmed(entries, "Unterschied zwischen ETF und Aktienfonds?", now)?.id).toBe("e");
    expect(recallConfirmed(entries, "Was ist der Unterschied zwischen ETF und Sparbuch?", now)).toBeUndefined();
    // The same question again refreshes the text instead of adding a second entry.
    const again = rememberAnswer(entries, { ...etf, id: "f", text: `${etf.text} Beide sind Sondervermögen.` });
    expect(again.id).toBe("e");
    expect(again.entries).toHaveLength(1);
  });

  it("keeps nothing personal, sensitive or unsure", () => {
    expect(rememberAnswer([], { ...etf, question: "Wie viel habe ich im Oktober für Essen ausgegeben?" }).entries).toEqual([]);
    expect(storableAnswer("Wohin ging die Überweisung an AT61 1904 3002 3457 3201?", "Das war eine Überweisung an einen Händler.")).toBe(false);
    expect(storableAnswer("Wie erreiche ich die Arbeiterkammer?", "Schreib an service@example.com oder ruf an.")).toBe(false);
    expect(storableAnswer("Wie hoch ist die Grundsteuer in Graz?", "Das weiß ich leider nicht genau.")).toBe(false);
    expect(storableAnswer(etf.question, etf.text)).toBe(true);
  });

  it("lets changing facts expire and never keeps today's values, news or quotes", () => {
    expect(volatility("Wie hoch ist der Leitzins der EZB?", "Der Einlagesatz liegt bei 2 %.", now)).toEqual({ kind: "expires", reason: "Zinsen ändern sich", expiresAt: now + 7 * day });
    expect(volatility("Wie hoch ist die Pendlerpauschale?", "Ab 20 km sind es 58 € im Monat.", now)).toMatchObject({ kind: "expires", expiresAt: Date.UTC(2026, 11, 31, 23, 59, 59) });
    expect(volatility("Was ist die Geringfügigkeitsgrenze?", "Sie liegt 2027 bei 600 € im Monat.", now)).toMatchObject({ expiresAt: Date.UTC(2027, 11, 31, 23, 59, 59) });
    expect(volatility("Wie hoch ist die Pendlerpauschale 2026?", "Ab 20 km sind es 58 € im Monat.", now)).toEqual({ kind: "never", reason: "Aktueller Wert" });
    expect(volatility("Wie hoch ist der Leitzins aktuell?", "2 %.", now)).toEqual({ kind: "never", reason: "Aktueller Wert" });
    expect(volatility("Wie steht der Bitcoin-Kurs heute?", "Rund 90.000 €.", now)).toEqual({ kind: "never", reason: "Kurse" });
    expect(volatility("Was gibt es Neues in den Nachrichten zur Wirtschaft?", "Die Inflation ist gesunken.", now)).toEqual({ kind: "never", reason: "Nachrichten" });
    expect(volatility("Was ist ein Wechselkurs?", "Der Preis einer Währung in einer anderen Währung.", now)).toEqual({ kind: "stable" });
    expect(volatility(etf.question, etf.text, now)).toEqual({ kind: "stable" });

    const rate = rememberAnswer([], { id: "z", kind: "web", question: "Wie hoch ist der Leitzins der EZB?", text: "Der Einlagesatz der EZB liegt bei 2 % [1].", links, now });
    expect(rate.entries[0]).toMatchObject({ kind: "web", expiresAt: now + 7 * day, url: links[0].url });
    expect(learnedCandidates(rate.entries, 60, now + 8 * day)).toEqual([]);
    expect(recallConfirmed(rate.entries, "Wie hoch ist der Leitzins der EZB?", now + 8 * day)).toBeUndefined();
    expect(relevantKnowledge(rate.entries, "Leitzins EZB", 2, now + 8 * day)).toEqual([]);
    expect(rememberAnswer(rate.entries, { ...etf, now: now + 8 * day }).entries.map((entry) => entry.id)).toEqual(["e"]);
    expect(rememberAnswer([], { id: "n", kind: "web", question: "Wie steht der DAX heute?", text: "Der DAX steht bei 19.000 Punkten.", now }).entries).toEqual([]);
  });

  it("moves a stored answer up with 👍, rejects it with 👎 and does not overwrite a rejected one silently", () => {
    const { entries } = rememberAnswer([], etf);
    const liked = rateStoredAnswer(entries, "e", "up");
    expect(liked[0]).toMatchObject({ votes: 1, kind: "answer" });
    expect(learnWebAnswer(liked, { id: "x", question: etf.question, text: etf.text, target: "e" })[0]).toMatchObject({ kind: "answer", votes: 2, source: "Chat-Antwort" });
    const disliked = rateStoredAnswer(liked, "e", "down");
    expect(disliked[0]).toMatchObject({ rejected: true, votes: -1 });
    expect(learnedCandidates(disliked, 60, now)).toEqual([]);
    expect(rememberAnswer(disliked, { ...etf, id: "g" })).toEqual({ entries: disliked });
    expect(rateStoredAnswer(disliked, "e", "up")[0]).not.toHaveProperty("rejected");
  });
});
