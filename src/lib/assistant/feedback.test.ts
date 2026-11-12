import { describe, expect, it } from "vitest";
import {
  buildFeedbackEntry, FEEDBACK_FORMAT, feedbackEntrySchema, feedbackFile, feedbackSummary, MAX_FEEDBACK_ENTRIES, readFeedbackFile, redactEntry, redactSensitive,
  upsertFeedback, type StoredFeedback,
} from "./feedback";
import { workStatus } from "./status";
import type { AssistantMessage } from "@/lib/types";

const at = Date.UTC(2026, 10, 12, 13, 0);
const thread: AssistantMessage[] = [
  { id: "m1", role: "assistant", text: "Diese Woche ist nichts fällig.", at, source: "Regel", card: { kind: "briefing", title: "Wochenüberblick", lines: [] } },
  { id: "m2", role: "user", text: "Wie viel hab ich im Oktober fürs Essen ausgegeben?", at: at + 1 },
  { id: "m3", role: "assistant", text: "412 € für Lebensmittel.", at: at + 2, agent: "transactions", tool: "query", source: "KI", via: "rule", ms: 1840,
    asked: "Wie viel hab ich im Oktober fürs Essen ausgegeben?", steps: [workStatus.read.text, "Analysiere deine Buchungen…", workStatus.answer.text],
    card: { kind: "answer", title: "Lebensmittel · Oktober", lines: [{ label: "Billa", value: -212.4, detail: "8 Buchungen" }], note: "Nur Ausgaben" },
    suggestions: ["Mehr als im Vormonat?"] },
  { id: "m4", role: "user", text: "Wie hoch ist die Geringfügigkeitsgrenze 2026?", at: at + 3 },
  { id: "m5", role: "assistant", text: "551,10 € im Monat [1].", at: at + 4, agent: "general", tool: "web", source: "KI", asked: "Wie hoch ist die Geringfügigkeitsgrenze 2026?",
    steps: [workStatus.read.text, workStatus.knowledge.text, workStatus.web.text, workStatus.compare.text],
    calls: [{ tool: "knowledge_search", ok: true, summary: "Kein Wissen gefunden" }, { tool: "web", ok: true, summary: "Websuche" }],
    links: [{ title: "oesterreich.gv.at – Geringfügigkeitsgrenze", url: "https://www.oesterreich.gv.at/g" }] },
];

