import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fileResponseCache } from "./response-cache";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("stores one answer per request and can be bypassed for a fresh run", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-ai-cache-"));
  dirs.push(dir);
  const reply = { content: "OK", toolCalls: [], use: { provider: "deepseek" as const, model: "deepseek-flash", task: "chat" as const } };
  const cache = fileResponseCache(dir);
  cache.set({ model: "deepseek-flash", messages: ["Ping"] }, reply);
  expect(cache.get({ model: "deepseek-flash", messages: ["Ping"] })).toEqual(reply);
  expect(cache.get({ model: "deepseek-flash", messages: ["Pong"] })).toBeUndefined();
  expect(cache.stats).toEqual({ hits: 1, writes: 1 });
  expect(readdirSync(dir)).toHaveLength(1);
  expect(fileResponseCache(dir, { read: false }).get({ model: "deepseek-flash", messages: ["Ping"] })).toBeUndefined();
});
