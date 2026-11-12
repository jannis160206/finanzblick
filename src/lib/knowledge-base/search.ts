import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";
import { readAiConfig } from "@/lib/ai/config";
import { embedTexts } from "@/lib/ai/embeddings";
import { knowledgeCorpus } from "./corpus";
import { chunkHash, EMBEDDING_QUERY_PREFIX, ftsQuery, fuseHits, keywordTerms, MAX_KNOWLEDGE_HITS, mergeLearned, scoreLearned, toVector } from "./query";
import type { KnowledgeChunk, LearnedKnowledge, LocalKnowledgeSearch } from "./types";
import stored from "./vectors.json";
import { vectorFromBase64, type StoredVectors } from "./vectors";

type Index = { db: DatabaseSync; byId: Map<string, KnowledgeChunk>; vectors: boolean; model: string; dims: number };

let index: Index | undefined;

// Built once on the first knowledge question, in memory: no file, no server, a few milliseconds for 50 chunks.
function build(vectors: StoredVectors = stored as StoredVectors): Index {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  // Trigram tokens find word parts, which German compounds need ("Frist" in "Kündigungsfrist").
  db.exec("create virtual table fts using fts5(id unindexed, title, keywords, text, tokenize = 'trigram remove_diacritics 1')");
  const insert = db.prepare("insert into fts (id, title, keywords, text) values (?, ?, ?, ?)");
  for (const chunk of knowledgeCorpus) insert.run(chunk.id, chunk.title, chunk.keywords, chunk.text);
  let usable = false;
  try {
    db.loadExtension(getLoadablePath());
    db.exec(`create virtual table vec using vec0(embedding float[${vectors.dims}] distance_metric=cosine)`);
    // Confirmed answers of the user: embedded once, kept by content hash, compared only with the entries a request sends.
    db.exec("create table learned (hash text primary key, embedding blob not null)");
    const add = db.prepare("insert into vec (rowid, embedding) values (?, ?)");
    knowledgeCorpus.forEach((chunk, position) => {
      const entry = vectors.entries[chunk.id];
      // A chunk edited after the last `npm run knowledge:index` is still found by keyword.
      if (!entry || entry.hash !== chunkHash(chunk)) return;
      add.run(BigInt(position + 1), new Uint8Array(vectorFromBase64(entry.vector).buffer));
      usable = true;
    });
  } catch {
    usable = false;
  }
  return { db, byId: new Map(knowledgeCorpus.map((chunk) => [chunk.id, chunk])), vectors: usable, model: vectors.model, dims: vectors.dims };
}

/** For tests: rebuilds the index, optionally with other stored vectors. */
export function resetKnowledgeIndex(vectors?: StoredVectors) {
  index?.db.close();
  index = vectors ? build(vectors) : undefined;
}

function keywordIds(store: Index, terms: string[], strict: boolean): string[] {
  if (!terms.length) return [];
  // Without vectors only title and keywords count, so a word somewhere in a long text does not decide alone.
  const query = strict ? `{title keywords} : (${ftsQuery(terms)})` : ftsQuery(terms);
  try {
    return (store.db.prepare("select id from fts where fts match ? order by bm25(fts, 0, 6, 3, 1) limit 8").all(query) as { id: string }[]).map((row) => row.id);
  } catch {
    return [];
  }
}

function nearest(store: Index, vector: Float32Array) {
  const rows = store.db.prepare("select rowid, distance from vec where embedding match ? and k = 8 order by distance")
    .all(new Uint8Array(vector.buffer)) as { rowid: number | bigint; distance: number }[];
  return rows.map((row) => ({ id: knowledgeCorpus[Number(row.rowid) - 1].id, distance: row.distance }));
}

export type SearchOptions = {
  signal?: AbortSignal; embed?: (text: string) => Promise<number[]>; embedDocuments?: (texts: string[]) => Promise<number[][]>; learned?: LearnedKnowledge[];
};