describe("feedback entries", () => {
  it("keep the question, the full answer, who answered how, the steps and the messages before it", () => {
    const entry = buildFeedbackEntry({ id: "fb-00000001", message: thread[2], thread, rating: "dislike", comment: "  Billa fehlt doppelt ",
      page: { route: "/umsaetze", title: "Umsätze" }, asOf: "2026-11-12", client: { viewport: "1440x1000", language: "de-AT", theme: "dark", reducedMotion: false } });
    expect(feedbackEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({
      rating: "dislike", comment: "Billa fehlt doppelt", question: "Wie viel hab ich im Oktober fürs Essen ausgegeben?",
      answer: { text: "412 € für Lebensmittel.", agent: { id: "transactions", label: "Umsätze" }, tool: "query", via: "rule", source: "KI", ms: 1840,
        card: { kind: "answer", title: "Lebensmittel · Oktober", note: "Nur Ausgaben", lines: [{ label: "Billa", value: -212.4, detail: "8 Buchungen" }] },
        suggestions: ["Mehr als im Vormonat?"] },
      steps: ["Lese deine Nachricht…", "Analysiere deine Buchungen…", "Formuliere die Antwort…"],
      retrieval: { knowledgeLayer: { searched: false, titles: [], directAnswer: false }, learnedAnswer: false, webSearch: { used: false, sources: [] }, model: true },
      page: { route: "/umsaetze", title: "Umsätze" }, asOf: "2026-11-12",
    });
    expect(entry.context.map((item) => item.text)).toEqual(["Diese Woche ist nichts fällig.", "Wie viel hab ich im Oktober fürs Essen ausgegeben?"]);
  });

  it("record the knowledge layer and the web search with their sources", () => {
    const entry = buildFeedbackEntry({ id: "fb-00000002", message: thread[4], thread, rating: "like" });
    expect(entry.retrieval).toMatchObject({ knowledgeLayer: { searched: true }, webSearch: { used: true, sources: thread[4].links } });
    expect(entry.answer.calls).toEqual(thread[4].calls);
    expect(feedbackEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry.context).toHaveLength(4);
    expect(feedbackSummary(entry)).toBe("👍 Allgemeiner Chat (Orchestrator) / web: „Wie hoch ist die Geringfügigkeitsgrenze 2026?“");
  });

  it("take the question from the chat when the answer has none, and allow answers without any question", () => {
    const plain: AssistantMessage = { id: "m6", role: "assistant", text: "Hallo!", at: at + 6 };
    expect(buildFeedbackEntry({ id: "fb-00000003", message: plain, thread: [...thread, { id: "u", role: "user", text: "Hi", at: at + 5 }, plain], rating: "like" }).question).toBe("Hi");
    expect(buildFeedbackEntry({ id: "fb-00000004", message: thread[0], thread, rating: "like" }).question).toBeNull();
  });
});

describe("redaction", () => {
  it("removes account and card numbers, contacts, passwords and keys but keeps amounts and dates", () => {
    const text = redactSensitive("IBAN AT61 1904 3002 3457 3201, Karte 4111 1111 1111 1111, SV 1234 010190, Konto 123456789012, max@example.com, " +
      `+43 664 1234567, Passwort: geheim123, token=abc, ${["GOCSPX", "abcdefghijklmnop"].join("-")}, eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlX3ZhbHVl. ` +
      "Am 12.11.2026 waren es 1.234,56 € und 551,10 €.");
    for (const leaked of ["AT61", "4111", "010190", "123456789012", "max@", "664", "geheim123", "abc,", "GOCSPX", "eyJ"]) expect(text, leaked).not.toContain(leaked);
    expect(text).toContain("Am 12.11.2026 waren es 1.234,56 € und 551,10 €.");
    expect(text).toContain("Passwort: [entfernt]");
  });

  it("also catches passwords after „ist:“ or „lautet:“ and grouped local phone numbers", () => {
    expect(redactSensitive("Mein Passwort ist: abc123")).toBe("Mein Passwort ist: [entfernt]");
    expect(redactSensitive("Passwort lautet Sommer2024")).toBe("Passwort lautet [entfernt]");
    for (const phone of ["0664 123 45 67", "030 12345678", "01 234 5678", "0664/1234567"]) expect(redactSensitive(`Ruf ${phone} an`), phone).toBe("Ruf [Telefon entfernt] an");
    expect(redactSensitive("PLZ 1010, 0,50 € je km, 3000 km, 0 Buchungen")).toBe("PLZ 1010, 0,50 € je km, 3000 km, 0 Buchungen");
  });

  it("applies to every text of an entry, links included", () => {
    const entry = redactEntry(buildFeedbackEntry({ id: "fb-00000005", message: { ...thread[2], text: "Überweise an AT61 1904 3002 3457 3201." }, thread, rating: "dislike",
      comment: "Meine Mail ist max@example.com" }));
    expect(entry.answer.text).toBe("Überweise an [IBAN entfernt].");
    expect(redactEntry(buildFeedbackEntry({ id: "0664-123-45-67", message: thread[2], thread, rating: "like" })).id).toBe("0664-123-45-67");
    expect(entry.comment).toBe("Meine Mail ist [E-Mail entfernt]");
  });
});

describe("the feedback file", () => {
  const stored = (id: string, extra: Partial<StoredFeedback> = {}): StoredFeedback => {
    const entry = buildFeedbackEntry({ id, message: thread[2], thread, rating: "dislike" });
    return { ...entry, summary: feedbackSummary(entry), recordedAt: "2026-11-12T13:00:00.000Z", ...extra };
  };

  it("appends entries and completes an entry when its comment follows", () => {
    const first = upsertFeedback([], stored("fb-00000010"));
    const both = upsertFeedback(first, stored("fb-00000011"));
    expect(both.map((entry) => entry.id)).toEqual(["fb-00000010", "fb-00000011"]);
    const commented = upsertFeedback(both, stored("fb-00000010", { comment: "Zu hoch", recordedAt: "2026-11-12T13:05:00.000Z" }));
    expect(commented).toHaveLength(2);
    expect(commented[0]).toMatchObject({ comment: "Zu hoch", recordedAt: "2026-11-12T13:00:00.000Z", updatedAt: "2026-11-12T13:05:00.000Z" });
    expect(commented[0].summary).toContain("Kommentar: „Zu hoch“");
  });

  it("keeps the newest entries within the limit and explains itself for Copilot", () => {
    const many = Array.from({ length: MAX_FEEDBACK_ENTRIES + 3 }, (_, index) => stored(`fb-${String(index).padStart(8, "0")}`))
      .reduce<StoredFeedback[]>((entries, entry) => upsertFeedback(entries, entry), []);
    expect(many).toHaveLength(MAX_FEEDBACK_ENTRIES);
    expect(many[0].id).toBe("fb-00000003");
    const file = feedbackFile(upsertFeedback([], stored("fb-00000020", { comment: "x" })), new Date("2026-11-12T14:00:00Z"));
    expect(file).toMatchObject({ format: FEEDBACK_FORMAT, version: 1, updatedAt: "2026-11-12T14:00:00.000Z", count: { total: 1, like: 0, dislike: 1, withComment: 1 } });
    expect(file.forCopilot.join(" ")).toContain("dislike");
    expect(readFeedbackFile(JSON.parse(JSON.stringify(file)))).toHaveLength(1);
    expect(readFeedbackFile({ entries: [{ id: "x" }] })).toEqual([]);
  });
});
