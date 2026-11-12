import type { AssistantCard } from "@/lib/types";
import type { KnowledgeChunk, KnowledgeTopic, LocalKnowledgeHit } from "./types";

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
  "aber", "alle", "allem", "also", "auch", "auf", "aus", "bei", "beim", "bin", "bis", "bitte", "da", "damit", "dann", "das", "dass", "dein", "deine",
  "dem", "den", "denn", "der", "des", "die", "dies", "diese", "dir", "doch", "dort", "du", "durch", "ein", "eine", "einem", "einen", "einer", "eines",
  "eigentlich", "erklär", "erkläre", "erklären", "es", "etwa", "etwas", "euch", "für", "fürs", "gibt", "gut", "habe", "haben", "hat", "hier", "ich",
  "ihr", "im", "immer", "in", "ins", "ist", "ja", "jetzt", "kann", "kannst", "kein", "keine", "können", "lohnt", "lohnen", "mal", "man", "mehr",
  "mein", "meine", "meinen", "meiner", "mich", "mir", "mit", "muss", "nach", "nicht", "noch", "nur", "oder", "ohne", "schon", "sehr", "sich", "sie",
  "sind", "soll", "sollte", "sollten", "über", "um", "und", "uns", "unter", "viel", "viele", "vom", "von", "vor", "wann", "war", "was", "weil", "wenn",
  "wer", "werden", "wie", "wieso", "wird", "wo", "wofür", "worauf", "zu", "zum", "zur", "eigentlich", "genau", "einfach", "kurz", "bedeutet", "heißt",
]);

// German nouns and verbs change their endings ("Versicherungen", "kündigen"); the trigram index matches the stem inside words.
const stem = (word: string) => word.length >= 7 ? word.replace(/(?:ungen|en|er|es|e|n|s)$/u, "") : word;

/** Search words of a question: no filler words, light stemming, at most eight. */
export function keywordTerms(question: string): string[] {
  const words = question.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length >= 3 && !stopwords.has(word)).map(stem))].slice(0, 8);
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
