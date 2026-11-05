import type { AssistantAlias, AssistantGap, AssistantPhrase } from "@/lib/types";
import { MAX_ASSISTANT_ALIASES, MAX_ASSISTANT_GAPS } from "@/lib/types";
import { phrasePattern } from "./knowledge";

const fold = (value: string) => value.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, " ").trim();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unquote = (value: string) => value.replace(/^[\s„"'»«]+|[\s“"'»«.!?,]+$/g, "").trim();

// "Nein, ich meinte meine Ausgaben im Oktober", "Ich meinte eigentlich das Pickerl", "Falsch, ich wollte wissen …".
// An empty text means a plain "Nein, das meinte ich nicht".
export function correction(input: string): { text: string } | undefined {
  const value = input.trim();
  const lead = /^(?:nein|nö|noe|nee|ne|falsch|stimmt nicht|passt nicht|nicht das|nicht so)\b[\s,.!:–-]*/i;
  const meant = /^(?:(?:ich\s+)?(?:meinte|meine(?! ich nicht)|wollte|hab(?:e)?\s+(?:eigentlich\s+)?gemeint)|gemeint war|eigentlich)\b[\s,:]*(?:eigentlich\b[\s,:]*)?(?:wissen|fragen)?[\s,:]*/i;
  const rest = value.replace(lead, "");
  const hadLead = rest !== value;
  if (meant.test(rest)) {
    const text = unquote(rest.replace(meant, ""));
    if (text.length >= 2 && !/^(?:das|es|dich|nicht(?: so)?|anders)$/i.test(text)) return { text };
    return { text: "" };
  }
  if (hadLead && /^(?:(?:das|so)\s+(?:meinte|wollte|meine)\s+ich\s+(?:nicht|anders)|das\s+(?:ist|war)\s+(?:falsch|nicht richtig|nicht das)|)[\s.!]*$/i.test(rest)) return { text: "" };
  if (/^das\s+(?:meinte|wollte)\s+ich\s+(?:nicht|anders)|^das\s+(?:ist|war)\s+(?:falsch|nicht das,? was ich (?:wollte|meinte))|^du hast mich falsch verstanden/i.test(value)) return { text: "" };
  return undefined;
}

// "Mit Japan meine ich Motorrad", "Wenn ich Auto sage, meine ich Motorrad", "Unter Urlaub verstehe ich Japan".
export function aliasTeaching(input: string): { from: string; to: string } | undefined {
  const patterns = [
    /^(?:und\s+)?(?:mit|unter)\s+(.+?)\s+(?:meine|verstehe)\s+ich\s+(?:immer\s+)?(?:das\s+|den\s+|die\s+|mein(?:e|en)?\s+)?(.+)$/i,
    /^(?:und\s+)?wenn\s+ich\s+(.+?)\s+(?:sage|sag|schreibe|schreib)\s*,?\s+meine\s+ich\s+(?:immer\s+)?(?:das\s+|den\s+|die\s+|mein(?:e|en)?\s+)?(.+)$/i,
    /^(?:und\s+)?(.+?)\s+(?:ist|heißt|heisst)\s+(?:bei mir|für mich)\s+(?:immer\s+)?(?:das gleiche wie|dasselbe wie|gleich)\s+(?:das\s+|den\s+|die\s+|mein(?:e|en)?\s+)?(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(input.trim());
    if (!match) continue;
    const from = unquote(match[1]), to = unquote(match[2]).replace(/\s+(?:ziel|sparziel)$/i, "");
    if (from.length < 2 || from.length > 60 || to.length < 1 || to.length > 100 || /\d/.test(from) || from.split(/\s+/).length > 4 || fold(from) === fold(to)) return undefined;
    return { from, to };
  }
  return undefined;
}

// Replaces the user's own words with the real names before anything else reads the message.
export function applyAliases(aliases: AssistantAlias[] = [], input: string): { text: string; used: string[] } {
  let text = input;
  const used: string[] = [];
  for (const alias of [...aliases].sort((a, b) => b.from.length - a.from.length)) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(alias.from)}(?![\\p{L}\\p{N}])`, "giu");
    if (!pattern.test(text) || fold(text).includes(fold(alias.to))) continue;
    text = text.replace(pattern, alias.to);
    used.push(alias.from);
  }
  return { text, used };
}

export function learnAlias(aliases: AssistantAlias[] = [], from: string, to: string, now = Date.now()): AssistantAlias[] {
  return [...aliases.filter((alias) => fold(alias.from) !== fold(from)), { from: from.slice(0, 60), to: to.slice(0, 100), at: now }].slice(-MAX_ASSISTANT_ALIASES);
}
export const countAliases = (aliases: AssistantAlias[] = [], used: string[]) =>
  aliases.map((alias) => used.includes(alias.from) ? { ...alias, hits: (alias.hits ?? 0) + 1 } : alias);

const notNames = new Set(["sparkonto", "giro", "girokonto", "raphael", "euro", "eur", "notgroschen", "urlaub", "ich", "du", "bitte", "ziel", "sparziel", "rate",
  "sparrate", "ausgabe", "ausgaben", "monat", "monate", "monatsplan", "plan", "planung", "buchung", "buchungen", "fixkosten", "januar", "jaenner", "februar",
  "feber", "maerz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember", "jahr", "woche", "betrag", "extra"]);

// The one word in a command that is no known name, e.g. "Japan" in "Erhöhe Japan auf 4.000 €".
export function unknownTarget(text: string, names: string[]): string | undefined {
  const known = names.map(fold).filter(Boolean);
  const candidates = new Set<string>();
  for (const sentence of text.split(/[.;!?]\s+|\s+(?:und|dann)\s+/i)) {
    const words = sentence.trim().match(/\p{L}[\p{L}\p{N}-]*/gu) ?? [];
    words.slice(1).forEach((word) => {
      const plain = fold(word);
      if (word.length >= 3 && /^\p{Lu}/u.test(word) && !notNames.has(plain) && !known.some((name) => name === plain || name.split(" ").includes(plain))) candidates.add(word);
    });
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

// A short answer to "Welches meinst du?" that names exactly one of the choices.
export function pickName(input: string, names: string[]): string | undefined {
  const plain = fold(input).split(" ").filter((word) => !/^(?:das|den|die|dem|ziel|sparziel|ausgabe|ich|meine|meinte|nimm|bitte|natuerlich|klar|na|ja|von|vom|mein|meinen)$/.test(word)).join(" ");
  const exact = names.find((name) => fold(name) === plain);
  if (exact) return exact;
  if (input.trim().split(/\s+/).length > 5) return undefined;
  const hits = names.filter((name) => fold(name) && ` ${fold(input)} `.includes(` ${fold(name)} `));
  return hits.length === 1 ? hits[0] : undefined;
}

export const unlearnPhrase = (phrases: AssistantPhrase[] = [], input: string) => {
  const pattern = phrasePattern(input);
  return phrases.filter((phrase) => phrase.pattern !== pattern);
};

// Requests it could not handle; the same wording counts up instead of piling up.
export function recordGap(gaps: AssistantGap[] = [], input: string, now = Date.now()): AssistantGap[] {
  const text = input.trim().slice(0, 300);
  if (!text) return gaps;
  const key = phrasePattern(text);
  const existing = gaps.find((gap) => phrasePattern(gap.text) === key);
  if (existing) return gaps.map((gap) => gap === existing ? { text, at: now, count: Math.min(gap.count + 1, 10_000) } : gap);
  const next = [...gaps, { text, at: now, count: 1 }];
  if (next.length <= MAX_ASSISTANT_GAPS) return next;
  const drop = next.find((gap) => gap.resolved) ?? next[0];
  return next.filter((gap) => gap !== drop);
}
export function resolveGap(gaps: AssistantGap[] = [], input: string, tool: string): AssistantGap[] {
  const key = phrasePattern(input);
  return gaps.map((gap) => !gap.resolved && phrasePattern(gap.text) === key ? { ...gap, resolved: tool.slice(0, 40) } : gap);
}
export const openGaps = (gaps: AssistantGap[] = []) => gaps.filter((gap) => !gap.resolved).sort((a, b) => b.count - a.count || b.at - a.at);
