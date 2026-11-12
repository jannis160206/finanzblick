import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAiConfig } from "../src/lib/ai/config";
import { embedTexts } from "../src/lib/ai/embeddings";
import { knowledgeCorpus } from "../src/lib/knowledge-base/corpus";
import { chunkHash, documentText, toVector } from "../src/lib/knowledge-base/query";
import { KNOWLEDGE_DIMS, vectorToBase64, type StoredVectors } from "../src/lib/knowledge-base/vectors";

// Embeds the curated finance knowledge once with the local model (`npm run ai:server` must run) and stores the vectors.
const config = readAiConfig();
if (!config.embeddingModel) throw new Error("FINANZBLICK_AI_EMBEDDING_MODEL ist ausgeschaltet.");
const target = fileURLToPath(new URL("../src/lib/knowledge-base/vectors.json", import.meta.url));
const started = performance.now();
const entries: StoredVectors["entries"] = {};
for (let index = 0; index < knowledgeCorpus.length; index += 8) {
  const batch = knowledgeCorpus.slice(index, index + 8);
  const vectors = await embedTexts(batch.map(documentText), { config, timeoutMs: 60_000 });
  batch.forEach((chunk, position) => { entries[chunk.id] = { hash: chunkHash(chunk), vector: vectorToBase64(toVector(vectors[position], KNOWLEDGE_DIMS)) }; });
}
const stored: StoredVectors = { model: config.embeddingModel, dims: KNOWLEDGE_DIMS, entries };
writeFileSync(target, `${JSON.stringify(stored, null, 1)}\n`);
console.log(`${Object.keys(entries).length} Einträge mit ${config.embeddingModel} (${KNOWLEDGE_DIMS} Dimensionen) in ${Math.round(performance.now() - started)} ms gespeichert.`);
