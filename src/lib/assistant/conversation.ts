import { currency } from "@/lib/format";
import { draftTools, type AssistantTool } from "./tools";
import type { AgentResult } from "./agent";

// Tools that change data or start a form; never run as a side effect of a question like "Sollte ich …?".
export const changingTools: readonly AssistantTool[] = [...draftTools, "edit", "booking", "batch", "rule", "remember", "forget", "undo", "reminder"];

// Questions asking for an explanation, an opinion, advice or a summary want a written answer, not just a number card.
const CONVERSATIONAL = new RegExp([
  String.raw`^(?:und\s+)?(?:warum|wieso|weshalb|wie\s+kommt|woran\s+liegt|woher\s+kommt)\b`,
  String.raw`\b(?:sollte|soll|sollen|müsste|muss)\s+ich\b`,
  String.raw`\blohnt\s+(?:es\s+)?sich\b`,
  String.raw`\b(?:was|wie)\s+(?:denkst|meinst|findest|würdest|siehst|rätst|empfiehlst)\s+du\b`,
  String.raw`\bwas\s+(?:soll|kann|könnte|würde|mach|tu)e?\s+ich\b`,
  String.raw`\b(?:rat|ratschlag|ratschläge|tipps?|empfehlung\w*|vorschl[aä]g\w*|idee\w*)\b`,
  String.raw`\bfass\w*\b.*\bzusammen\b|\bzusammenfass\w*|\büberblick\b|\bin\s+\w+\s+sätzen\b`,
  String.raw`\b(?:erklär|beschreib)\w*\b`,
  String.raw`\b(?:gestresst|stress|sorgen|angst|überfordert|panik|pleite|verzweifelt|frustriert)\b`,
  String.raw`\bist\s+(?:das|es|der|die)\b.*\b(?:normal|schlimm|okay|ok|gut|schlecht|zu\s+viel|zu\s+hoch|zu\s+teuer|vernünftig|sinnvoll)\b`,
  String.raw`\b(?:bin|stehe)\s+ich\b.*\b(?:gut|schlecht|sparsam|verschwenderisch|normal|auf\s+kurs|im\s+plan)\b`,
  String.raw`\bwas\s+(?:passiert|würde\s+passieren|wäre|ändert\s+sich)\b.*\bwenn\b`,
  String.raw`\bzu\s+(?:teuer|hoch|viel)\b`,
  String.raw`\bwie\s+(?:kann|könnte)\s+ich\b`,
].join("|"), "i");

export const conversationalQuestion = (text: string) => CONVERSATIONAL.test(text.trim().toLowerCase());

// A question rather than a command: "Wann bin ich pleite?", "Kommt noch was Großes?".
export const isQuestion = (text: string) => /\?\s*$/.test(text) ||
  /^(?:und\s+)?(?:wie|was|wann|wo|wofür|wohin|woher|warum|wieso|weshalb|welche[rsmn]?|wer|ist|sind|hab|habe|hat|kann|könnte|bin|soll|sollte|gibt|kommt|reicht|darf|lohnt|muss)\b/i.test(text.trim());

// Questions the computed facts answer (duplicates, top category, year so far, price increases), not a single booking search.
const FACT_QUESTION = /\b(?:doppelt|zweimal\s+(?:bezahlt|abgebucht|belastet)|(?:am|das)\s+meiste\w*|teuerste\w*\s+kategorie|größte\w*\s+(?:kategorie|posten)|seit\s+(?:jahresbeginn|jahresanfang|jänner|januar|neujahr)|teurer\s+geworden|preiserhöhung\w*|preise?\s+(?:gestiegen|erhöht))\b/i;
export const factQuestion = (text: string) => FACT_QUESTION.test(text);

export type Route = { tool?: AssistantTool; converse: boolean; skipDraft: boolean };

// Decides whether a tool's card is enough or the model should also answer in its own words.
// `ruleTool` is what the fixed rules recognised; anything else was the model's guess.
export function conversationRoute(input: { text: string; tool?: AssistantTool; ruleTool?: AssistantTool; draftAction?: AssistantTool; numbers: number[]; pending: boolean }): Route {
  const { text, tool, ruleTool, draftAction, numbers, pending } = input;
  if (pending) return { tool, converse: false, skipDraft: false };
  const conversational = conversationalQuestion(text);
  const question = isQuestion(text);
  const guessed = !!tool && tool !== ruleTool;
  // "Sollte ich den Notgroschen erhöhen?" or "Wieso ist Revolut auf 0?" must not open an edit.
  if (tool && changingTools.includes(tool) && (conversational || (guessed && question))) return { converse: true, skipDraft: true };
  // Forms the model started for a question without any amount ("Wann bin ich pleite?") are answered instead.
  if ((!tool || tool === "query") && factQuestion(text)) return { converse: true, skipDraft: true };
  // "Wie viel zahl ich für Versicherungen?" is a question, not a new planned expense.
  const skipDraft = !!draftAction && (draftAction !== ruleTool || draftAction === "expense") && question && !numbers.length;
  if (!tool) return { converse: skipDraft, skipDraft };
  return { tool, converse: conversational || guessed, skipDraft: false };
}

// The tool's own result, as plain text the model may quote; amounts are written out so they count as backed.
export function evidenceText(result: AgentResult, max = 1200): string {
  const parts = [result.text];
  const card = result.card;
  if (card) {
    parts.push(card.title + (card.total !== undefined ? `: ${currency(card.total)}` : ""));
    for (const line of card.lines) parts.push(`${line.label}${line.value !== undefined ? `: ${currency(line.value)}` : ""}${line.detail ? ` (${line.detail})` : ""}`);
    if (card.note) parts.push(card.note);
  }
  const text = parts.join("\n").replace(/[ \t]+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
