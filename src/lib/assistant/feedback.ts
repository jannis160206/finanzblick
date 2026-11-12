import { z } from "zod";
import { agentLabel, type AgentId } from "./orchestrator";
import { workStatus } from "./status";
import type { AssistantMessage } from "@/lib/types";

/**
 * Feedback on assistant answers (👍/👎 with an optional comment), collected in one JSON file so it can be handed to
 * Copilot to find and fix problems. Every entry carries the question, the full answer, who answered and how, the
 * work steps, the knowledge and web sources and the last few chat messages. Secrets and account numbers are removed.
 */

export const FEEDBACK_FORMAT = "finanzblick-assistant-feedback";
export const MAX_FEEDBACK_ENTRIES = 1000;

const text = (max: number) => z.string().max(max);
const httpsUrl = z.string().max(500).regex(/^https:\/\/[^\s"<>]+$/);

export const feedbackEntrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  messageId: text(100).min(1),
  rating: z.enum(["like", "dislike"]),
  comment: text(2000).optional(),
  question: text(1000).nullable(),
  answer: z.object({
    text: text(4000),
    at: text(40),
    agent: z.object({ id: text(20), label: text(60) }).strict(),
    via: text(20).optional(),
    tool: text(40).optional(),
    source: z.enum(["KI", "Regel"]).optional(),
    ms: z.number().int().nonnegative().max(3_600_000).optional(),
    card: z.object({
      kind: text(40), title: text(200), note: text(400).optional(),
      lines: z.array(z.object({ label: text(200), value: z.number().finite().optional(), detail: text(300).optional() }).strict()).max(12),
    }).strict().optional(),
    suggestions: z.array(text(120)).max(4).optional(),
    pendingChange: text(200).optional(),
    draft: z.object({ action: text(40), missing: text(40).optional() }).strict().optional(),
    status: text(20).optional(),
    calls: z.array(z.object({ tool: text(40), ok: z.boolean(), summary: text(80) }).strict()).max(8).optional(),
  }).strict(),
  steps: z.array(text(80)).max(12),
  retrieval: z.object({
    knowledgeLayer: z.object({ searched: z.boolean(), titles: z.array(text(80)).max(5), directAnswer: z.boolean() }).strict(),
    learnedAnswer: z.boolean(),
    webSearch: z.object({ used: z.boolean(), sources: z.array(z.object({ title: text(120), url: httpsUrl }).strict()).max(4) }).strict(),
    marketData: z.boolean(),
    model: z.boolean(),
  }).strict(),
  context: z.array(z.object({ role: z.enum(["user", "assistant"]), text: text(600), agent: text(20).optional(), tool: text(40).optional() }).strict()).max(4),
  page: z.object({ route: text(200), title: text(80).optional() }).strict().optional(),
  asOf: text(10).optional(),
  client: z.object({ viewport: text(20), language: text(20).optional(), theme: text(10).optional(), reducedMotion: z.boolean().optional() }).strict().optional(),
}).strict();
export type FeedbackEntry = z.infer<typeof feedbackEntrySchema>;

/** What the server adds: when it was stored, the account (account mode only) and the AI setup at that moment. */
export type StoredFeedback = FeedbackEntry & {
  summary: string;
  recordedAt: string;
  updatedAt?: string;
  account?: string;
  app?: { nodeEnv?: string; aiEnabled: boolean; model?: string; embeddingModel?: string; webSearch: boolean };
};

export type FeedbackFile = {
  format: typeof FEEDBACK_FORMAT;
  version: 1;
  about: string;
  forCopilot: string[];
  fields: Record<string, string>;
  privacy: string;
  updatedAt: string;
  count: { total: number; like: number; dislike: number; withComment: number };
  entries: StoredFeedback[];
};

