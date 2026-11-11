import { describe, expect, it } from "vitest";
import { conversationalQuestion, conversationRoute, converseOn, evidenceText, freshPart, isQuestion } from "./conversation";

const route = (text: string, tool?: Parameters<typeof conversationRoute>[0]["tool"], extra: Partial<Parameters<typeof conversationRoute>[0]> = {}) =>
  conversationRoute({ text, tool, ruleTool: undefined, numbers: [], pending: false, ...extra });

describe("copied answers", () => {
  it("drops sentences that repeat the previous answer", () => {
    const film = "„Der kleine Prinz“ ist immer eine gute Wahl. „Ziemlich beste Freunde“ ist perfekt für Lachtränen.";
    expect(freshPart(film, film)).toBe("");
    expect(freshPart("„Der kleine Prinz“ ist super, eine gute Wahl. Pfannkuchen macht man aus Mehl, Milch und Eiern.", film))
      .toBe("Pfannkuchen macht man aus Mehl, Milch und Eiern.");
    expect(freshPart("Lies „Der Alchimist“ von Paulo Coelho, eine schöne Geschichte über Träume.", film)).toBe("Lies „Der Alchimist“ von Paulo Coelho, eine schöne Geschichte über Träume.");
    expect(freshPart("Klar.", undefined)).toBe("Klar.");
  });
});

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
    for (const text of ["Hab ich irgendwas doppelt bezahlt?", "Ist Netflix teurer geworden?"])
      expect(route(text, "query", { ruleTool: "query" }), text).toEqual({ converse: true, skipDraft: true });
    // Category superlatives and savings since January are the query tool's own answers.
    for (const text of ["Wofür geb ich am meisten aus", "Was ist meine teuerste Kategorie?", "Wie viel hab ich seit Jahresbeginn gespart?", "Was war meine größte Ausgabe diesen Monat?"])
      expect(route(text, "query", { ruleTool: "query" }), text).toEqual({ tool: "query", converse: false, skipDraft: false });
  });

  it("keeps the tool's own words for empty results and finished summaries", () => {
    const empty = { text: "Im Oktober finde ich keine passenden Ausgaben.", card: { kind: "answer" as const, title: "Essen", total: 0, lines: [] } };
    const filled = { text: "92,40 €", card: { kind: "answer" as const, title: "Essen", total: -92.4, lines: [{ label: "Billa", value: -92.4 }] } };
    expect(converseOn("query", empty, "wo geht mein ganzes geld hin")).toBe(false);
    expect(converseOn("why", { text: "Keine Buchung gefunden." }, "Warum ist Billa Lebensmittel?")).toBe(false);
    expect(converseOn("query", filled, "wo geht mein ganzes geld hin")).toBe(true);
    expect(converseOn("briefing", filled, "Gib mir den Wochenüberblick")).toBe(false);
    expect(converseOn("payroll", filled, "Warum zahle ich so viel Lohnsteuer?")).toBe(false);
    expect(converseOn("check", filled, "Sollte ich mehr sparen?")).toBe(true);
    expect(converseOn("knowledge", { text: "Ein ETF ist ein börsengehandelter Fonds." }, "Erklär mir ETFs")).toBe(true);
    expect(converseOn("why", filled, "Warum ist Billa Lebensmittel?")).toBe(false);
    // A summary the model only guessed for a "Warum …?" question still gets put into words.
    expect(converseOn("insights", filled, "Warum hab ich am Monatsende so wenig Geld?", true)).toBe(true);
  });

  it("turns a tool result into quotable evidence", () => {
    const text = evidenceText({ text: "Noch fällig:", card: { kind: "answer", title: "Fixkosten", total: 514.95, lines: [{ label: "Miete", value: 450, detail: "am 1." }], note: "Stand heute" } });
    expect(text).toContain("Fixkosten: 514,95");
    expect(text).toContain("Miete: 450,00");
    expect(text).toContain("(am 1.)");
    expect(evidenceText({ text: "x".repeat(2000) }, 100)).toHaveLength(100);
  });
});
