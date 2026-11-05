import { z } from "zod";
import { chat, stripThinking, type ChatOptions } from "./client";
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

// A grounded free answer: every number, link and account number must come from the facts, otherwise nothing is returned.
export async function answerFreeQuestion(input: AnswerRequest, options: ChatOptions = {}): Promise<{ text?: string; source: "KI" }> {
  const facts = cleanFacts(input.facts, 1500);
  const answer = await chat([
    { role: "system", content: systemPrompt },
    { role: "user", content: [
      `Fakten (JSON):\n${JSON.stringify(facts)}`,
      input.history?.length ? `Verlauf:\n${input.history.map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${item.role === "user" ? item.text : cleanUntrusted(item.text)}`).join("\n")}` : "",
      `Frage: ${input.question}`,
    ].filter(Boolean).join("\n\n") },
  ], { ...options, maxTokens: 400, temperature: 0.2 });
  const text = unwrapJson(stripThinking(answer.content)).replace(/\s+/g, " ").trim().slice(0, 900);
  return text.length >= 15 && numbersBacked(text, facts) && contactsBacked(text, facts) ? { text, source: "KI" } : { source: "KI" };
}
