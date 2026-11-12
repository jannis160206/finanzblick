export type KnowledgeTopic = "budget" | "sparen" | "anlegen" | "schulden" | "vertraege" | "steuern" | "bank";

/** One curated piece of general finance knowledge; `keywords` are extra search words that are never shown. */
export type KnowledgeChunk = { id: string; topic: KnowledgeTopic; title: string; keywords: string; text: string };

/** An answer the user confirmed earlier (👍 on a web search answer), sent along with the question; it never leaves the server. */
export type LearnedKnowledge = { id: string; question: string; text: string; votes: number; uses: number };

/**
 * A retrieved chunk: `keyword` is its rank in the keyword search, `distance` its cosine distance to the question.
 * `learned` marks a confirmed answer of the user; its distance is a little shorter for every confirmation.
 */
export type LocalKnowledgeHit = {
  id: string; title: string; text: string; topic: KnowledgeTopic; score: number; keyword?: number; distance?: number;
  learned?: { entryId: string; votes: number };
};

/** `hybrid` when the local embedding model answered, otherwise `keyword` only. */
export type LocalKnowledgeSearch = { hits: LocalKnowledgeHit[]; mode: "hybrid" | "keyword"; ms: number };
