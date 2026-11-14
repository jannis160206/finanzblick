import { contentWords } from "@/lib/knowledge-base/query";
import { MAX_ASSISTANT_KNOWLEDGE, type AssistantKnowledge, type AssistantMessage, type WebLinkEntry } from "@/lib/types";
import { searchTopicWords } from "@/lib/web/web-answer";
import { isExpired, reusable, storableAnswer, volatility } from "./answer-memory";
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

const sameQuestion = (entry: AssistantKnowledge, question: string) =>
  (entry.kind === "web" || entry.kind === "answer") && !!entry.question && questionOverlap(entry.question, question) >= 0.75;
const sites = (links: WebLinkEntry[] = []) => [...new Set(links.map((link) => new URL(link.url).hostname.replace(/^www\./, "")))].slice(0, 3).join(", ");

// `target`: the stored entry an answer came from (a recalled answer), so feedback reaches exactly that entry.
// `kind`: a web search answer (with sources) or a general chat answer.
type WebAnswer = { id: string; question: string; text: string; links?: WebLinkEntry[]; now?: number; target?: string; kind?: "web" | "answer" };

const entryFor = (entries: AssistantKnowledge[], answer: Pick<WebAnswer, "question" | "target">) =>
  (answer.target ? entries.find((entry) => entry.id === answer.target) : undefined) ?? entries.find((entry) => sameQuestion(entry, answer.question));

/** The id the feedback on this answer is stored under: the existing entry, or the new one. */
export const webEntryId = (entries: AssistantKnowledge[] = [], answer: Pick<WebAnswer, "id" | "question" | "target">) => entryFor(entries, answer)?.id ?? answer.id;

function fromAnswer(answer: WebAnswer, votes: number): AssistantKnowledge {
  const links = (answer.links ?? []).slice(0, 4);
  const web = (answer.kind ?? "web") === "web";
  return {
    id: answer.id, kind: web ? "web" : "answer", topic: answer.question.slice(0, 100), title: answer.question.slice(0, 200), question: answer.question.slice(0, 500),
    text: answer.text.replace(/\s+/g, " ").trim().slice(0, 1500), ...(web ? { url: links[0]?.url ?? "https://www.oesterreich.gv.at/" } : {}),
    source: (web ? `Websuche · ${sites(links) || "bestätigt"}` : "Chat-Antwort").slice(0, 100), at: answer.now ?? Date.now(), votes, ...(links.length ? { links } : {}),
  };
}

// Confirmed answers and often used entries stay longest when the list is full; expired ones go first.
const keepScore = (entry: AssistantKnowledge) => (entry.rejected ? -5 : 0) + (entry.votes ?? 0) * 3 + (entry.uses ?? 0);
function prune(entries: AssistantKnowledge[], now = Date.now()) {
  const current = entries.filter((entry) => !isExpired(entry, now));
  if (current.length <= MAX_ASSISTANT_KNOWLEDGE) return current;
  const keep = new Set([...current].sort((a, b) => keepScore(b) - keepScore(a) || b.at - a.at).slice(0, MAX_ASSISTANT_KNOWLEDGE).map((entry) => entry.id));
  return current.filter((entry) => keep.has(entry.id));
}

/**
 * Every general answer is kept as local knowledge right away (votes 0), so the next similar question is answered
 * locally first. Answers about changing facts get an expiry, news and quotes are not kept, and nothing personal.
 * Returns the id the answer is stored under, so 👍/👎 reach it.
 */
