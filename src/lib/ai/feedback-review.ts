import { z } from "zod";
import { applyEdit, cleanRule, promptAgent, rulesFor, sameRule, type PromptEdit, type RuleText } from "@/lib/assistant/feedback-rules";
import { correctsPrevious } from "@/lib/assistant/learning";
import type { AgentId } from "@/lib/assistant/orchestrator";
import { MAX_PROMPT_LENGTH, promptGroupName, promptLabel, promptText, reviewTargets, type PromptId, type PromptOverrides } from "./agent-prompts";
import { answerFreeQuestion } from "./answer";
import { interpretAssistantMessage } from "./assistant";
import { chat, type ChatOptions } from "./client";
import type { ModelUse } from "./models";
import { supervise, type Supervision } from "./supervisor";
import { cleanUntrusted, DATA_RULE } from "./untrusted";

/**
 * The review agent (DeepSeek V4 Pro) works on the feedback in the background: for a 👎 with a concrete comment it finds the
 * prompt that caused the answer – the supervisor's planning, how it writes, the answer rules, or a specialist's voice or tool
 * choice – and changes it by one sentence. It then asks the question again with the changed prompt and judges whether that
 * fixes the complaint. Only cleaned, general sentences pass: no names, amounts, links, account numbers or weakened safety rules.
 */

export type ReviewRequest = {
  question: string; answer: string; comment: string; agent?: AgentId;
  /** The messages before the answer, as stored with the feedback. */
  history?: { role: "user" | "assistant"; text: string }[];
  /** How the answer came about: the orchestrator's path, the tool and the tool calls. */
  via?: string; tool?: string; calls?: string[];
  /** The figures the answer's card showed; the answer is written again from them. */
  facts?: Record<string, string | number>;
};
export type Diagnosis = { usable: true; edit: PromptEdit; reason: string } | { usable: false; reason: string };
export type Verdict = { fixed: boolean; note: string };
/** The first proposal, what its retest gave and what was still missing: the second attempt improves on it. */
export type Attempt = { edit: PromptEdit; replay: string; note: string };


const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
// Sentences that carry the JSON format, the placeholders or the data rule are never replaced.
const protectedSentence = /\{werkzeuge\}|\{rechner\}|json|keine anweisung|sicherheit/i;
const replyText = (value: unknown, max: number) => typeof value === "string" ? cleanUntrusted(value, max) : "";

