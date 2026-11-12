import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFeedbackEntry, feedbackSummary, type FeedbackEntry, type StoredFeedback } from "@/lib/assistant/feedback";
import type { AssistantMessage } from "@/lib/types";
import { FeedbackFileError, feedbackDisplayPath, feedbackFilePath, readFeedback, recordFeedback } from "./feedback-store";

const answer: AssistantMessage = { id: "a1", role: "assistant", text: "412 € für Lebensmittel.", at: 1_794_000_000_000, agent: "transactions", tool: "query",
  asked: "Wie viel hab ich im Oktober fürs Essen ausgegeben?" };
const entry = (id: string, extra: Partial<FeedbackEntry> = {}): FeedbackEntry =>
  ({ ...buildFeedbackEntry({ id, message: answer, thread: [answer], rating: "dislike" }), ...extra });
const stored = (id: string): StoredFeedback => {
  const value = entry(id);
  return { ...value, summary: feedbackSummary(value), recordedAt: new Date().toISOString() };
};

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "finanzblick-feedback-")); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("feedback file location", () => {
  it("uses data/ in development, the database folder in production and an absolute override", () => {
    expect(feedbackFilePath({})).toBe(resolve("data", "assistant-feedback.json"));
    expect(feedbackDisplayPath(resolve("data", "assistant-feedback.json"))).toBe("data/assistant-feedback.json");
    const database = join(directory, "finanzblick.sqlite");
    expect(feedbackFilePath({ NODE_ENV: "production", FINANZBLICK_DATABASE_PATH: database })).toBe(join(directory, "assistant-feedback.json"));
    expect(feedbackFilePath({ FINANZBLICK_FEEDBACK_FILE: join(directory, "f.json") })).toBe(join(directory, "f.json"));
    expect(() => feedbackFilePath({ FINANZBLICK_FEEDBACK_FILE: "relative.json" })).toThrow();
    expect(() => feedbackFilePath({ FINANZBLICK_FEEDBACK_FILE: resolve("public", "feedback.json") })).toThrow();
  });
});

describe("feedback store", () => {
  it("appends every rating to one file, also when they arrive at the same time", async () => {
    const path = join(directory, "nested", "assistant-feedback.json");
    await Promise.all(["fb-00000001", "fb-00000002", "fb-00000003"].map((id) => recordFeedback(stored(id), path)));
    expect((await readFeedback(path)).map((item) => item.id).sort()).toEqual(["fb-00000001", "fb-00000002", "fb-00000003"]);
    const file = JSON.parse(await readFile(path, "utf8"));
    expect(file).toMatchObject({ format: "finanzblick-assistant-feedback", count: { total: 3, dislike: 3 } });
  });

  it("treats a missing or empty file as empty, reads a file with a byte order mark and never overwrites a damaged or foreign file", async () => {
    expect(await readFeedback(join(directory, "missing.json"))).toEqual([]);
    const path = join(directory, "assistant-feedback.json");
    await recordFeedback(stored("fb-00000001"), path);
    await writeFile(path, `\uFEFF${await readFile(path, "utf8")}`);
    expect(await readFeedback(path)).toHaveLength(1);
    for (const content of ["{\"format\": \"finanzblick-assistant-feedback\", \"entries\": [],}", "SQLite format 3\u0000", "{\"entries\": []}"]) {
      await writeFile(path, content);
      await expect(recordFeedback(stored("fb-00000002"), path)).rejects.toBeInstanceOf(FeedbackFileError);
      expect(await readFile(path, "utf8")).toBe(content);
    }
  });
});

describe("feedback route", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) => new Request("http://localhost/api/assistant-feedback", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("stores a redacted entry with the server's setup and lists it for the admin view", async () => {
    const path = join(directory, "assistant-feedback.json");
    vi.stubEnv("FINANZBLICK_FEEDBACK_FILE", path);
    vi.stubEnv("FINANZBLICK_AI", "false");
    const { GET, POST } = await import("@/app/api/assistant-feedback/route");
    const response = await POST(post(entry("fb-00000009", { comment: "Die IBAN AT61 1904 3002 3457 3201 gehört nicht hierher" })));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stored: true, count: { total: 1, dislike: 1, withComment: 1 } });
    const [saved] = await readFeedback(path);
    expect(saved.comment).toBe("Die IBAN [IBAN entfernt] gehört nicht hierher");
    expect(saved).toMatchObject({ app: { aiEnabled: false }, summary: expect.stringContaining("👎 Umsätze / query") });
    expect(saved.account).toBeUndefined();

    const summary = await (await GET(new Request("http://localhost/api/assistant-feedback"))).json();
    expect(summary).toMatchObject({ count: { total: 1 }, latest: [{ id: "fb-00000009", rating: "dislike" }] });
    const download = await GET(new Request("http://localhost/api/assistant-feedback?download=1"));
    expect(download.headers.get("content-disposition")).toContain("assistant-feedback.json");
    expect((await download.json()).entries).toHaveLength(1);
  });

  it("rejects invalid entries and requests from other sites", async () => {
    vi.stubEnv("FINANZBLICK_FEEDBACK_FILE", join(directory, "assistant-feedback.json"));
    const { POST } = await import("@/app/api/assistant-feedback/route");
    expect((await POST(post({ rating: "meh" }))).status).toBe(400);
    expect((await POST(post(entry("fb-00000010"), { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });
});