export function rememberAnswer(entries: AssistantKnowledge[] = [], answer: WebAnswer & { kind: "web" | "answer" }): { entries: AssistantKnowledge[]; id?: string } {
  const now = answer.now ?? Date.now();
  const verdict = volatility(answer.question, answer.text, now);
  if (verdict.kind === "never" || !storableAnswer(answer.question, answer.text)) return { entries };
  const expiry = verdict.kind === "expires" ? { expiresAt: verdict.expiresAt } : {};
  const existing = entryFor(entries, answer);
  if (!existing) return { entries: prune([...entries, { ...fromAnswer({ ...answer, now }, 0), ...expiry }], now), id: answer.id };
  // A rejected answer keeps steering (skipped sources, the user's note) until a 👍 revives it; it is not overwritten silently.
  if (existing.rejected) return { entries };
  // A newer answer to the same question replaces the text; votes, uses and notes stay.
  const { expiresAt: _old, ...rest } = existing;
  const updated: AssistantKnowledge = { ...rest, ...fromAnswer({ ...answer, id: existing.id, question: existing.question ?? answer.question, now,
    links: answer.links?.length ? answer.links : existing.links }, Math.max(0, existing.votes ?? 0)), ...expiry,
    ...(existing.uses ? { uses: existing.uses } : {}), ...(existing.note ? { note: existing.note } : {}) };
  return { entries: prune(entries.map((entry) => entry === existing ? updated : entry), now), id: existing.id };
}

/** 👍 moves a stored chat answer up; 👎 rejects it, so it is never suggested again. */
export function rateStoredAnswer(entries: AssistantKnowledge[] = [], id: string, value: "up" | "down"): AssistantKnowledge[] {
  return entries.map((entry) => {
    if (entry.id !== id) return entry;
    const { rejected: _rejected, ...rest } = entry;
    return value === "up" ? { ...rest, votes: Math.max(1, (entry.votes ?? 0) + 1) } : { ...rest, rejected: true, votes: Math.min(-1, (entry.votes ?? 0) - 1) };
  });
}

/** 👍 on a web answer: stored as local knowledge, or one more vote when the same question was confirmed before. */
export function learnWebAnswer(entries: AssistantKnowledge[] = [], answer: WebAnswer): AssistantKnowledge[] {
  const existing = entryFor(entries, answer);
  if (!existing) return prune([...entries, fromAnswer(answer, 1)]);
  // The first wording of the question stays; it is what later questions are compared with. A stored chat answer stays one,
  // and a fact that changes keeps its expiry.
  return entries.map((entry) => entry !== existing ? entry : {
    ...fromAnswer({ ...answer, id: entry.id, question: entry.question ?? answer.question, links: answer.links?.length ? answer.links : entry.links,
      kind: entry.kind === "answer" ? "answer" : "web" }, Math.max(1, (entry.votes ?? 0) + 1)),
    ...(entry.uses ? { uses: entry.uses } : {}), ...(entry.note ? { note: entry.note } : {}), ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
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

/** Stored web and chat answers for the local knowledge search: confirmed and often used ones first, never expired or rejected ones. */
export function learnedCandidates(entries: AssistantKnowledge[] = [], limit = 60, now = Date.now()): LearnedCandidate[] {
  return entries.filter((entry) => reusable(entry, now) && (entry.votes ?? 0) >= 0)
    .sort((a, b) => keepScore(b) - keepScore(a) || b.at - a.at).slice(0, limit)
    .map((entry) => ({ id: entry.id, question: (entry.question ?? entry.title).slice(0, 300), text: entry.text.slice(0, 600), votes: entry.votes ?? 0, uses: entry.uses ?? 0 }));
}

/**
 * The confirmed answer to the same question in other words ("Geringfügigkeitsgrenze 2026 – wie viel ist das?" after
 * "Wie hoch ist die Geringfügigkeitsgrenze 2026?"): answered at once, before any routing, search or model.
 */
export function recallConfirmed(entries: AssistantKnowledge[] = [], question: string, now = Date.now()): AssistantKnowledge | undefined {
  // Questions about the user's own figures ("meine KESt im Oktober") are never answered with general knowledge.
  if (words(question).size < 2 || ownData.test(foldText(question))) return undefined;
  // A confirmed answer covers rephrasings; an answer nobody rated yet only the same question, read both ways.
  return entries.filter((entry) => reusable(entry, now) && (entry.votes ?? 0) >= 0 && words(entry.question!).size >= 2)
    .map((entry) => ({ entry, overlap: (entry.votes ?? 0) > 0 ? coverage(entry.question!, question)
      : Math.min(coverage(entry.question!, question), coverage(question, entry.question!)) }))
    .filter((item) => item.overlap >= ((item.entry.votes ?? 0) > 0 ? 0.8 : 0.85))
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