// Account and card numbers, contact details, passwords and keys never go into the file.
type Replacement = string | ((match: string, ...groups: string[]) => string);
const redactions: [RegExp, Replacement][] = [
  [/\b(passw(?:ort|ord)|kennwort|pin|tan|token|api[ -]?key|secret|geheimnis|zugangscode|session)\b(\s*(?:(?:ist|lautet|is|war)\s*[:=]?|[:=]))\s*\S+/gi,
    (_match, key, separator) => `${key}${separator.trimEnd()} [entfernt]`],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g, "[Schlüssel entfernt]"],
  [/\b(?:GOCSPX|sk|pk|ghp|gho|github_pat|xox[bp])[-_][\w-]{10,}\b/g, "[Schlüssel entfernt]"],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, "[Schlüssel entfernt]"],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, "[IBAN entfernt]"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[E-Mail entfernt]"],
  [/\b(?:\d{4}[ -]?){3}\d{1,7}\b|(?:\*+|\bx{4,}|\bX{4,}) ?\d{4}\b/g, "[Kartennummer entfernt]"],
  [/(?:\+|\b00)\d[\d /-]{7,}\d|\b0\d{3}[ /-]?\d{6,8}\b/g, "[Telefon entfernt]"],
  // Grouped local numbers ("0664 123 45 67", "01 234 5678"); at least eight digits, so short numbers stay.
  [/\b0\d{1,4}(?:[ /-]?\d{2,4}){2,4}\b/g, (match) => match.replace(/\D/g, "").length >= 8 ? "[Telefon entfernt]" : match],
  // Social security numbers ("1234 010190") and other long account numbers; amounts with separators stay.
  [/\b\d{4} ?(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{2}\b/g, "[Nummer entfernt]"],
  [/\b\d{9,}\b/g, "[Nummer entfernt]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[Schlüssel entfernt]"],
];

/** Removes account and card numbers, e-mail addresses, phone numbers, passwords and keys from a text. */
export function redactSensitive(value: string): string {
  return redactions.reduce((current, [pattern, replacement]) =>
    typeof replacement === "string" ? current.replace(pattern, replacement) : current.replace(pattern, replacement), value);
}

// Ids, times and names of the app's own parts are no free text; redacting them would only break the entry.
const technicalKeys = new Set(["id", "messageId", "rating", "at", "via", "tool", "source", "kind", "route", "asOf", "viewport", "language", "theme"]);

/** Every free text of an entry redacted, links included; ids, times, numbers and structure stay. */
export function redactEntry<T>(value: T): T {
  if (typeof value === "string") return redactSensitive(value) as T;
  if (Array.isArray(value)) return value.map(redactEntry) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, technicalKeys.has(key) && typeof item === "string" ? item : redactEntry(item)])) as T;
  return value;
}

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
const isAgent = (value: unknown): value is AgentId => typeof value === "string" && value in agentLabel;

export type FeedbackInput = {
  id: string;
  message: AssistantMessage;
  thread: AssistantMessage[];
  rating: FeedbackEntry["rating"];
  comment?: string;
  page?: { route: string; title?: string } | null;
  asOf?: string;
  client?: FeedbackEntry["client"];
};

