import { z } from "zod";
import { rulesFor, type RuleText } from "@/lib/assistant/feedback-rules";
import { detectSmallTalk } from "@/lib/assistant/smalltalk";
import { blocksToMarkdown, parseBlocks, type Block, type ListBlock } from "@/lib/assistant/markdown";
import { agentIds, chatRequest, type AgentId } from "@/lib/assistant/orchestrator";
import { MAX_PROMPT_PREVIEW } from "@/lib/types";
import { chat, chatStream, stripThinking, type ChatMessage, type ChatOptions } from "./client";
import { analysisQuestion, needsReasoning, taxQuestion, type AiTask, type ModelUse } from "./models";
import type { PromptOverrides } from "./agent-prompts";
import { answerPrompt } from "./specialists";
import { numbersBacked } from "./summary";
import { cleanFacts, cleanUntrusted, contactsBacked } from "./untrusted";

export const answerRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(500) }).strict()).max(6).optional(),
  facts: z.record(z.string(), z.unknown()),
  // What a finance tool already computed for this question; the model may quote it.
  evidence: z.string().max(4000).optional(),
  // The agent the orchestrator chose; it decides the voice. Without one the general chat answers.
  agent: z.enum(agentIds).optional(),
  // The supervisor planned the lookups and now writes the answer from all of their results.
  supervised: z.boolean().optional(),
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

/** Model options plus the active rules learned from feedback and the admin's prompts (the server loads both; the eval passes its own). */
export type AnswerOptions = ChatOptions & { rules?: readonly RuleText[]; prompts?: PromptOverrides };

function answerMessages(input: AnswerRequest, facts: Record<string, unknown>, evidence?: string, rules?: readonly RuleText[], prompts?: PromptOverrides): ChatMessage[] {
  const agent = input.agent ?? "general";
  return [
    { role: "system", content: answerPrompt(agent, rulesFor(rules, agent, "answer"), input.supervised, prompts) },
    { role: "user", content: [
      `Fakten (JSON):\n${JSON.stringify(facts)}`,
      evidence ? `${input.supervised ? "Ergebnisse der Spezialisten" : "Werkzeug-Ergebnis"} zu dieser Frage (verlässlich berechnet):\n${evidence}` : "",
      input.history?.length ? `Verlauf:\n${input.history.map((item) => `${item.role === "user" ? "Ich" : "Assistent"}: ${item.role === "user" ? item.text : cleanUntrusted(item.text)}`).join("\n")}` : "",
      `Frage: ${input.question}`,
    ].filter(Boolean).join("\n\n") },
  ];
}

// Room for a short list or a small comparison table; the general chat is a little livelier, the supervisor gets the most room.
const answerOptions = (agent: AgentId = "general", supervised = false) => supervised ? { maxTokens: 700, temperature: 0.3 }
  : agent === "general" ? { maxTokens: 400, temperature: 0.4 } : { maxTokens: 400, temperature: 0.3 };

/**
 * Web search summaries and ordinary questions take the fast model, analyses and tax questions the thinking mode. The supervisor
 * writes from results its workers already computed, so V4 Pro answers without the slow thinking mode, except for tax analyses
 * ("Warum zahle ich so viel Lohnsteuer?"); "Wie viel netto bekomme ich?" is a figure the payroll tool already computed.
 */
export function answerTask(input: Pick<AnswerRequest, "question" | "agent" | "evidence" | "supervised"> & { facts?: Record<string, unknown> }): AiTask {
  if (input.evidence?.startsWith("Websuche")) return "web";
  if (input.supervised) {
    if (briefTalk(input)) return "chat";
    return taxQuestion(input.question, input.agent) && analysisQuestion(input.question) ? "reasoning" : "synthesize";
  }
  return needsReasoning(input.question, input.agent) ? "reasoning" : "chat";
}

/**
 * Greetings, thanks and creative requests without data or lookups need no analysis: the fast model writes them. Everything
 * else the supervisor answers – analysis, summary, assessment, research, explanation – V4 Pro writes.
 */
