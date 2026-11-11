import { normalizeMessage } from "./normalize";
import { detectTool, type AssistantTool } from "./tools";

const followUpStart = /^(?:und|u\.|(?:was|welche[rsn]?|wer|wie viel) davon|davon|darunter|was ist mit|wie (?:ist|schaut|sieht) es (?:mit|im|in|bei)|wie schauts? (?:mit|im|bei)|dasselbe|das gleiche|gleiche frage|selbe frage|jetzt|nur|aber|mehr oder weniger|(?:mehr|weniger) als|im vergleich|verglichen)\b/;
const whyMuch = /^(?:warum|wieso|weshalb)\b.*\bso\s+(?:viel|hoch|teuer)|^woher kommt (?:das|der betrag)/;
const followUpTools = new Set<AssistantTool>(["query", "budget", "accounts", "amex", "contracts"]);

// Short add-on questions such as "und im September?", "und mit Revolut?", "warum so viel?".
export function isFollowUp(input: string): boolean {
  const lower = normalizeMessage(input).toLowerCase().trim();
  if (!lower || lower.length > 80 || /\d+(?:[.,]\d+)?\s*(?:€|euro)/.test(lower)) return false;
  return followUpStart.test(lower) || whyMuch.test(lower);
}

// Finds the question a follow-up refers to: the latest user message that ran a data tool, plus the follow-ups in between.
export function followUpBase(userTexts: string[], names: string[] = []): { tool: AssistantTool; previous: string[] } | undefined {
  const previous: string[] = [];
  let fallback: AssistantTool | undefined;
  for (let index = userTexts.length - 1; index >= 0 && previous.length < 6; index -= 1) {
    const text = userTexts[index];
    const tool = detectTool(text, names);
    const data = tool && followUpTools.has(tool) ? tool : undefined;
    if (isFollowUp(text)) {
      // "Mehr als im Vormonat?" is a query on its own, but its scope still comes from the question before.
      previous.push(text);
      fallback ??= data;
      continue;
    }
    if (data) return { tool: data, previous: [...previous, text] };
    break;
  }
  return fallback ? { tool: fallback, previous } : undefined;
}

const listTitles = /^(?:verträge & abos|abos|versicherungen|kündigungsfristen|preiserhöhungen|kündbare verträge & abos|passende verträge)$/i;
/** "Kündige das" after an answer about one contract names that contract. */
export function resolvePronoun(input: string, last?: { kind: string; title: string }): string {
  if (!last || (last.kind !== "contracts" && last.kind !== "cancel")) return input;
  const name = last.title.replace(/^Kündigungshilfe · /, "").trim();
  if (!name || listTitles.test(name)) return input;
  const pattern = /^(kündig\w*|storniere?|beende)\s+(?:das|den|die|es|ihn|dieses?|diesen)\b|\b(?:das|den|es|ihn) (?=kündigen\b)/i;
  return pattern.test(input.trim()) ? input.trim().replace(/\b(?:das|den|die|es|ihn|dieses?|diesen)\b(?= kündigen\b|\s*[.!?]*$)/i, name) : input;
}

// Decides whether a message should run as a follow-up of the earlier question instead of going to the model.
export function resolveFollowUp(input: string, userTexts: string[], names: string[] = []): { tool: AssistantTool; previous: string[] } | undefined {
  if (!isFollowUp(input)) return undefined;
  const base = followUpBase(userTexts, names);
  if (!base) return undefined;
  const own = detectTool(input, names);
  // "und mit Amex?" after a spending question stays a spending question, filtered by the card.
  if (base.tool === "query") return !own || own === "query" || own === "amex" || own === "accounts" ? { tool: "query", previous: base.previous } : undefined;
  // "Was davon ist am teuersten?" after "Welche Abos habe ich?" stays with the contracts.
  if (base.tool === "contracts") return !own || own === "query" || own === "contracts" ? base : undefined;
  return !own || own === base.tool ? base : undefined;
}
