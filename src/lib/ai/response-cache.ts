import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CachedReply, ResponseCache } from "./client";

/**
 * Answers stored as files, one per request (model, messages and limits hashed): a repeated eval run asks no model twice.
 * Only for evals and benchmarks; the app itself never caches answers, because the data behind them changes.
 */
export function fileResponseCache(dir: string, options: { read?: boolean } = {}): ResponseCache & { stats: { hits: number; writes: number } } {
  const stats = { hits: 0, writes: 0 };
  const file = (key: object) => join(dir, `${createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 40)}.json`);
  return {
    stats,
    get(key) {
      if (options.read === false) return undefined;
      try {
        const value = JSON.parse(readFileSync(file(key), "utf8")) as CachedReply;
        stats.hits += 1;
        return value;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file(key), JSON.stringify(value));
        stats.writes += 1;
      } catch {
        // A cache that cannot be written only costs tokens next time.
      }
    },
  };
}
