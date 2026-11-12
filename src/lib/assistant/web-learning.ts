import { contentWords } from "@/lib/knowledge-base/query";
import { MAX_ASSISTANT_KNOWLEDGE, type AssistantKnowledge, type AssistantMessage, type WebLinkEntry } from "@/lib/types";
import { searchTopicWords } from "@/lib/web/web-answer";
import { explicitWeb, foldText, ownData } from "./public-facts";

/** Tools on chat messages: an answer from the web search, an answer from confirmed knowledge, a question waiting for a correction. */
export const WEB_TOOL = "web";
export const LEARNED_TOOL = "learned";
export const WEB_FIX_TOOL = "web_fix";

export const isWebAnswer = (message: Pick<AssistantMessage, "tool">) => message.tool === WEB_TOOL || message.tool === LEARNED_TOOL;

/** "Das hat geholfen", "Danke, hilft mir weiter", "Super, danke!" right after a web answer count as 👍. */
export const helpedReply = (text: string) =>
  /^(?:(?:danke|merci|super|perfekt|top|toll|klasse)[,!.]*\s*)?(?:das |es )?(?:hat|hilft)(?: mir)?(?: (?:sehr|wirklich|echt|total))? (?:geholfen|weiter)\b[^?]*$|^(?:super|perfekt|top|toll|klasse|passt|stimmt|genau)[,!. ]*(?:danke(?: dir)?)?[!. ]*$/i
    .test(text.trim());

const words = (text: string) => new Set(contentWords(text).map((word) => word.replace(/(?:en|er|es|e|n|s)$/u, "")));

const sharedWords = (left: Set<string>, right: Set<string>) => [...left].filter((word) => right.has(word)).length;

/** How much two questions overlap: shared meaningful words over the shorter question. */
export function questionOverlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  return sharedWords(left, right) / Math.min(left.size, right.size);
}

/** How much of a new question an earlier one covers; extra words in the new question ("meine", "im Oktober") lower it. */
const coverage = (earlier: string, question: string) => {
  const asked = words(question);
  return asked.size ? sharedWords(asked, words(earlier)) / asked.size : 0;
};

/** "Such im Internet nochmal danach": a new search for the previous question, because the message names no topic of its own. */
export const searchesAgain = (text: string) => explicitWeb.test(foldText(text)) && !searchTopicWords(text).length;