export function briefTalk(input: Pick<AnswerRequest, "question" | "agent" | "evidence"> & { facts?: Record<string, unknown> }): boolean {
  const personal = Object.keys(input.facts ?? {}).some((key) => !PERSONAL.has(key));
  return (input.agent ?? "general") === "general" && !input.evidence && !personal && (!!detectSmallTalk(input.question) || chatRequest(input.question));
}

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

const MAX_ANSWER = 3000;
const MAX_BLOCKS = 14;
const HTML_TAG = /<\/?(?:p|b|i|u|em|strong|span|div|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|code|pre|sup|sub|small|mark)\b[^>]*>/gi;
const withoutHtml = (text: string) => text.replace(/<br\s*\/?>/gi, "\n").replace(HTML_TAG, "").replace(/\r\n?/g, "\n");

// Stock openers ("Kurz gesagt:", "Gute Frage!") and echoing the question ("Du willst wissen, …?") add nothing in a chat.
function dropOpener(text: string): string {
  const rest = text.replace(/^(?:kurz gesagt|kurz und knapp|gute frage|klar doch|na klar|gerne?)\s*[:!,.–-]\s*/i, "")
    .replace(/^(?:(?:okay|ok|alles klar|klar),?\s+)?du (?:willst|möchtest|moechtest|fragst|fragst dich|meinst)\b[^?.!]{0,160}\?\s+(?=\S)/i, "")
    .replace(/^(?:wo|was|wie|wann|wer|warum|wieso|welche[rsmn]?|wofür|wohin)\b[^.!?]{0,80}\b(?:du|dein\w*|dich|dir)\b[^.!?]{0,40}\?\s+(?=\S)/i, "");
  return rest === text || !rest ? text : rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * Chat Markdown, tidied: no HTML, no stock opener at the start, headings and rules only in an answer long enough to need
 * them, at most 14 blocks. Paragraphs, lists, tables and code stay as the model wrote them.
 */
export function tidyAnswer(text: string): string {
  let blocks = parseBlocks(withoutHtml(text).replace(/\n{3,}/g, "\n\n").trim());
  if (blocks.filter((block) => block.type !== "heading" && block.type !== "rule").length < 3)
    blocks = blocks.filter((block) => block.type !== "heading" && block.type !== "rule");
  const first = blocks[0];
  if (first?.type === "paragraph") blocks = [{ ...first, text: dropOpener(first.text) }, ...blocks.slice(1)];
  return blocksToMarkdown(blocks.slice(0, MAX_BLOCKS));
}

// Splits after ., ! or ? followed by a space; "8.279,28" and "8.11.2026" stay whole. A dot before a lowercase word
// ("am 25.8. und …") and the dot of an abbreviation ("z. B. 500 €", "ca. 40 %") end no sentence.
const sentences = (text: string) =>
  text.split(/(?<!\b(?:[zdu]|z\.\s?B|d\.\s?h|u\.\s?a|ca|inkl|exkl|ggf|evtl|bzw|bspw|vgl|Nr|max|mind|zzgl|abzgl)\.)(?<=[.!?])\s+(?=[^a-zäöüß])/).filter(Boolean);

/**
 * A sentence whose later clause adds an unbacked figure keeps the backed clauses before it: "Dir bleiben 412 € – bei 16
 * Tagen rund 25,78 € pro Tag." becomes "Dir bleiben 412 €." Without a backed beginning of at least three words it goes.
 */
function backedPart(sentence: string, keep: (sentence: string) => boolean, close = true): string | undefined {
  if (keep(sentence)) return sentence;
  const parts = sentence.split(/(\s+[–—]\s+|;\s+)/);
  let kept = "";
  for (let index = 0; index < parts.length - 2; index += 2) {
    const next = kept + (index ? parts[index - 1] : "") + parts[index];
    if (!keep(next)) break;
    kept = next;
  }
  const text = kept.replace(/[\s,:;–—-]+$/, "");
  if (text.split(/\s+/).length < 3 || !/\p{L}/u.test(text)) return undefined;
  return close ? `${text}.` : text;
}

/**
 * Every sentence of a paragraph or list item, every table row and every heading must pass the check, or it is dropped
 * (a sentence said twice is kept once); code only must not invent an amount or a contact. Headings left without text
 * and rules at the edges go, too.
 */
function groundBlocks(blocks: readonly Block[], keep: (sentence: string) => boolean, keepCode: (code: string) => boolean): Block[] {
  const seen = new Set<string>();
  const prose = (text: string) => text.split("\n").map((line) => sentences(line.replace(/\s+/g, " ").trim())
    .flatMap((sentence) => backedPart(sentence, keep) ?? [])
    .filter((sentence) => { const key = sentence.toLowerCase(); return !seen.has(key) && !!seen.add(key); }).join(" ")).filter(Boolean).join("\n");
  const list = (block: ListBlock): ListBlock | undefined => {
    const items = block.items.flatMap((item) => {
      const text = prose(item.text);
      const sub = item.sub && list(item.sub);
      return text || sub ? [{ text, ...(sub ? { sub } : {}) }] : [];
    });
    return items.length ? { ...block, items } : undefined;
  };
  const kept: Block[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "quote") {
      const text = prose(block.text);
      if (text) kept.push({ ...block, text });
    } else if (block.type === "list") {
      const items = list(block);
      if (items) kept.push(items);
    } else if (block.type === "table") {
      const rows = block.rows.filter((cells) => keep(cells.join(" · ")));
      if (rows.length && keep(block.header.join(" · "))) kept.push({ ...block, rows });
    } else if (block.type === "code") {
      if (block.code.trim() && keepCode(block.code)) kept.push(block);
    } else if (block.type === "heading") {
      if (keep(block.text)) kept.push(block);
    } else kept.push(block);
  }
  return kept.filter((block, index) => block.type === "heading" ? !!kept[index + 1] && kept[index + 1].type !== "heading"
    : block.type !== "rule" || (index > 0 && index < kept.length - 1));
}

