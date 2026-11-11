import { currency } from "@/lib/format";
import { budgetLinesIn } from "./budget-plan";
import { draftTools, type AssistantTool } from "./tools";
import type { AgentResult } from "./agent";

// Tools that change data or start a form; never run as a side effect of a question like "Sollte ich …?".
export const changingTools: readonly AssistantTool[] = [...draftTools, "edit", "booking", "batch", "rule", "remember", "forget", "undo", "reminder", "account_rule", "budget_plan"];

// Opinions, advice and worries want a written answer, not just a number card.
const ADVICE = new RegExp([
  String.raw`\b(?:sollte|soll|sollen|müsste|muss)\s+ich\b`,
  String.raw`\blohnt\s+(?:es\s+)?sich\b`,
  String.raw`\b(?:was|wie)\s+(?:denkst|meinst|findest|würdest|siehst|rätst|empfiehlst)\s+du\b`,
  String.raw`\bwas\s+(?:soll|kann|könnte|würde|mach|tu)e?\s+ich\b`,
  String.raw`\b(?:rat|ratschlag|ratschläge|tipps?|empfehlung\w*|vorschl[aä]g\w*|idee\w*)\b`,
  String.raw`\b(?:gestresst|stress|sorgen|angst|überfordert|panik|pleite|verzweifelt|frustriert)\b`,
  String.raw`\bist\s+(?:das|es|der|die)\b.*\b(?:normal|schlimm|okay|ok|gut|schlecht|zu\s+viel|zu\s+hoch|zu\s+teuer|vernünftig|sinnvoll)\b`,
  String.raw`\b(?:bin|stehe)\s+ich\b.*\b(?:gut|schlecht|sparsam|verschwenderisch|normal|auf\s+kurs|im\s+plan)\b`,
  String.raw`\bwas\s+(?:passiert|würde\s+passieren|wäre|ändert\s+sich)\b.*\bwenn\b`,
  String.raw`\bzu\s+(?:teuer|hoch|viel)\b`,
  String.raw`\bwie\s+(?:kann|könnte)\s+ich\b`,
].join("|"), "i");
// Explanations and summaries also want words, unless the tool's own text already is that explanation or summary.
const EXPLAIN = new RegExp([
  String.raw`^(?:und\s+)?(?:warum|wieso|weshalb|wie\s+kommt|woran\s+liegt|woher\s+kommt)\b`,
  String.raw`\bfass\w*\b.*\bzusammen\b|\bzusammenfass\w*|überblick\b|\bin\s+\w+\s+sätzen\b`,
  String.raw`\b(?:erklär|beschreib)\w*\b`,
].join("|"), "i");

export const adviceQuestion = (text: string) => ADVICE.test(text.trim().toLowerCase());
export const conversationalQuestion = (text: string) => adviceQuestion(text) || EXPLAIN.test(text.trim().toLowerCase());

// Summaries, explanations, scenarios and the payroll specialist already answer in finished sentences; the model only rephrases them for advice.
const selfAnswering: readonly AssistantTool[] = ["briefing", "month_review", "review", "insights", "security", "context", "check", "pulse", "payroll", "why", "whatif"];
// The general chat's tools (knowledge, market, help …) return text worth phrasing even without a card.
const textTools: readonly AssistantTool[] = ["knowledge", "market", "explain", "help", "memory", "changes"];

/**
 * Whether the model should put a tool's result into its own words. Empty results keep the tool's honest "no data" text;
 * a tool the model only guessed always gets words, since its own text may not answer the actual question.
 */
export function converseOn(tool: AssistantTool, result: AgentResult, text: string, guessed = false): boolean {
  if (selfAnswering.includes(tool) && !adviceQuestion(text) && !guessed) return false;
  if (textTools.includes(tool)) return true;
  const card = result.card;
  return !!card && (card.lines.length > 0 || !!card.total || !!card.whatif || !!card.chart);
}

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
  // Advice about one budget line ("Sollte ich das Lebensmittelbudget erhöhen?") is answered from that line's pace instead.
  if (tool && changingTools.includes(tool) && (conversational || (guessed && question)))
    return tool === "budget_plan" && adviceQuestion(text) && budgetLinesIn(text.toLowerCase()).length === 1
      ? { tool: "budget", converse: false, skipDraft: false } : { converse: true, skipDraft: true };
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