/** The feedback entry for one answer, built from the chat: question, answer, route, steps, sources and the messages before it. */
export function buildFeedbackEntry({ id, message, thread, rating, comment, page, asOf, client }: FeedbackInput): FeedbackEntry {
  const index = thread.findIndex((item) => item.id === message.id);
  const before = index === -1 ? [] : thread.slice(0, index);
  const asked = message.asked ?? before.findLast((item) => item.role === "user")?.text;
  const steps = message.steps ?? [];
  const agent: AgentId = isAgent(message.agent) ? message.agent : "general";
  const knowledgeTitles = (message.sources ?? []).filter((title) => title !== "Von dir bestätigt");
  const card = message.card;
  return {
    id, messageId: message.id, rating,
    ...(comment?.trim() ? { comment: clip(comment.trim(), 2000) } : {}),
    question: asked ? clip(asked, 1000) : null,
    answer: {
      text: clip(message.text, 4000),
      at: new Date(message.at).toISOString(),
      agent: { id: agent, label: agent === "general" ? "Allgemeiner Chat (Orchestrator)" : agentLabel[agent] },
      ...(message.via ? { via: message.via } : {}),
      ...(message.tool ? { tool: message.tool } : {}),
      ...(message.source ? { source: message.source } : {}),
      ...(message.ms !== undefined ? { ms: message.ms } : {}),
      ...(card ? { card: { kind: card.kind, title: card.title, ...(card.note ? { note: card.note } : {}),
        lines: card.lines.slice(0, 12).map((line) => ({ label: line.label, ...(line.value !== undefined ? { value: line.value } : {}),
          ...(line.detail ? { detail: line.detail } : {}) })) } } : {}),
      ...(message.suggestions?.length ? { suggestions: message.suggestions.slice(0, 4) } : {}),
      ...(message.change ? { pendingChange: message.change.title } : {}),
      ...(message.draft ? { draft: { action: message.draft.action, ...(message.status === "question" ? { missing: "Rückfrage offen" } : {}) } } : {}),
      ...(message.status ? { status: message.status } : {}),
      ...(message.calls?.length ? { calls: message.calls.slice(0, 8).map((call) => ({ tool: call.tool, ok: call.ok, summary: call.summary })) } : {}),
    },
    steps: steps.slice(0, 12),
    retrieval: {
      knowledgeLayer: {
        searched: steps.includes(workStatus.knowledge.text) || steps.includes(workStatus.recall.text),
        titles: knowledgeTitles.slice(0, 5),
        directAnswer: message.tool === "knowledge" && !!card?.note?.includes("lokalen Finanzwissen"),
      },
      learnedAnswer: message.tool === "learned",
      webSearch: { used: message.tool === "web" || steps.includes(workStatus.web.text), sources: (message.links ?? []).slice(0, 4) },
      marketData: steps.includes(workStatus.market.text),
      model: message.source === "KI",
    },
    context: before.slice(-4).map((item) => ({ role: item.role, text: clip(item.text, 600),
      ...(item.agent ? { agent: item.agent } : {}), ...(item.tool ? { tool: item.tool } : {}) })),
    ...(page?.route ? { page: { route: clip(page.route, 200), ...(page.title ? { title: clip(page.title, 80) } : {}) } } : {}),
    ...(asOf ? { asOf } : {}),
    ...(client ? { client } : {}),
  };
}

/** One line per entry for a quick overview: rating, who answered with which tool, the question and the comment. */
export function feedbackSummary(entry: FeedbackEntry): string {
  const who = [entry.answer.agent.label, entry.answer.tool].filter(Boolean).join(" / ");
  const comment = entry.comment ? ` – Kommentar: „${clip(entry.comment, 160)}“` : "";
  return clip(`${entry.rating === "like" ? "👍" : "👎"} ${who}: „${clip(entry.question ?? "(ohne Frage)", 160)}“${comment}`, 500);
}