// The answer up to the length limit, whole blocks only.
function fitted(blocks: readonly Block[]): string {
  const kept: Block[] = [];
  for (const block of blocks) {
    if (blocksToMarkdown([...kept, block]).length > MAX_ANSWER) break;
    kept.push(block);
  }
  return kept.length ? blocksToMarkdown(kept) : blocksToMarkdown(blocks.slice(0, 1)).slice(0, MAX_ANSWER);
}

// An answer whose amounts, links and account numbers are all backed; whatever is not is dropped, block by block.
function groundedText(content: string, source: object, check: (sentence: string, source: object) => boolean = backed) {
  const raw = unwrapJson(stripThinking(content));
  if (raw.startsWith("{")) return undefined;
  const kept = fitted(groundBlocks(parseBlocks(tidyAnswer(raw)), (sentence) => check(sentence, source), (code) => chatBacked(code, source)));
  return kept.length >= 2 && /\p{L}/u.test(kept) ? kept : undefined;
}

// Small models sometimes repeat the user's question in the middle of the answer; that sentence is dropped.
const plainWords = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const echoes = (sentence: string, question: string) => !!question.trim() && plainWords(sentence) === plainWords(question);

function prepare(input: AnswerRequest) {
  const facts = cleanFacts(input.facts, 1500);
  const evidence = input.evidence ? cleanUntrusted(input.evidence, 4000) : undefined;
  const check = answerCheck(input.agent, facts, evidence);
  return { facts, evidence, source: backing(facts, evidence, input.question),
    check: (sentence: string, source: object) => !echoes(sentence, input.question) && check(sentence, source) };
}

// A grounded free answer: every number, link and account number must come from the facts or the tool result.
export async function answerFreeQuestion(input: AnswerRequest, options: AnswerOptions = {}): Promise<{ text?: string; source: "KI"; models: ModelUse[]; prompt: string }> {
  const { facts, evidence, source, check } = prepare(input);
  const messages = answerMessages(input, facts, evidence, options.rules, options.prompts);
  const answer = await chat(messages, { task: answerTask({ ...input, facts }), ...answerOptions(input.agent, input.supervised), ...options });
  const text = groundedText(answer.content, source, check);
  return { ...(text ? { text } : {}), source: "KI", models: [answer.use], prompt: systemPrompt(messages) };
}

