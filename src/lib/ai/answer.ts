import { z } from "zod";
import { chat, chatStream, stripThinking, type ChatMessage, type ChatOptions } from "./client";
import { numbersBacked } from "./summary";
import { cleanFacts, cleanUntrusted, contactsBacked, DATA_RULE } from "./untrusted";

export const answerRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(500) }).strict()).max(6).optional(),
  facts: z.record(z.string(), z.unknown()),
  // What a finance tool already computed for this question; the model may quote it.
  evidence: z.string().max(1500).optional(),
}).strict();
export type AnswerRequest = z.infer<typeof answerRequestSchema>;

const systemPrompt = "Du bist Finanzblick, der persönliche Finanz-Assistent in einem privaten Finanzdashboard in Österreich. " +
  "Du sprichst wie ein kluger, ehrlicher Freund: natürlich, auf Deutsch, in der Du-Form, ohne Floskeln. Verstehe jede Formulierung, auch locker, " +
  "umgangssprachlich, mit Tippfehlern oder auf Englisch, und beantworte genau das, was gemeint ist. " +
  "Beginne mit der direkten Antwort, erkläre dann kurz das Warum und gib, wenn es passt, einen konkreten nächsten Schritt. " +
  "Höchstens 6 kurze Sätze, kein Markdown, keine Aufzählungszeichen, kein JSON. " +
  "Für alles über die Finanzen des Nutzers nutzt du nur die Fakten (JSON) und das Werkzeug-Ergebnis; nenne Beträge genau so, wie sie dort stehen, " +
  "und rechne nichts selbst aus. Fehlt eine Zahl, sag das offen und schlag vor, was du stattdessen sagen kannst. " +
  "Allgemeine Fragen zu Geld, Sparen, Budgetieren, Verträgen oder Begriffen beantwortest du aus deinem Wissen, ohne Beträge zu erfinden. " +
  "Allgemeine Tipps sind erlaubt; empfiehl aber keine einzelnen Aktien, Fonds oder Anbieter. Bei Sorgen oder Stress zuerst kurz Verständnis zeigen, dann konkret helfen. " +
  "Erklärungen zu den Fakten: currentMonth.surplus ist der geplante Überschuss (negativ = Lücke), safeToSpendToday.perDay der Betrag pro Tag bis zum Gehalt, " +
  "amex.stillToTransfer was noch aufs Amex-Rückzahlungs-Pocket muss, totalSavings das gesamte Ersparte, yearToDate.savedSinceJanuary ist, was seit Jahresbeginn gespart wurde (Einnahmen minus Ausgaben; nicht der Kontostand), balances[].bank die Bank des Kontos, " +
  "giroForecast12Months die Prognose des Girokontos. " + DATA_RULE;

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
    { role: "system", content: systemPrompt },
    { role: "user", content: [
      `Fakten (JSON):\n${JSON.stringify(facts)}`,
      evidence ? `Werkzeug-Ergebnis zu dieser Frage (verlässlich berechnet):\n${evidence}` : "",
      input.history?.length ? `Verlauf:\n${input.history.map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${item.role === "user" ? item.text : cleanUntrusted(item.text)}`).join("\n")}` : "",
      `Frage: ${input.question}`,
    ].filter(Boolean).join("\n\n") },
  ];
}

const answerOptions = { maxTokens: 450, temperature: 0.3 };

// Amounts written inside texts (tool results, health check) count as backed, too.
function backing(facts: Record<string, unknown>, evidence?: string) {
  const numbers: number[] = [];
  const collect = (text: string) => {
    for (const raw of text.match(/\d+(?:\.\d{3})*(?:,\d+)?/g) ?? []) numbers.push(Number(raw.replace(/\./g, "").replace(",", ".")));
  };
  JSON.stringify(facts, (_key, value) => { if (typeof value === "string") collect(value); return value; });
  if (evidence) collect(evidence);
  return { facts, numbers };
}

const backed = (sentence: string, source: object) => numbersBacked(sentence, source) && contactsBacked(sentence, source);

// Splits after ., ! or ? followed by a space; "8.279,28" and "8.11.2026" stay whole.
const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

// Sentences with an invented amount, link or account number are dropped; the rest of the answer survives.
function groundedText(content: string, source: object) {
  const text = unwrapJson(stripThinking(content)).replace(/\s+/g, " ").trim().slice(0, 1200);
  if (text.startsWith("{")) return undefined;
  const kept = sentences(text).filter((sentence) => backed(sentence, source)).join(" ").trim();
  return kept.length >= 15 ? kept : undefined;
}

function prepare(input: AnswerRequest) {
  const facts = cleanFacts(input.facts, 1500);
  const evidence = input.evidence ? cleanUntrusted(input.evidence, 1500) : undefined;
  return { facts, evidence, source: backing(facts, evidence) };
}

// A grounded free answer: every number, link and account number must come from the facts or the tool result.
export async function answerFreeQuestion(input: AnswerRequest, options: ChatOptions = {}): Promise<{ text?: string; source: "KI" }> {
  const { facts, evidence, source } = prepare(input);
  const answer = await chat(answerMessages(input, facts, evidence), { ...options, ...answerOptions });
  const text = groundedText(answer.content, source);
  return text ? { text, source: "KI" } : { source: "KI" };
}

export type AnswerEvent = { delta: string } | { replace: string } | { done: true; ok: boolean; text?: string };

// Text that may already be shown: finished sentences that are backed, plus the whole words of the sentence being written while it is backed.
export function visiblePrefix(content: string, source: object): string {
  const text = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/<[^>]*$/, "").replace(/\s+/g, " ").trimStart();
  if (text.startsWith("{")) return "";
  const parts = sentences(text.slice(0, 1200));
  const open = /[.!?]$/.test(text.trimEnd()) && /\s$/.test(text) ? "" : parts.pop() ?? "";
  const done = parts.filter((sentence) => backed(sentence, source));
  const words = open.slice(0, Math.max(0, open.lastIndexOf(" ")));
  if (words && backed(words, source)) done.push(words);
  return done.join(" ");
}

// Streams the free answer word by word; a sentence that turns out unbacked disappears again via a `replace` event.
export async function* streamFreeAnswer(input: AnswerRequest, options: ChatOptions = {}): AsyncGenerator<AnswerEvent> {
  const { facts, evidence, source } = prepare(input);
  let content = "";
  let shown = "";
  for await (const piece of chatStream(answerMessages(input, facts, evidence), { ...options, ...answerOptions })) {
    content += piece;
    const visible = visiblePrefix(content, source);
    if (visible === shown) continue;
    if (visible.startsWith(shown)) yield { delta: visible.slice(shown.length) };
    else yield { replace: visible };
    shown = visible;
  }
  const text = groundedText(content, source);
  yield text ? { done: true, ok: true, text } : { done: true, ok: false };
}