const MAX_LEARNED_VECTORS = 500;
const learnedText = (entry: LearnedKnowledge) => `${entry.question}. ${entry.text}`;
function learnedHash(entry: LearnedKnowledge) {
  let hash = 0x811c9dc5;
  for (const char of `${entry.question}\n${entry.text}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Cosine distances between the question and the confirmed answers; new answers are embedded once and cached by hash. */
async function learnedDistances(store: Index, entries: LearnedKnowledge[], query: Float32Array, options: SearchOptions): Promise<Map<string, number>> {
  const hashes = entries.map(learnedHash);
  const has = store.db.prepare("select 1 from learned where hash = ?");
  const missing = entries.filter((_, index) => !has.get(hashes[index]));
  if (missing.length) {
    const embed = options.embedDocuments ?? ((texts: string[]) => embedTexts(texts, { signal: options.signal, timeoutMs: 2_500 }));
    const vectors = await embed(missing.map(learnedText));
    const count = (store.db.prepare("select count(*) as count from learned").get() as { count: number }).count;
    if (count + missing.length > MAX_LEARNED_VECTORS) store.db.exec("delete from learned");
    const insert = store.db.prepare("insert or replace into learned (hash, embedding) values (?, ?)");
    missing.forEach((entry, index) => {
      if (vectors[index]) insert.run(learnedHash(entry), new Uint8Array(toVector(vectors[index], store.dims).buffer));
    });
  }
  const rows = store.db.prepare(`select hash, vec_distance_cosine(embedding, ?) as distance from learned where hash in (${hashes.map(() => "?").join(", ")})`)
    .all(new Uint8Array(query.buffer), ...hashes) as { hash: string; distance: number }[];
  const byHash = new Map(rows.map((row) => [row.hash, row.distance]));
  return new Map(entries.flatMap((entry, index) => byHash.has(hashes[index]) ? [[entry.id, byHash.get(hashes[index])!] as const] : []));
}

const embedQuestion = async (question: string, signal?: AbortSignal) => {
  const [vector] = await embedTexts([`${EMBEDDING_QUERY_PREFIX}${question}`], { signal, timeoutMs: 2_500 });
  return vector;
};

/**
 * Hybrid search over the curated finance knowledge: vector similarity from the local embedding model plus a keyword
 * search, fused by rank. Without the model (offline, server without NPU) it falls back to keywords. At most three hits.
 */
export async function searchKnowledge(question: string, options: SearchOptions = {}): Promise<LocalKnowledgeSearch> {
  const started = performance.now();
  const store = index ??= build();
  const terms = keywordTerms(question);
  let near: { id: string; distance: number }[] | undefined;
  let query: Float32Array | undefined;
  if (store.vectors && (options.embed || readAiConfig().embeddingModel === store.model)) {
    try {
      query = toVector(await (options.embed ?? ((text) => embedQuestion(text, options.signal)))(question), store.dims);
      near = nearest(store, query);
    } catch {
      if (options.signal?.aborted) throw new Error("Abgebrochen.");
      near = undefined;
      query = undefined;
    }
  }
  const hits = fuseHits(store.byId, keywordIds(store, terms, !near), near, MAX_KNOWLEDGE_HITS);
  const learned = options.learned ?? [];
  if (!learned.length) return { hits, mode: near ? "hybrid" : "keyword", ms: Math.round(performance.now() - started) };
  let distances: Map<string, number> | undefined;
  if (query) try {
    distances = await learnedDistances(store, learned, query, options);
  } catch {
    if (options.signal?.aborted) throw new Error("Abgebrochen.");
  }
  const mode = near && distances ? "hybrid" : "keyword";
  const ranked = scoreLearned(learned, terms, mode === "hybrid" ? distances : undefined);
  return { hits: mergeLearned(mode === "hybrid" ? hits : fuseHits(store.byId, keywordIds(store, terms, true), undefined, MAX_KNOWLEDGE_HITS), ranked, mode),
    mode, ms: Math.round(performance.now() - started) };
}
