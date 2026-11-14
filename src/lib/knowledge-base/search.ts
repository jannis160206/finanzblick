import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";
import { readAiConfig } from "@/lib/ai/config";
import { embedTexts } from "@/lib/ai/embeddings";
import { knowledgeCorpus } from "./corpus";
import { chunkHash, EMBEDDING_QUERY_PREFIX, ftsQuery, fuseHits, keywordTerms, MAX_KNOWLEDGE_HITS, mergeLearned, scoreLearned, toVector } from "./query";
import type { KnowledgeChunk, LearnedKnowledge, LocalKnowledgeSearch } from "./types";
import stored from "./vectors.json";
import { vectorFromBase64, type StoredVectors } from "./vectors";

type Index = { db: DatabaseSync; byId: Map<string, KnowledgeChunk>; vectors: boolean; model: string; dims: number; learned: string };

let index: Index | undefined;

/**
 * Where the vectors of learned answers are kept between restarts, so each answer is embedded only once:
 * `FINANZBLICK_KNOWLEDGE_VECTORS` (absolute path, or `off` for memory only); in production next to the account database;
 * otherwise `data/assistant-knowledge.sqlite`. The file holds content hashes and vectors only, never the texts.
 */
export function learnedVectorPath(env: Record<string, string | undefined> = process.env): string | undefined {
  const configured = env.FINANZBLICK_KNOWLEDGE_VECTORS?.trim();
  if (configured) return /^(?:off|false|0|aus)$/i.test(configured) || !isAbsolute(configured) ? undefined : configured;
  if (env.NODE_ENV === "test") return undefined;
  const database = env.FINANZBLICK_DATABASE_PATH?.trim();
  if (env.NODE_ENV === "production" && database && isAbsolute(database)) return join(dirname(database), "assistant-knowledge.sqlite");
  return resolve(/* turbopackIgnore: true */ process.cwd(), "data", "assistant-knowledge.sqlite");
}

// The learned vectors live in their own sqlite-vec file when it can be opened; otherwise in memory.
function learnedTable(db: DatabaseSync, file: string | undefined): string {
  const create = (table: string) => db.exec(`create table if not exists ${table} (key text primary key, embedding blob not null, at integer not null)`);
  if (file) try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    db.prepare("attach database ? as store").run(file);
    create("store.learned");
    try {
      chmodSync(file, 0o600);
    } catch {
      // Not every file system knows permissions.
    }
    return "store.learned";
  } catch {
    // Read-only or unavailable: memory only, as before.
  }
  create("main.learned");
  return "main.learned";
}

// Built once on the first knowledge question: the curated chunks in memory (a few milliseconds for 50 chunks),
// the vectors of learned answers in a local file.
function build(vectors: StoredVectors = stored as StoredVectors, file = learnedVectorPath()): Index {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  // Trigram tokens find word parts, which German compounds need ("Frist" in "Kündigungsfrist").
  db.exec("create virtual table fts using fts5(id unindexed, title, keywords, text, tokenize = 'trigram remove_diacritics 1')");
  const insert = db.prepare("insert into fts (id, title, keywords, text) values (?, ?, ?, ?)");
  for (const chunk of knowledgeCorpus) insert.run(chunk.id, chunk.title, chunk.keywords, chunk.text);
  let usable = false;
  let learned = "main.learned";
  try {
    db.loadExtension(getLoadablePath());
    db.exec(`create virtual table vec using vec0(embedding float[${vectors.dims}] distance_metric=cosine)`);
    // Stored answers: embedded once, kept by content hash, compared only with the entries a request sends.
    learned = learnedTable(db, file);
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
  return { db, byId: new Map(knowledgeCorpus.map((chunk) => [chunk.id, chunk])), vectors: usable, model: vectors.model, dims: vectors.dims, learned };
}

/** For tests: rebuilds the index, optionally with other stored vectors or another file for the learned vectors. */
export function resetKnowledgeIndex(vectors?: StoredVectors, file?: string) {
  index?.db.close();
  index = vectors || file ? build(vectors, file) : undefined;
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

const MAX_LEARNED_VECTORS = 5000;
// New answers are embedded in small batches until the time budget is used up; the rest follows with the next question.
const EMBED_BATCH = 16;
const EMBED_BUDGET_MS = 2_500;
const learnedText = (entry: LearnedKnowledge) => `${entry.question}. ${entry.text}`;
// The key names the embedding model, so vectors of another model are never compared.
function learnedKey(store: Index, entry: LearnedKnowledge) {
  let hash = 0x811c9dc5;
  for (const char of `${entry.question}\n${entry.text}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${store.model}/${store.dims}/${hash.toString(16).padStart(8, "0")}`;
}

async function embedMissing(store: Index, missing: LearnedKnowledge[], options: SearchOptions) {
  const deadline = Date.now() + EMBED_BUDGET_MS;
  const embed = options.embedDocuments ?? ((texts: string[]) => embedTexts(texts, { signal: options.signal, timeoutMs: Math.max(500, deadline - Date.now()) }));
  const insert = store.db.prepare(`insert or replace into ${store.learned} (key, embedding, at) values (?, ?, ?)`);
  for (let start = 0; start < missing.length && Date.now() < deadline; start += EMBED_BATCH) {
    const batch = missing.slice(start, start + EMBED_BATCH);
    let vectors: number[][];
    try {
      vectors = await embed(batch.map(learnedText));
    } catch (error) {
      // Nothing embedded at all means no vectors for this question; later batches simply wait for the next one.
      if (start === 0 || options.signal?.aborted) throw error;
      break;
    }
    batch.forEach((entry, position) => {
      if (vectors[position]) insert.run(learnedKey(store, entry), new Uint8Array(toVector(vectors[position], store.dims).buffer), Date.now());
    });
  }
  const { count } = store.db.prepare(`select count(*) as count from ${store.learned}`).get() as { count: number };
  if (count > MAX_LEARNED_VECTORS)
    store.db.prepare(`delete from ${store.learned} where key in (select key from ${store.learned} order by at limit ?)`).run(count - MAX_LEARNED_VECTORS);
}

/** Cosine distances between the question and the stored answers; new answers are embedded once and kept by hash. */
async function learnedDistances(store: Index, entries: LearnedKnowledge[], query: Float32Array, options: SearchOptions): Promise<Map<string, number>> {
  const keys = entries.map((entry) => learnedKey(store, entry));
  const has = store.db.prepare(`select 1 from ${store.learned} where key = ?`);
  const missing = entries.filter((_, position) => !has.get(keys[position]));
  if (missing.length) await embedMissing(store, missing, options);
  const rows = store.db.prepare(`select key, vec_distance_cosine(embedding, ?) as distance from ${store.learned} where key in (${keys.map(() => "?").join(", ")})`)
    .all(new Uint8Array(query.buffer), ...keys) as { key: string; distance: number }[];
  const byKey = new Map(rows.map((row) => [row.key, row.distance]));
  return new Map(entries.flatMap((entry, position) => byKey.has(keys[position]) ? [[entry.id, byKey.get(keys[position])!] as const] : []));
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