const header = {
  format: FEEDBACK_FORMAT,
  version: 1,
  about: "Rückmeldungen (👍/👎 mit optionalem Kommentar) zu Antworten des Finanz-Assistenten von Finanzblick. Ein Eintrag je bewerteter Antwort, älteste zuerst.",
  forCopilot: [
    "Diese Datei beschreibt echte Chat-Verläufe mit dem Finanz-Assistenten und wie der Nutzer die Antworten bewertet hat.",
    "Beginne mit den Einträgen mit rating \"dislike\" und lies jeweils comment, question, answer, steps, retrieval und context.",
    "answer.agent und answer.tool zeigen, wer geantwortet hat; answer.via, wie der Orchestrator entschieden hat (rule, signal, model, fallback).",
    "Routing: src/lib/assistant/orchestrator.ts, src/lib/assistant/tools.ts (detectTool) und src/lib/assistant/intents.ts; Werkzeuge: src/lib/assistant/agent.ts.",
    "Freie Antworten: src/lib/ai/answer.ts und src/lib/ai/specialists.ts; Wissen: src/lib/knowledge-base/; Websuche: src/lib/web/search.ts; Chat-Ablauf: src/components/finance-assistant.tsx.",
    "Schlage für jedes Problem die Ursache und eine konkrete Code-Änderung vor und ergänze einen Test mit der Frage aus dem Eintrag.",
  ],
  fields: {
    id: "Feedback-Id; ein später ergänzter Kommentar aktualisiert denselben Eintrag (updatedAt).",
    rating: "like (👍) oder dislike (👎).",
    comment: "Freitext des Nutzers, optional.",
    question: "Die Frage, auf die geantwortet wurde (null bei Antworten ohne Frage, etwa dem Wochenüberblick).",
    answer: "Die vollständige Antwort: Text, Agent, Werkzeug (tool), Weg des Orchestrators (via), Quelle (KI oder Regel), Dauer (ms), Karte, Vorschläge, offene Änderung und Werkzeugaufrufe (calls: Werkzeug, Erfolg, Kurzbeschreibung).",
    steps: "Live-Status-Schritte während der Antwort, in Reihenfolge.",
    retrieval: "Ob lokales Finanzwissen, bestätigte Antworten, Websuche (mit Quellen), Marktdaten oder das Sprachmodell beteiligt waren.",
    context: "Bis zu vier Nachrichten vor der Antwort, damit der Ablauf nachvollziehbar ist.",
    page: "Die App-Seite, die beim Fragen offen war.",
    asOf: "Stichtag der App.",
    client: "Bildschirmbreite, Sprache, Farbschema und reduzierte Bewegung.",
    app: "KI-Einstellungen des Servers beim Speichern.",
  },
  privacy: "IBANs, Karten-, Konto-, Sozialversicherungs- und Telefonnummern, E-Mail-Adressen, Passwörter und Schlüssel sind vor dem Speichern entfernt. Beträge und Händlernamen aus Antworten bleiben, weil sie für die Fehlersuche nötig sind.",
} as const;

/** Whether a parsed file is a Finanzblick feedback file; anything else is never overwritten. */
export const isFeedbackFile = (value: unknown): value is { format: typeof FEEDBACK_FORMAT; entries: unknown[] } =>
  !!value && typeof value === "object" && (value as { format?: unknown }).format === FEEDBACK_FORMAT && Array.isArray((value as { entries?: unknown }).entries);

/** The entries of a parsed feedback file; entries without an id are skipped, a foreign file has none. */
export function readFeedbackFile(value: unknown): StoredFeedback[] {
  if (!isFeedbackFile(value)) return [];
  const entries = value.entries;
  return Array.isArray(entries) ? entries.filter((entry): entry is StoredFeedback =>
    !!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") : [];
}

/** Adds an entry, or updates the one with the same id (a comment added later); the oldest make room beyond the limit. */
export function upsertFeedback(entries: StoredFeedback[], entry: StoredFeedback): StoredFeedback[] {
  const index = entries.findIndex((item) => item.id === entry.id);
  if (index === -1) return [...entries, entry].slice(-MAX_FEEDBACK_ENTRIES);
  const previous = entries[index];
  const merged: StoredFeedback = { ...entry, recordedAt: previous.recordedAt, updatedAt: entry.recordedAt,
    ...(!entry.comment && previous.comment ? { comment: previous.comment } : {}) };
  merged.summary = feedbackSummary(merged);
  return entries.map((item, position) => position === index ? merged : item);
}

/** The whole file: explanations for Copilot first, then counts and the entries. */
export function feedbackFile(entries: StoredFeedback[], now = new Date()): FeedbackFile {
  return {
    ...header, forCopilot: [...header.forCopilot], fields: { ...header.fields },
    updatedAt: now.toISOString(),
    count: {
      total: entries.length,
      like: entries.filter((entry) => entry.rating === "like").length,
      dislike: entries.filter((entry) => entry.rating === "dislike").length,
      withComment: entries.filter((entry) => !!entry.comment).length,
    },
    entries,
  };
}