const correctionWords = /\b(?:falsch|stimmt nicht|nicht richtig|nicht korrekt|veraltet|alt|gilt|galt|eigentlich|sondern|richtig (?:ist|wäre|waere)|korrekt|fehler|fehlt|fehlen|nicht mehr|seit|ab)\b/i;
const questionStart = /^(?:und\s+)?(?:wie|was|wann|wo|wer|warum|wieso|weshalb|welche\w*|gibt|gibt's|ist|sind|kann|kannst|könnte|soll|sollte|hab|habe|zeig\w*|such\w*)\b/i;
const acknowledgement = /^(?:danke\w*|merci|ok(?:ay)?|passt|alles klar|super|cool|gut|ja|nein|egal|schon gut)\b[\s!.,]*(?:danke\w*)?[\s!.]*$/i;

/** After 👎 on a web answer: whether the next message corrects it, rather than asking something new or just saying thanks. */
export const correctsAnswer = (text: string, question: string) => {
  const trimmed = text.trim();
  if (!trimmed || /\?\s*$/.test(trimmed) || questionStart.test(trimmed) || acknowledgement.test(trimmed)) return false;
  return correctionWords.test(trimmed) || questionOverlap(trimmed, question) >= 0.5;
};

const sameQuestion = (entry: AssistantKnowledge, question: string) => entry.kind === "web" && !!entry.question && questionOverlap(entry.question, question) >= 0.75;
const sites = (links: WebLinkEntry[] = []) => [...new Set(links.map((link) => new URL(link.url).hostname.replace(/^www\./, "")))].slice(0, 3).join(", ");

// `target`: the stored entry an answer came from (a recalled answer), so feedback reaches exactly that entry.
type WebAnswer = { id: string; question: string; text: string; links?: WebLinkEntry[]; now?: number; target?: string };

const entryFor = (entries: AssistantKnowledge[], answer: Pick<WebAnswer, "question" | "target">) =>
  (answer.target ? entries.find((entry) => entry.id === answer.target) : undefined) ?? entries.find((entry) => sameQuestion(entry, answer.question));

/** The id the feedback on this answer is stored under: the existing entry, or the new one. */
export const webEntryId = (entries: AssistantKnowledge[] = [], answer: Pick<WebAnswer, "id" | "question" | "target">) => entryFor(entries, answer)?.id ?? answer.id;

function fromAnswer(answer: WebAnswer, votes: number): AssistantKnowledge {
  const links = (answer.links ?? []).slice(0, 4);
  return {
    id: answer.id, kind: "web", topic: answer.question.slice(0, 100), title: answer.question.slice(0, 200), question: answer.question.slice(0, 500),
    text: answer.text.replace(/\s+/g, " ").trim().slice(0, 1500), url: links[0]?.url ?? "https://www.oesterreich.gv.at/",
    source: `Websuche · ${sites(links) || "bestätigt"}`.slice(0, 100), at: answer.now ?? Date.now(), votes, ...(links.length ? { links } : {}),
  };
}

// Confirmed answers and often used entries stay longest when the list is full.
const keepScore = (entry: AssistantKnowledge) => (entry.rejected ? -5 : 0) + (entry.votes ?? 0) * 3 + (entry.uses ?? 0);
function prune(entries: AssistantKnowledge[]) {
  if (entries.length <= MAX_ASSISTANT_KNOWLEDGE) return entries;
  const keep = new Set([...entries].sort((a, b) => keepScore(b) - keepScore(a) || b.at - a.at).slice(0, MAX_ASSISTANT_KNOWLEDGE).map((entry) => entry.id));
  return entries.filter((entry) => keep.has(entry.id));
}

/** 👍 on a web answer: stored as local knowledge, or one more vote when the same question was confirmed before. */
export function learnWebAnswer(entries: AssistantKnowledge[] = [], answer: WebAnswer): AssistantKnowledge[] {
  const existing = entryFor(entries, answer);
  if (!existing) return prune([...entries, fromAnswer(answer, 1)]);
  // The first wording of the question stays; it is what later questions are compared with.
  return entries.map((entry) => entry !== existing ? entry : {
    ...fromAnswer({ ...answer, id: entry.id, question: entry.question ?? answer.question, links: answer.links?.length ? answer.links : entry.links },
      Math.max(1, (entry.votes ?? 0) + 1)),
    ...(entry.uses ? { uses: entry.uses } : {}), ...(entry.note ? { note: entry.note } : {}),
  });
}

/** 👎 on a web answer: never suggested again; its sources are skipped by the next search on that question. */
export function rejectWebAnswer(entries: AssistantKnowledge[] = [], answer: WebAnswer): AssistantKnowledge[] {
  const existing = entryFor(entries, answer);
  if (!existing) return prune([...entries, { ...fromAnswer(answer, -1), rejected: true }]);
  return entries.map((entry) => entry !== existing ? entry : { ...entry, rejected: true, votes: Math.min(-1, (entry.votes ?? 0) - 1),
    links: [...(entry.links ?? []), ...(answer.links ?? [])].filter((link, index, list) => list.findIndex((item) => item.url === link.url) === index).slice(0, 4) });
}

/** The user's correction of a rejected answer; later answers on that topic take it into account. */
export function noteWebAnswer(entries: AssistantKnowledge[] = [], answer: Pick<WebAnswer, "question" | "target">, note: string): AssistantKnowledge[] {
  const clean = note.replace(/\s+/g, " ").trim().slice(0, 500);
  const target = entryFor(entries, answer);
  if (!clean || !target) return entries;
  return entries.map((entry) => entry === target ? { ...entry, note: clean } : entry);
}

export type LearnedCandidate = { id: string; question: string; text: string; votes: number; uses: number };

/** Confirmed web answers for the local knowledge search, most confirmed and most used first. */
export function learnedCandidates(entries: AssistantKnowledge[] = [], limit = 30): LearnedCandidate[] {
  return entries.filter((entry) => entry.kind === "web" && !entry.rejected && (entry.votes ?? 0) > 0)
    .sort((a, b) => keepScore(b) - keepScore(a) || b.at - a.at).slice(0, limit)
    .map((entry) => ({ id: entry.id, question: (entry.question ?? entry.title).slice(0, 300), text: entry.text.slice(0, 600), votes: entry.votes ?? 0, uses: entry.uses ?? 0 }));
}

/**
 * The confirmed answer to the same question in other words ("Geringfügigkeitsgrenze 2026 – wie viel ist das?" after
 * "Wie hoch ist die Geringfügigkeitsgrenze 2026?"): answered at once, before any routing, search or model.
 */
export function recallConfirmed(entries: AssistantKnowledge[] = [], question: string): AssistantKnowledge | undefined {
  // Questions about the user's own figures ("meine KESt im Oktober") are never answered with general knowledge.
  if (words(question).size < 2 || ownData.test(foldText(question))) return undefined;
  return entries.filter((entry) => entry.kind === "web" && !entry.rejected && (entry.votes ?? 0) > 0 && entry.question && words(entry.question).size >= 2)
    .map((entry) => ({ entry, overlap: coverage(entry.question!, question) }))
    .filter((item) => item.overlap >= 0.8)
    .sort((a, b) => b.overlap - a.overlap || keepScore(b.entry) - keepScore(a.entry))[0]?.entry;
}

/** Links of rejected answers to a similar question; the web search leaves them out. */
export function avoidedSources(entries: AssistantKnowledge[] = [], question: string): string[] {
  return [...new Set(entries.filter((entry) => entry.rejected && entry.question && questionOverlap(entry.question, question) >= 0.6)
    .flatMap((entry) => (entry.links ?? []).map((link) => link.url)))].slice(0, 10);
}

/** The user's corrections that concern this question. */
export function correctionNotes(entries: AssistantKnowledge[] = [], question: string): string[] {
  return entries.filter((entry) => entry.note && entry.question && questionOverlap(entry.question, question) >= 0.6).map((entry) => entry.note!).slice(0, 2);
}
