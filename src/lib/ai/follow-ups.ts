import { z } from "zod";
import { agentIds } from "@/lib/assistant/orchestrator";
import { contentWords } from "@/lib/knowledge-base/query";
import { AiUnavailableError, chat, type ChatOptions } from "./client";
import type { ModelUse } from "./models";
import { cleanUntrusted, DATA_RULE, looksInjected, maskContacts } from "./untrusted";

export const followUpRequestSchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(1500),
  agent: z.enum(agentIds).optional(),
  // The fixed suggestions of the tool that answered: a hint for the topic.
  hints: z.array(z.string().trim().min(1).max(120)).max(4).optional(),
  // The user's last questions, so nothing already asked comes back.
  asked: z.array(z.string().trim().min(1).max(300)).max(4).optional(),
}).strict();
export type FollowUpRequest = z.infer<typeof followUpRequestSchema>;

export const MAX_FOLLOW_UPS = 3;

const prompt = "Du schlägst für einen privaten Finanz-Assistenten in Österreich drei kurze Folgefragen vor, die der Nutzer als Nächstes stellen könnte. " +
  "Schreib aus Sicht des Nutzers in der Ich-Form, natürlich und konkret, je höchstens 70 Zeichen, passend zur letzten Antwort. " +
  "Nur Themen, die die App beantworten kann: Umsätze und Ausgaben, Verträge und Abos, Budget, Kontostände und Prognose, Sparziele, Gehalt und Steuern, " +
  "allgemeines Finanzwissen. Keine Beträge, Namen, Links oder Kontonummern erfinden, nichts wiederholen, was schon gefragt wurde, nichts löschen oder überweisen. " +
  "Antworte nur mit JSON: {\"fragen\": [\"…\", \"…\", \"…\"]}. " + DATA_RULE;

// Reading questions and harmless requests only: a click must never start a deletion or a transfer.
const harmful = /(?:lösch|loesch|entfern|überweis|ueberweis|vergiss|passwort|kennwort)\p{L}*|\bzahl\p{L}* (?:\S+ )?an\b|\b(?:pin|tan)\b/iu;
const questionStart = /^(?:welche\p{L}*|wie|was|wann|wo\p{L}*|warum|wieso|weshalb|lohnt|kann|könnte|soll\p{L}*|gibt|bin|habe?|muss|wird|werde|ist|sind|reicht|geht)(?![\p{L}\d])/iu;
const safeRequest = /^(?:zeig|erklär|erklaer|vergleich|gib|berechne|rechne|liste|nenn|hilf|plan|such)\p{L}*(?![\p{L}\d])/iu;

// Two questions are the same when most of their meaningful words match, counted on the longer one.
const meaning = (text: string) => new Set(contentWords(text).map((word) => word.replace(/(?:en|er|es|e|n|s)$/u, "")));
function sameQuestion(a: string, b: string) {
  const left = meaning(a);
  const right = meaning(b);
  if (!left.size || !right.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  return [...left].filter((word) => right.has(word)).length / Math.max(left.size, right.size) >= 0.8;
}

/** The model's suggestions, cleaned: short reading questions only, nothing invented, injected or already asked; at most three. */
export function cleanFollowUps(raw: unknown, input: Pick<FollowUpRequest, "question" | "asked">): string[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw).find(Array.isArray) ?? [] : [];
  const seen = [input.question, ...(input.asked ?? [])];
  const kept: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    let text = item.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["„“'»«]+|["„“'»«]+$/g, "").replace(/\s+/g, " ").trim();
    // A question gets its question mark; a request ("Zeig mir meine Abos") stays a request; anything else is dropped.
    if (text.endsWith("?") || questionStart.test(text)) text = `${text.replace(/[.!?]+$/, "")}?`;
    else if (safeRequest.test(text)) text = text.replace(/[.!]+$/, "");
    else continue;
    if (text.length < 8 || text.length > 90 || !/\p{L}{3}/u.test(text)) continue;
    if (harmful.test(text) || looksInjected(text) || maskContacts(text) !== text || /\d{5,}|[<>]|\b(?:Person|IBAN|Karte|Nummer|Telefon|email)-\d+\b/.test(text)) continue;
    if ([...seen, ...kept].some((other) => sameQuestion(other, text))) continue;
    kept.push(text);
    if (kept.length === MAX_FOLLOW_UPS) break;
  }
  return kept;
}

function parse(content: string): unknown {
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = content.indexOf(open);
    const end = content.lastIndexOf(close);
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      // Tries the other form.
    }
  }
  return undefined;
}

/**
 * Two or three follow-up questions that fit the last answer, written by DeepSeek's fast model. Cloud only: without
 * DeepSeek the chat keeps its fixed suggestions instead of waiting for the local model.
 */
export async function suggestFollowUps(input: FollowUpRequest, options: ChatOptions = {}): Promise<{ suggestions: string[]; models: ModelUse[] }> {
  const reply = await chat([
    { role: "system", content: prompt },
    { role: "user", content: [
      `Frage: ${cleanUntrusted(input.question, 500)}`,
      `Antwort: ${cleanUntrusted(input.answer, 1200)}`,
      input.hints?.length ? `Passende Themen: ${input.hints.map((hint) => cleanUntrusted(hint, 120)).join(" | ")}` : "",
      input.asked?.length ? `Schon gefragt: ${input.asked.map((item) => cleanUntrusted(item, 200)).join(" | ")}` : "",
    ].filter(Boolean).join("\n") },
  ], { task: "suggest", cloudOnly: true, maxTokens: 160, temperature: 0.4, ...options });
  const suggestions = cleanFollowUps(parse(reply.content), input);
  if (suggestions.length < 2) throw new AiUnavailableError("Keine brauchbaren Folgefragen.");
  return { suggestions, models: [reply.use] };
}
