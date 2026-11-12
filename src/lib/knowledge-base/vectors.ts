/** Stored chunk vectors (`vectors.json`), written by `npm run knowledge:index` with the local embedding model. */
export type StoredVectors = { model: string; dims: number; entries: Record<string, { hash: string; vector: string }> };

// 512 of Qwen3-Embedding's 1024 dimensions keep nearly all of the ranking quality at half the size.
export const KNOWLEDGE_DIMS = 512;

export const vectorToBase64 = (vector: Float32Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
export function vectorFromBase64(value: string): Float32Array {
  const bytes = Buffer.from(value, "base64");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