function parseJson(content: string): Record<string, unknown> | undefined {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(content.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The review agent's decision, cleaned: a prompt it may change, one safe and general sentence that is not in the prompt yet,
 * and a replacement only for a sentence that stands there word for word; otherwise the sentence is appended.
 */
export function cleanDiagnosis(raw: Record<string, unknown> | undefined, prompts: PromptOverrides = {}): Diagnosis {
  if (!raw) return { usable: false, reason: "Keine lesbare Antwort des Prüfungs-Agents." };
  const reason = replyText(raw.grund ?? raw.reason, 160);
  if (/^kein/i.test(replyText(raw.art ?? raw.kind, 20))) return { usable: false, reason: reason || "Daran ist kein Prompt schuld." };
  const id = reviewTargets.find((target) => target === replyText(raw.prompt ?? raw.ziel, 40));
  if (!id) return { usable: false, reason: "Kein Prompt genannt, den der Prüfungs-Agent ändern darf." };
  const proposed = replyText(raw.neu ?? raw.new, 400);
  const after = cleanRule(proposed);
  if (!after) return { usable: false, reason: proposed.length > 240 ? "Der neue Satz ist zu lang (über 240 Zeichen)."
    : "Der neue Satz verletzt die Vorgaben (mehr als zwei Sätze, unsicher oder mit Kontaktdaten)." };
  const text = promptText(id, prompts);
  if (sentences(text).some((sentence) => sameRule(sentence, after))) return { usable: false, reason: "Das steht schon im Prompt." };
  const before = replyText(raw.alt ?? raw.old, 600).replace(/^["„“']+|["„“']+$/g, "");
  const replaces = /ersetz|replace/i.test(replyText(raw.art ?? raw.kind, 20)) && before.length >= 15 && !protectedSentence.test(before)
    && text.split(before).length === 2;
  const edit: PromptEdit = replaces ? { id, mode: "replace", before, after } : { id, mode: "append", after };
  const changed = applyEdit(text, edit);
  if (!changed || changed.length > MAX_PROMPT_LENGTH) return { usable: false, reason: "Der Prompt würde zu lang." };
  return { usable: true, edit, reason: reason || "Prompt angepasst." };
}

const before = (request: ReviewRequest) => [
  request.via ? `Weg: ${request.via}` : "",
  request.tool ? `Werkzeug: ${request.tool}` : "",
  request.calls?.length ? `Werkzeugaufrufe: ${request.calls.join(", ")}` : "",
  `Antwort: ${cleanUntrusted(request.answer, 600)}`,
].filter(Boolean).join("\n");

const conversation = (request: ReviewRequest) => request.history?.length
  ? `Verlauf:\n${request.history.slice(-4).map((item) => `${item.role === "user" ? "Nutzer" : "Assistent"}: ${cleanUntrusted(item.text, 300)}`).join("\n")}` : "";

/** The review agent reads question, answer, path and comment and the prompts that shaped the answer, and proposes one change. */
export async function diagnoseFeedback(request: ReviewRequest, prompts: PromptOverrides = {}, previous?: Attempt, options: ChatOptions = {}):
  Promise<{ diagnosis: Diagnosis; use: ModelUse }> {
  const agent = request.agent ?? "general";
  const shown: PromptId[] = ["supervisor", "synthesis", "answer-rules", `voice.${agent}`, `tools.${agent}`];
  const reply = await chat([
    { role: "system", content: `${promptText("review", prompts).trim()} ${DATA_RULE}` },
    { role: "user", content: [
      `Antwort kam von: ${agent} (${promptGroupName(agent)})`,
      before(request),
      conversation(request),
      `Frage: ${cleanUntrusted(request.question, 300)}`,
      `Kommentar des Nutzers: ${cleanUntrusted(request.comment, 500)}`,
      `Änderbare Prompts (${reviewTargets.join(", ")}); die zuständigen im aktuellen Wortlaut:`,
      ...shown.map((id) => `[${id}] ${promptText(id, prompts).slice(0, 2600)}`),
      previous ? `Dein erster Vorschlag für ${previous.edit.id} („${previous.edit.after}“) reichte beim Nachtest nicht. Ergebnis: ${cleanUntrusted(previous.replay, 600)}. ` +
        `${previous.note} Schlag eine bessere Änderung vor, die das Fehlende ausdrücklich verlangt.` : "",
    ].filter(Boolean).join("\n") },
  ], { task: "rule", cloudOnly: true, maxTokens: 320, temperature: 0, ...options });
  return { diagnosis: cleanDiagnosis(parseJson(reply.content), prompts), use: reply.use };
}

const describePlan = (plan: Supervision) => plan.kind === "action" ? `Plan: Aktion bei ${plan.agent}`
  : plan.kind === "ask" ? `Plan: Rückfrage „${plan.question}“`
    : `Plan: Antwort${plan.steps.length ? ` mit ${plan.steps.map((step) => `${step.tool} („${step.question}“)`).join(", ")}` : " nur aus dem Datenüberblick"}`;

/**
 * The question once more with the changed prompt: the supervisor's plan for a planning change, the specialist's pick for a
 * tool-choice change, otherwise the written answer from the card's figures.
 */
export async function replayFeedback(request: ReviewRequest, edit: PromptEdit, prompts: PromptOverrides, rules: readonly RuleText[] = [],
  options: ChatOptions = {}): Promise<string> {
  const chatOptions: ChatOptions = { cloudOnly: true, temperature: 0, ...options };
  // Planned as in the chat: a correction of the previous answer ("… meine ich") with the conversation.
  const correction = !!request.history?.some((item) => item.role === "assistant") && correctsPrevious(request.question);
  if (edit.id === "supervisor") return describePlan(await supervise({ message: request.question, history: request.history, ...(correction ? { correction } : {}) },
    { ...chatOptions, prompts, rules: rulesFor(rules, undefined, "routing") }));
  if (edit.id.startsWith("tools.")) {
    const reply = await interpretAssistantMessage({ message: request.question, asOf: new Date().toISOString().slice(0, 10), history: request.history },
      { ...chatOptions, prompts, rules });
    return `${reply.agent}/${reply.tool ?? (reply.steps?.map((step) => step.tool).join("+") || "Antwort")}${reply.question ? ` · Rückfrage „${reply.question}“` : ""}`;
  }
  const agent = promptAgent(edit.id) ?? request.agent ?? "general";
  const answer = await answerFreeQuestion({ question: request.question, history: request.history, facts: request.facts ?? {}, agent,
    supervised: edit.id === "synthesis" || request.via === "supervisor", ...(correction ? { correction } : {}) }, { ...chatOptions, prompts, rules });
  return answer.text ? `Antwort: ${answer.text}` : "Keine Antwort";
}

const verdictPrompt = "Du prüfst für einen privaten Finanz-Assistenten, ob eine Prompt-Änderung die Beschwerde eines Nutzers behebt. Du siehst Frage, " +
  "Kommentar, die alte Antwort samt Weg und das Ergebnis mit dem geänderten Prompt (ein Plan des Supervisors zeigt, welche Daten und Recherchen er holen " +
  "lässt – web ist die Websuche; der Datenüberblick des Nutzers fehlt beim Nachtest). Beurteile nur, was im Ergebnis wirklich steht, nicht die Absicht der " +
  "Änderung. Zerlege den Kommentar in die einzelnen Forderungen des Nutzers und prüfe jede nach ihrer Absicht, nicht nach dem Wort: erfüllt ist sie, wenn " +
  "das neue Ergebnis sie tut oder einen passenden Schritt dafür enthält. Daten des Nutzers gelten als geholt, wenn ein Lese-Werkzeug sie liefert, das sie " +
  "enthält (contracts = Verträge und Abos, query = Buchungen, Gebühren und Händler, accounts = Konten); eine verlangte Suche oder Recherche braucht einen " +
  "web-Schritt. " +
  "Antworte nur mit JSON: {\"forderungen\": [{\"was\": \"…\", \"erfuellt\": true}], \"behoben\": true, \"grund\": \"…\"} – behoben nur, wenn jede " +
  "Forderung erfüllt ist; grund ist ein kurzer Satz. " + DATA_RULE;

/** The review agent's second look: does the replayed question now do what the user asked for? */
export async function judgeReplay(request: ReviewRequest, edit: PromptEdit, replay: string, options: ChatOptions = {}): Promise<Verdict> {
  const reply = await chat([
    { role: "system", content: verdictPrompt },
    { role: "user", content: [
      `Frage: ${cleanUntrusted(request.question, 300)}`,
      `Kommentar des Nutzers: ${cleanUntrusted(request.comment, 500)}`,
      `Vorher:\n${before(request)}`,
      `Änderung im Prompt ${promptLabel(edit.id)}: ${edit.mode === "replace" ? `„${edit.before}“ → ` : "neuer Satz "}„${edit.after}“`,
      `Nachher (mit dem geänderten Prompt):\n${cleanUntrusted(replay, 1500)}`,
    ].join("\n") },
  ], { task: "rule", cloudOnly: true, maxTokens: 260, temperature: 0, ...options });
  const parsed = z.object({
    behoben: z.boolean(), grund: z.string().nullish(),
    forderungen: z.array(z.object({ was: z.string().nullish(), erfuellt: z.boolean() }).passthrough()).nullish(),
  }).passthrough().safeParse(parseJson(reply.content));
  if (!parsed.success) return { fixed: false, note: "Keine lesbare Antwort beim Nachtest." };
  // Each demand counts on its own: one that is still missing outweighs a lenient overall yes.
  const missing = (parsed.data.forderungen ?? []).filter((item) => !item.erfuellt).map((item) => replyText(item.was ?? "", 80)).filter(Boolean);
  const fixed = parsed.data.behoben && !missing.length;
  const note = !fixed && missing.length ? `Fehlt noch: ${missing.join(", ")}.` : replyText(parsed.data.grund ?? "", 160);
  return { fixed, note: note || (fixed ? "Behoben." : "Nicht behoben.") };
}
