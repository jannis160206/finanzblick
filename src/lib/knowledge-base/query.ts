import type { AssistantCard } from "@/lib/types";
import type { KnowledgeChunk, KnowledgeTopic, LearnedKnowledge, LocalKnowledgeHit } from "./types";

/** Small models answer worse with more context: at most three short chunks go into an answer. */
export const MAX_KNOWLEDGE_HITS = 3;
// Cosine distances of Qwen3-Embedding-0.6B (512 dims) on the evaluation questions: answering chunks lie below ~0.5,
// unrelated ones above ~0.6. A chunk counts when it is close enough; a direct answer needs a clearly close one.
export const VECTOR_MATCH = 0.56;
export const VECTOR_STRONG = 0.45;
// Hits far behind the best one only dilute the context.
const SPREAD = 0.14;
const RRF_K = 60;

export const EMBEDDING_QUERY_PREFIX = "Instruct: Given a question about personal finance, retrieve the passage that answers it\nQuery: ";

const stopwords = new Set([
  "aber", "alle", "allem", "als", "also", "auch", "auf", "aus", "bei", "beim", "bin", "bis", "bitte", "da", "damit", "dann", "das", "dass", "dein", "deine",
  "dem", "den", "denn", "der", "des", "die", "dies", "diese", "dir", "doch", "dort", "du", "durch", "ein", "eine", "einem", "einen", "einer", "eines",
  "eigentlich", "erklär", "erkläre", "erklären", "es", "etwa", "etwas", "euch", "für", "fürs", "gibt", "gut", "habe", "haben", "hat", "hier", "ich",
  "ihr", "im", "immer", "in", "ins", "ist", "ja", "jetzt", "kann", "kannst", "kein", "keine", "können", "lohnt", "lohnen", "mal", "man", "mehr",
  "mein", "meine", "meinen", "meiner", "mich", "mir", "mit", "muss", "nach", "nicht", "noch", "nur", "oder", "ohne", "schon", "sehr", "sich", "sie",
  "sind", "soll", "sollte", "sollten", "über", "um", "und", "uns", "unter", "viel", "viele", "vom", "von", "vor", "wann", "war", "was", "weil", "wenn",
  "wer", "werden", "wie", "wieso", "wird", "wo", "wofür", "worauf", "zu", "zum", "zur", "eigentlich", "genau", "einfach", "kurz", "bedeutet", "heißt",
  "warum", "weshalb", "welche", "welcher", "welches", "sein", "hast", "wäre", "würde", "dazu", "davon",
]);

// German nouns and verbs change their endings ("Versicherungen", "kündigen"); the trigram index matches the stem inside words.
const stem = (word: string) => word.length >= 7 ? word.replace(/(?:ungen|en|er|es|e|n|s)$/u, "") : word;

/** The words of a question that carry meaning: no filler words, no stemming. */
export function contentWords(question: string): string[] {
  const words = question.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length >= 3 && !stopwords.has(word)))];
}

/** Search words of a question: no filler words, light stemming, at most eight. */
export function keywordTerms(question: string): string[] {
  return [...new Set(contentWords(question).map(stem))].slice(0, 8);
}

/** An FTS5 query that matches any of the words, each quoted so no word is read as an operator. */
export const ftsQuery = (terms: string[]) => terms.map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");

