import { describe, expect, it } from "vitest";
import { conversationalQuestion, conversationRoute, evidenceText, isQuestion } from "./conversation";

const route = (text: string, tool?: Parameters<typeof conversationRoute>[0]["tool"], extra: Partial<Parameters<typeof conversationRoute>[0]> = {}) =>
  conversationRoute({ text, tool, ruleTool: undefined, numbers: [], pending: false, ...extra });

describe("conversation routing", () => {
  it("recognises explanations, advice, opinions and worries in any phrasing", () => {
    for (const text of ["Wieso ist Revolut auf 0?", "sollte ich den notgroschen erhöhen", "Lohnt sich das Tagesgeld?", "was denkst du über meine ausgaben",
      "Was soll ich als nächstes tun?", "gib mir tipps", "Fass meinen Monat zusammen", "bin gestresst wegen geld", "Sind meine Abos zu teuer?",
      "bin ich eigentlich sparsam", "was passiert wenn ich netflix kündige", "wie kann ich mehr sparen"]) expect(conversationalQuestion(text), text).toBe(true);
    for (const text of ["meine kontostände", "Erhöhe Japan auf 4.000 €", "Lieferando ist immer Essen"]) expect(conversationalQuestion(text), text).toBe(false);
    expect(isQuestion("Kommt noch was Großes")).toBe(true);
    expect(isQuestion("Mach Japan 4000")).toBe(false);
  });

  it("never edits or opens a form for a question", () => {
    expect(route("Wieso ist Revolut auf 0?", "edit")).toEqual({ converse: true, skipDraft: true });
    expect(route("Sollte ich den Notgroschen erhöhen?", "edit")).toEqual({ converse: true, skipDraft: true });
    expect(route("Wann bin ich pleite?", undefined, { draftAction: "affordability" })).toEqual({ converse: true, skipDraft: true });
    expect(route("Wie viel zahl ich im Jahr für Versicherungen?", undefined, { draftAction: "expense", ruleTool: "expense" })).toEqual({ converse: true, skipDraft: true });
    expect(route("Neuer Laptop um 1200 im März", undefined, { draftAction: "expense", ruleTool: "expense", numbers: [1200] })).toEqual({ converse: false, skipDraft: false });
    // Real commands still go through.
    expect(route("Erhöhe Japan auf 4.000 €", "edit", { ruleTool: "edit", numbers: [4000] })).toEqual({ tool: "edit", converse: false, skipDraft: false });
    expect(route("Ist ein 900 € Fernseher drin?", undefined, { draftAction: "affordability", numbers: [900] })).toEqual({ converse: false, skipDraft: false });
    expect(route("sollte ich japan erhöhen", "edit", { pending: true })).toEqual({ tool: "edit", converse: false, skipDraft: false });
  });

  it("lets the model answer in its own words when the tool was only a guess or advice is wanted", () => {
    expect(route("meine kontostände", "accounts", { ruleTool: "accounts" })).toEqual({ tool: "accounts", converse: false, skipDraft: false });
    expect(route("wo ist mein ganzes geld hin", "query")).toEqual({ tool: "query", converse: true, skipDraft: false });
    expect(route("Bin ich sparsam?", "check", { ruleTool: "check" })).toMatchObject({ tool: "check", converse: true });
  });

  it("answers fact questions from the facts instead of a booking search", () => {
    for (const text of ["Hab ich irgendwas doppelt bezahlt?", "Wofür geb ich am meisten aus", "Was ist meine teuerste Kategorie?", "Wie viel hab ich seit Jahresbeginn gespart?", "Ist Netflix teurer geworden?"])
      expect(route(text, "query", { ruleTool: "query" }), text).toEqual({ converse: true, skipDraft: true });
    expect(route("Was war meine größte Ausgabe diesen Monat?", "query", { ruleTool: "query" })).toEqual({ tool: "query", converse: false, skipDraft: false });
  });

  it("turns a tool result into quotable evidence", () => {
    const text = evidenceText({ text: "Noch fällig:", card: { kind: "answer", title: "Fixkosten", total: 514.95, lines: [{ label: "Miete", value: 450, detail: "am 1." }], note: "Stand heute" } });
    expect(text).toContain("Fixkosten: 514,95");
    expect(text).toContain("Miete: 450,00");
    expect(text).toContain("(am 1.)");
    expect(evidenceText({ text: "x".repeat(2000) }, 100)).toHaveLength(100);
  });
});
