import { adviceQuestion, changingTools } from "./conversation";
import { normalizeMessage, stripAck } from "./normalize";
import { detectTool, splitCommands, type AssistantTool } from "./tools";

/**
 * Two questions in one message ("Wie viel hab ich im Oktober fürs Essen ausgegeben und was bleibt mir diesen Monat?")
 * are answered one after the other, each by its own agent. No part may change data, and a part that only refers back
 * ("… und wie wirkt sich das aufs Motorrad aus?") keeps the message whole, because one answer covers both.
 */
export type QuestionPart = { text: string; tool?: AssistantTool };

const questionWord = String.raw`(?:was|wie|wann|wo|wofür|wohin|welche[rsmn]?|kann|könnte|soll|sollte|ist|sind|gibt|zeig\w*|warum|wieso|weshalb|reicht|lohnt|bin|hab|habe)`;
const andQuestion = new RegExp(String.raw`\s(?:und|sowie)\s+(?=${questionWord}\b)`, "i");
// Pronouns pointing at the first part ("… und was kosten sie im Jahr?"): one answer covers both. "das Gehalt" is an article.
const pointers = new Set(["das", "es", "sie", "ihn", "davon", "dafür", "dafuer", "damit", "dort", "denen", "dessen", "deren", "dies", "dieses"]);
const refersBack = (part: string) => {
  const words = part.split(/\s+/).slice(0, 6);
  return words.some((word, index) => pointers.has(word.toLowerCase().replace(/[^\p{L}]/gu, "")) && !/^\p{Lu}/u.test(words[index + 1] ?? ""));
};

const clean = (part: string) => part.trim().replace(/^[,;–—-]+\s*/, "").replace(/\s*[,;–—-]+$/, "").trim();

function candidates(text: string): string[] | undefined {
  const sentences = text.split(/(?<=\?)\s+/).map(clean).filter(Boolean);
  if (sentences.length >= 2) return sentences;
  // "Mein Bonus und meine Abos – was bleibt übrig?"
  const shared = /^(.{2,60}?)\s+und\s+(.{2,60}?)\s*[–—:-]\s*(.{4,80}\?)$/.exec(text);
  if (shared && !/\?/.test(shared[1] + shared[2])) return [`${shared[1]} – ${shared[3]}`, `${shared[2]} – ${shared[3]}`];
  const split = andQuestion.exec(text);
  if (split) return [text.slice(0, split.index), text.slice(split.index + split[0].length)].map(clean);
  // "Zeig mir meine Kontostände und meine Sparziele"
  const show = /^(zeig\w*(?:\s+mir)?)\s+(.{3,50}?)\s+und\s+(.{3,50}?)[.!?]*$/i.exec(text);
  if (show) return [`${show[1]} ${show[2]}`, `${show[1]} ${show[3]}`];
  // "Wie viel hab ich bei Billa und bei Spar ausgegeben?"
  const pair = /^(.*?\b(?:bei|beim|für|fürs|fuer)\s+)([\p{L}\d&.'-]{2,30})\s+und\s+(?:(?:bei|beim|für|fürs|fuer)\s+)?([\p{L}\d&.'-]{2,30})(\s+[^,]*)?$/iu.exec(text);
  if (pair && pair[4]) return [`${pair[1]}${pair[2]}${pair[4]}`, `${pair[1]}${pair[3]}${pair[4]}`];
  return undefined;
}

export function splitQuestion(input: string, names: string[] = []): QuestionPart[] | undefined {
  // "Danke! Und was ist ein ETF?" is one question after the thanks.
  const text = stripAck(normalizeMessage(input).trim());
  if (text.length < 15 || text.length > 300 || splitCommands(text, names)) return undefined;
  const parts = candidates(text);
  if (!parts || parts.length < 2 || parts.length > 3 || parts.some((part) => part.length < 4)) return undefined;
  // "… und wann kommt es?" after "mein Gehalt": the pronoun stands for that noun, so the part can stand alone.
  const subject = /\b(mein(?:e)?)\s+(\p{Lu}\p{L}{2,})/u.exec(parts[0]);
  if (subject) for (const [index, part] of parts.entries())
    if (index && refersBack(part)) parts[index] = part.replace(/^((?:\S+\s+){0,3}?)(?:es|er|sie)\b/i, `$1${subject[1]} ${subject[2]}`);
  if (parts.slice(1).some(refersBack)) return undefined;
  // Advice ("… und soll ich in einen investieren?") is answered in words, never by a calculator asking for amounts.
  const resolved = parts.map((part) => ({ text: part, tool: adviceQuestion(part) ? undefined : detectTool(part, names) }));
  if (resolved.some((part) => part.tool && changingTools.includes(part.tool))) return undefined;
  // At least one part needs a tool, and at most one may be left to a written answer.
  if (resolved.filter((part) => part.tool).length < Math.max(1, resolved.length - 1)) return undefined;
  // The same tool twice only makes sense when the parts differ ("bei Billa" / "bei Spar").
  if (new Set(resolved.map((part) => part.tool ?? part.text)).size < resolved.length && new Set(parts).size < parts.length) return undefined;
  return resolved;
}