/** What gets embedded for a chunk; the hash marks stored vectors as outdated when the text changes. */
export const documentText = (chunk: KnowledgeChunk) => `${chunk.title}. ${chunk.text} Stichworte: ${chunk.keywords}`;
export function chunkHash(chunk: KnowledgeChunk): string {
  let hash = 0x811c9dc5;
  for (const char of `${chunk.title}\n${chunk.keywords}\n${chunk.text}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Matryoshka embeddings keep their meaning when cut short; the cut vector is normalised again for cosine distance. */
export function toVector(values: number[], dims: number): Float32Array {
  const vector = Float32Array.from(values.slice(0, dims));
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

/**
 * Reciprocal rank fusion of the keyword and the vector ranking. With vectors, a chunk only counts when it is close to the
 * question (a top keyword match may be a bit further away); without vectors, the best keyword matches count.
 */
export function fuseHits(chunks: Map<string, KnowledgeChunk>, keyword: string[], vector?: { id: string; distance: number }[],
  limit = MAX_KNOWLEDGE_HITS): LocalKnowledgeHit[] {
  const hits = new Map<string, LocalKnowledgeHit>();
  const entry = (id: string) => {
    const chunk = chunks.get(id)!;
    const hit = hits.get(id) ?? { id, title: chunk.title, text: chunk.text, topic: chunk.topic, score: 0 };
    hits.set(id, hit);
    return hit;
  };
  keyword.forEach((id, index) => { if (!chunks.has(id)) return; const hit = entry(id); hit.keyword = index + 1; hit.score += 1 / (RRF_K + index + 1); });
  vector?.forEach(({ id, distance }, index) => {
    if (!chunks.has(id)) return;
    const hit = entry(id);
    hit.distance = Math.round(distance * 1000) / 1000;
    hit.score += 1 / (RRF_K + index + 1);
  });
  const relevant = [...hits.values()].filter((hit) => vector
    ? hit.distance !== undefined && (hit.distance <= VECTOR_MATCH || hit.keyword !== undefined && hit.keyword <= 2 && hit.distance <= VECTOR_MATCH + 0.03)
    : hit.keyword !== undefined && hit.keyword <= limit);
  const best = Math.min(...relevant.map((hit) => hit.distance ?? Number.POSITIVE_INFINITY));
  return relevant.filter((hit) => hit.distance === undefined || !Number.isFinite(best) || hit.distance <= best + SPREAD)
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

const topicOf = (text: string): KnowledgeTopic => {
  const lower = text.toLowerCase();
  if (/steuer|absetz|veranlagung|pauschale|freibetrag|finanzamt/.test(lower)) return "steuern";
  if (/vertrag|verträge|abo|kündig|versicherung/.test(lower)) return "vertraege";
  if (/etf|aktie|fonds|depot|anleihe|börse|rendite/.test(lower)) return "anlegen";
  if (/kredit|schulden|darlehen|zinsen für|rate\b/.test(lower)) return "schulden";
  if (/budget|ausgaben|haushalt/.test(lower)) return "budget";
  if (/spar|notgroschen|rücklage/.test(lower)) return "sparen";
  return "bank";
};
// Each confirmation (👍) and reuse moves a learned answer a little closer, at most by this much.
const VOTE_BONUS = 0.015;
const MAX_BONUS = 0.06;

/**
 * Confirmed answers as hits: by vector distance when the model answered (boosted by confirmations and reuse), otherwise by
 * how many of the question's words the learned question shares. Rank 1 in keyword mode means it asks the same thing.
 */
export function scoreLearned(learned: LearnedKnowledge[], terms: string[], distances?: Map<string, number>): LocalKnowledgeHit[] {
  return learned.flatMap((entry): LocalKnowledgeHit[] => {
    const question = entry.question.toLowerCase();
    const shared = terms.filter((term) => question.includes(term)).length;
    const overlap = terms.length ? shared / terms.length : 0;
    const base = { id: `learned:${entry.id}`, title: entry.question.slice(0, 200), text: entry.text, topic: topicOf(`${entry.question} ${entry.text}`),
      learned: { entryId: entry.id, votes: entry.votes } };
    const bonus = Math.min(MAX_BONUS, VOTE_BONUS * (Math.max(0, entry.votes) + entry.uses / 2));
    if (distances) {
      const distance = distances.get(entry.id);
      if (distance === undefined || distance > VECTOR_MATCH) return [];
      return [{ ...base, distance: Math.round(Math.max(0, distance - bonus) * 1000) / 1000, score: 1 / (RRF_K + 1) + bonus, ...(overlap >= 0.8 ? { keyword: 1 } : {}) }];
    }
    if (overlap < 0.6 || !shared) return [];
    return [{ ...base, keyword: overlap >= 0.8 ? 1 : 2, score: overlap + bonus }];
  }).sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || b.score - a.score);
}

/** Learned answers join the curated hits where they fit: closer ones first, the list stays at three. */
export function mergeLearned(hits: LocalKnowledgeHit[], learned: LocalKnowledgeHit[], mode: "hybrid" | "keyword", limit = MAX_KNOWLEDGE_HITS): LocalKnowledgeHit[] {
  if (!learned.length) return hits;
  if (mode === "keyword") {
    const same = learned.filter((hit) => hit.keyword === 1);
    return [...same, ...hits.map((hit) => same.length && hit.keyword === 1 ? { ...hit, keyword: 2 } : hit), ...learned.filter((hit) => hit.keyword !== 1)].slice(0, limit);
  }
  const merged = [...hits];
  for (const hit of learned) {
    const at = merged.findIndex((item) => (item.distance ?? Number.POSITIVE_INFINITY) > hit.distance!);
    merged.splice(at === -1 ? merged.length : at, 0, hit);
  }
  const best = Math.min(...merged.map((hit) => hit.distance ?? Number.POSITIVE_INFINITY));
  return merged.filter((hit) => hit.distance === undefined || hit.distance <= best + SPREAD).slice(0, limit);
}

/** Whether the best hit answers the question by itself, so it can be shown without asking the model. */
export function confidentHit(hits: LocalKnowledgeHit[], mode: "hybrid" | "keyword"): LocalKnowledgeHit | undefined {
  const [top] = hits;
  if (!top) return undefined;
  if (mode === "keyword") return top.keyword === 1 ? top : undefined;
  return top.distance !== undefined && (top.distance <= VECTOR_STRONG || top.keyword === 1 && top.distance <= VECTOR_STRONG + 0.04) ? top : undefined;
}

/** Retrieved knowledge as evidence for a free answer: short, and clearly not the user's own data. */
export function knowledgeEvidence(hits: LocalKnowledgeHit[], maxLength = 900): string | undefined {
  if (!hits.length) return undefined;
  const lines = ["Allgemeines Finanzwissen (keine Daten des Nutzers):"];
  for (const hit of hits) {
    const line = `- ${hit.title}: ${hit.text}`;
    if (lines.join("\n").length + line.length + 1 > maxLength) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

const followUps: Record<KnowledgeTopic, string> = {
  budget: "Wo kann ich sparen?",
  sparen: "Wie stehe ich finanziell da?",
  anlegen: "100 € im Monat in einen ETF, was habe ich nach 10 Jahren?",
  schulden: "Wie stehe ich finanziell da?",
  vertraege: "Welche Verträge kann ich kündigen?",
  steuern: "Was kann ich bei der Arbeitnehmerveranlagung absetzen?",
  bank: "Gibt es doppelte Buchungen?",
};

/** A term answered straight from the curated knowledge, without the model and without the internet. */
export function localKnowledgeAnswer(hit: LocalKnowledgeHit, related: LocalKnowledgeHit[] = []): { text: string; card: AssistantCard; suggestions: string[] } {
  const others = related.filter((item) => item.id !== hit.id).slice(0, 2);
  return {
    text: hit.text,
    card: { kind: "answer", title: hit.title.slice(0, 120),
      lines: others.map((item) => ({ label: item.title.slice(0, 200), detail: "Verwandtes Thema", tone: "info" as const })),
      note: "Aus dem lokalen Finanzwissen von Finanzblick, ohne Internet. Allgemeine Info, keine Steuer- oder Anlageberatung." },
    suggestions: [followUps[hit.topic], ...others.map((item) => `Erklär mir ${item.title}`)].slice(0, 3),
  };
}
