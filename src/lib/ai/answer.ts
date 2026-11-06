import { z } from "zod";
import { chat, chatStream, stripThinking, type ChatMessage, type ChatOptions } from "./client";
import { numbersBacked } from "./summary";
import { cleanFacts, cleanUntrusted, contactsBacked, DATA_RULE } from "./untrusted";

export const answerRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(500) }).strict()).max(6).optional(),
  facts: z.record(z.string(), z.unknown()),
}).strict();
export type AnswerRequest = z.infer<typeof answerRequestSchema>;

const systemPrompt = "Du bist der Finanz-Assistent eines privaten Finanzdashboards in Österreich und antwortest auf Deutsch in der Du-Form. " +
  "Beantworte die Frage nur mit den Fakten (JSON). Maximal 4 kurze Sätze, kein Markdown, keine Aufzählungen. " +
  "Nenne Beträge genau so, wie sie in den Fakten stehen, und rechne nichts selbst aus. " +
  "amex.stillToTransfer ist, was noch auf das Amex-Rückzahlungs-Pocket überwiesen werden muss. totalSavings ist das gesamte Erspartes. " +
  "Stehen die nötigen Zahlen nicht in den Fakten, sag ehrlich, dass du das nicht weißt, und schlag eine passende Frage vor. " +
  "Erfinde nichts und gib keine Anlageberatung. " + DATA_RULE;

// Some replies come back as {"answer": "..."} although plain text was requested.
function unwrapJson(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const inner = [parsed.answer, parsed.antwort, parsed.text].find((item) => typeof item === "string");
    return typeof inner === "string" ? inner : trimmed;
  } catch {
    return trimmed;
  }
}

function answerMessages(input: AnswerRequest, facts: Record<string, unknown>): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: [
      `Fakten (JSON):\n${JSON.stringify(facts)}`,
      input.history?.length ? `Verlauf:\n${input.history.map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${item.role === "user" ? item.text : cleanUntrusted(item.text)}`).join("\n")}` : "",
      `Frage: ${input.question}`,
    ].filter(Boolean).join("\n\n") },
  ];
}

const answerOptions = { maxTokens: 400, temperature: 0.2 };

function groundedText(content: string, facts: Record<string, unknown>) {
  const text = unwrapJson(stripThinking(content)).replace(/\s+/g, " ").trim().slice(0, 900);
  return text.length >= 15 && numbersBacked(text, facts) && contactsBacked(text, facts) ? text : undefined;
}

// A grounded free answer: every number, link and account number must come from the facts, otherwise nothing is returned.
export async function answerFreeQuestion(input: AnswerRequest, options: ChatOptions = {}): Promise<{ text?: string; source: "KI" }> {
  const facts = cleanFacts(input.facts, 1500);
  const answer = await chat(answerMessages(input, facts), { ...options, ...answerOptions });
  const text = groundedText(answer.content, facts);
  return text ? { text, source: "KI" } : { source: "KI" };
}

export type AnswerEvent = { delta: string } | { done: true; ok: boolean; text?: string };

// Text that may already be shown: no thinking block, whole words only, nothing while it looks like JSON, undefined once something is unbacked.
export function visiblePrefix(content: string, facts: object): string | undefined {
  const text = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/<[^>]*$/, "").replace(/\s+/g, " ").trimStart();
  if (text.startsWith("{")) return "";
  const words = text.slice(0, Math.max(0, text.lastIndexOf(" "))).slice(0, 900);
  return numbersBacked(words, facts) && contactsBacked(words, facts) ? words : undefined;
}

// Streams the free answer word by word; the final event repeats the grounding check on the full text.
export async function* streamFreeAnswer(input: AnswerRequest, options: ChatOptions = {}): AsyncGenerator<AnswerEvent> {
  const facts = cleanFacts(input.facts, 1500);
  let content = "";
  let shown = "";
  let blocked = false;
  for await (const piece of chatStream(answerMessages(input, facts), { ...options, ...answerOptions })) {
    content += piece;
    if (blocked) continue;
    const visible = visiblePrefix(content, facts);
    // Once something unbacked appears nothing more is shown; the final check will reject the answer anyway.
    if (visible === undefined) { blocked = true; continue; }
    if (visible.length > shown.length && visible.startsWith(shown)) {
      yield { delta: visible.slice(shown.length) };
      shown = visible;
    }
  }
  const text = groundedText(content, facts);
  yield text ? { done: true, ok: true, text } : { done: true, ok: false };
}
