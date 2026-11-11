import { z } from "zod";
import { agentIds, type AgentId } from "@/lib/assistant/orchestrator";
import { chat, chatStream, stripThinking, type ChatMessage, type ChatOptions } from "./client";
import { answerPrompt } from "./specialists";
import { numbersBacked } from "./summary";
import { cleanFacts, cleanUntrusted, contactsBacked } from "./untrusted";

export const answerRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(500) }).strict()).max(6).optional(),
  facts: z.record(z.string(), z.unknown()),
  // What a finance tool already computed for this question; the model may quote it.
  evidence: z.string().max(1500).optional(),
  // The agent the orchestrator chose; it decides the voice. Without one the general chat answers.
  agent: z.enum(agentIds).optional(),
}).strict();
export type AnswerRequest = z.infer<typeof answerRequestSchema>;

// Some replies come back as {"answer": "..."} although plain text was requested.
function unwrapJson(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const inner = [parsed.answer, parsed.antwort, parsed.text, parsed.response, ...Object.values(parsed)].find((item) => typeof item === "string");
    return typeof inner === "string" ? inner : trimmed;
  } catch {
    return trimmed;
  }
}

function answerMessages(input: AnswerRequest, facts: Record<string, unknown>, evidence?: string): ChatMessage[] {
  return [
    { role: "system", content: answerPrompt(input.agent ?? "general") },
    { role: "user", content: [
      `Fakten (JSON):\n${JSON.stringify(facts)}`,
      evidence ? `Werkzeug-Ergebnis zu dieser Frage (verlässlich berechnet):\n${evidence}` : "",
      input.history?.length ? `Verlauf:\n${input.history.map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${item.role === "user" ? item.text : cleanUntrusted(item.text)}`).join("\n")}` : "",
      `Frage: ${input.question}`,
    ].filter(Boolean).join("\n\n") },
  ];
}

// Specialists keep it short; the general chat gets a little more room and a livelier temperature.
const answerOptions = (agent: AgentId = "general") => agent === "general" ? { maxTokens: 400, temperature: 0.5 } : { maxTokens: 300, temperature: 0.3 };

// Amounts written inside texts (tool results, health check) and the user's own numbers in the question count as backed, too.
function backing(facts: Record<string, unknown>, evidence?: string, question?: string) {
  const numbers: number[] = [];
  const collect = (text: string) => {
    for (const raw of text.match(/\d+(?:\.\d{3})*(?:,\d+)?/g) ?? []) numbers.push(Number(raw.replace(/\./g, "").replace(",", ".")));
  };
  JSON.stringify(facts, (_key, value) => { if (typeof value === "string") collect(value); return value; });
  if (evidence) collect(evidence);
  if (question) collect(question);
  return { facts, numbers };
}

export type Check = (sentence: string) => boolean;
const backed = (sentence: string, source: object) => numbersBacked(sentence, source) && contactsBacked(sentence, source);
// Money amounts in a sentence ("1.200 €", "€ 50", "300 Euro"); other numbers are general knowledge.
const MONEY = /(?:€|eur\b|euro\b)\s*\d[\d.,]*|\d[\d.,]*\s*(?:€|eur\b|euro\b)/gi;
// A general chat answer without personal data may use general knowledge, but never a money amount or contact detail.
const chatBacked = (sentence: string, source: object) =>
  numbersBacked((sentence.match(MONEY) ?? []).join(" "), source) && contactsBacked(sentence, source);
const PERSONAL = new Set(["today", "wissen"]);
/** Strict for everything about the user's money; relaxed only for the general chat when it holds no personal facts. */
export function answerCheck(agent: AgentId | undefined, facts: Record<string, unknown>, evidence?: string): (sentence: string, source: object) => boolean {
  const personal = !!evidence || Object.keys(facts).some((key) => !PERSONAL.has(key));
  return (agent ?? "general") === "general" && !personal ? chatBacked : backed;
}

// Plain chat text: no Markdown emphasis, headings or list markers, one paragraph per answer.
export function tidyAnswer(text: string): string {
  const plain = text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, "").trim()).filter(Boolean).join(" ")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2").replace(/`([^`]*)`/g, "$1");
  // Stock openers ("Kurz gesagt:", "Gute Frage!") and echoing the question ("Du willst wissen, …?") add nothing in a chat.
  const rest = plain.replace(/^(?:kurz gesagt|kurz und knapp|gute frage|klar doch|na klar)\s*[:!,.–-]\s*/i, "")
    .replace(/^(?:(?:okay|ok|alles klar|klar),?\s+)?du (?:willst|möchtest|moechtest|fragst|fragst dich|meinst)\b[^?.!]{0,160}\?\s+(?=\S)/i, "");
  return rest === plain || !rest ? plain : rest.charAt(0).toUpperCase() + rest.slice(1);
}

// Splits after ., ! or ? followed by a space; "8.279,28" and "8.11.2026" stay whole.
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

// Sentences with an invented amount, link or account number are dropped; the rest of the answer survives.
function groundedText(content: string, source: object, check: (sentence: string, source: object) => boolean = backed) {
  const text = tidyAnswer(unwrapJson(stripThinking(content))).replace(/\s+/g, " ").trim().slice(0, 1200);
  if (text.startsWith("{")) return undefined;
  // Small models sometimes loop; a sentence said twice is kept once.
  const seen = new Set<string>();
  const kept = sentences(text).filter((sentence) => check(sentence, source))
    .filter((sentence) => { const key = sentence.toLowerCase(); return !seen.has(key) && !!seen.add(key); }).join(" ").trim();
  return kept.length >= 2 && /\p{L}/u.test(kept) ? kept : undefined;
}

function prepare(input: AnswerRequest) {
  const facts = cleanFacts(input.facts, 1500);
  const evidence = input.evidence ? cleanUntrusted(input.evidence, 1500) : undefined;
  return { facts, evidence, source: backing(facts, evidence, input.question), check: answerCheck(input.agent, facts, evidence) };
}

// A grounded free answer: every number, link and account number must come from the facts or the tool result.
export async function answerFreeQuestion(input: AnswerRequest, options: ChatOptions = {}): Promise<{ text?: string; source: "KI" }> {
  const { facts, evidence, source, check } = prepare(input);
  const answer = await chat(answerMessages(input, facts, evidence), { ...options, ...answerOptions(input.agent) });
  const text = groundedText(answer.content, source, check);
  return text ? { text, source: "KI" } : { source: "KI" };
}

export type AnswerEvent = { delta: string } | { replace: string } | { done: true; ok: boolean; text?: string };

// Text that may already be shown: finished sentences that are backed, plus the whole words of the sentence being written while it is backed.
export function visiblePrefix(content: string, source: object, check: (sentence: string, source: object) => boolean = backed): string {
  // A trailing space marks the last word as complete; the tidying must keep it.
  const text = `${tidyAnswer(content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/<[^>]*$/, ""))}${/\s$/.test(content) ? " " : ""}`
    .replace(/\s+/g, " ").trimStart();
  if (text.startsWith("{")) return "";
  const parts = sentences(text.slice(0, 1200));
  const open = /[.!?]$/.test(text.trimEnd()) && /\s$/.test(text) ? "" : parts.pop() ?? "";
  const done = parts.filter((sentence) => check(sentence, source));
  const words = open.slice(0, Math.max(0, open.lastIndexOf(" ")));
  if (words && check(words, source)) done.push(words);
  return done.join(" ");
}

// Streams the free answer word by word; a sentence that turns out unbacked disappears again via a `replace` event.
export async function* streamFreeAnswer(input: AnswerRequest, options: ChatOptions = {}): AsyncGenerator<AnswerEvent> {
  const { facts, evidence, source, check } = prepare(input);
  let content = "";
  let shown = "";
  for await (const piece of chatStream(answerMessages(input, facts, evidence), { ...options, ...answerOptions(input.agent) })) {
    content += piece;
    const visible = visiblePrefix(content, source, check);
    if (visible === shown) continue;
    if (visible.startsWith(shown)) yield { delta: visible.slice(shown.length) };
    else yield { replace: visible };
    shown = visible;
  }
  const text = groundedText(content, source, check);
  yield text ? { done: true, ok: true, text } : { done: true, ok: false };
}
