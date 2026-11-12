export type KnowledgeTopic = "budget" | "sparen" | "anlegen" | "schulden" | "vertraege" | "steuern" | "bank";

/** One curated piece of general finance knowledge; `keywords` are extra search words that are never shown. */
export type KnowledgeChunk = { id: string; topic: KnowledgeTopic; title: string; keywords: string; text: string };

/** A retrieved chunk: `keyword` is its rank in the keyword search, `distance` its cosine distance to the question. */
export type LocalKnowledgeHit = {
  id: string; title: string; text: string; topic: KnowledgeTopic; score: number; keyword?: number; distance?: number;
};

/** `hybrid` when the local embedding model answered, otherwise `keyword` only. */
export type LocalKnowledgeSearch = { hits: LocalKnowledgeHit[]; mode: "hybrid" | "keyword"; ms: number };