// The system prompt the answer is written with, for the "Details" under it; it holds no facts, only rules and voice.
const systemPrompt = (messages: ChatMessage[]) => (messages[0]?.role === "system" ? messages[0].content : "").slice(0, MAX_PROMPT_PREVIEW);

/** `prompt` comes first, `model` names the model as soon as it accepted the question, before the first word. */
export type AnswerEvent = { prompt: string } | { model: ModelUse } | { delta: string } | { replace: string } | { done: true; ok: boolean; text?: string };

// Finished sentences that are backed, plus the whole words of the sentence being written while it is backed.
function partialProse(text: string, keep: (sentence: string) => boolean): string {
  // A trailing space marks the last word as complete.
  const flat = text.replace(/\s+/g, " ").trimStart();
  const parts = sentences(flat.slice(0, 1200));
  const open = /[.!?]$/.test(flat.trimEnd()) && /\s$/.test(flat) ? "" : parts.pop() ?? "";
  const done = parts.flatMap((sentence) => backedPart(sentence, keep) ?? []);
  const words = open.slice(0, Math.max(0, open.lastIndexOf(" ")));
  const shown = words ? backedPart(words, keep, false) : undefined;
  if (shown) done.push(shown);
  return done.join(" ");
}

const LINE_MARKER = /^(\s*(?:#{1,6}\s+|[-*+•]\s+|\d{1,3}[.)]\s+|>\s?))/;

/**
 * Text that may already be shown while the answer streams: the finished lines as Markdown, grounded like the final answer,
 * plus the backed words of the line being written. Table rows show once complete, a table once its header line is
 * followed by the separator, code line by line.
 */
export function visiblePrefix(content: string, source: object, check: (sentence: string, source: object) => boolean = backed): string {
  const raw = withoutHtml(content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/<[^>]*$/, ""));
  const text = dropOpener(raw.trimStart());
  if (text.startsWith("{")) return "";
  const keep = (sentence: string) => check(sentence, source);
  const cut = text.lastIndexOf("\n");
  const closed = cut >= 0 ? text.slice(0, cut) : "";
  const line = text.slice(cut + 1);
  const parsed = parseBlocks(closed);
  const shown = groundBlocks(parsed, keep, (code) => chatBacked(code, source))
    .filter((block) => !(block.type === "paragraph" && /^\s*\|/.test(block.text)));
  const before = blocksToMarkdown(shown);
  const inCode = parsed.at(-1)?.type === "code" && (parsed.at(-1) as { open?: boolean }).open;
  const marker = LINE_MARKER.exec(line)?.[1] ?? "";
  const words = inCode || /^\s*(?:\||`{3}|~{3})/.test(line) ? "" : partialProse(line.slice(marker.length), keep);
  const current = words ? `${marker.trimStart()}${words}` : "";
  if (!current) return before;
  if (!before) return current;
  return `${before}${/\n\s*\n$/.test(text.slice(0, cut + 1)) ? "\n\n" : "\n"}${current}`;
}

// Streams the free answer word by word; a sentence that turns out unbacked disappears again via a `replace` event.
export async function* streamFreeAnswer(input: AnswerRequest, options: AnswerOptions = {}): AsyncGenerator<AnswerEvent> {
  const { facts, evidence, source, check } = prepare(input);
  let content = "";
  let shown = "";
  const trace: ModelUse[] = [];
  let named = 0;
  const messages = answerMessages(input, facts, evidence, options.rules, options.prompts);
  yield { prompt: systemPrompt(messages) };
  for await (const piece of chatStream(messages, { task: answerTask({ ...input, facts }), ...answerOptions(input.agent, input.supervised), ...options, trace })) {
    while (named < trace.length) yield { model: trace[named++] };
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
