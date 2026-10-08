import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAccountRuntime, closeAccountDatabases } from "@/lib/server/runtime";
import { createTestDirectory } from "@/lib/server/test-support";
import { uploadStatement, statementEvents } from "./handlers";
import { AutomationStore } from "./store";

let directory: string;
let alice: { id: string; token: string };
let bob: { id: string; token: string };
beforeEach(async () => {
  directory = createTestDirectory();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINANZBLICK_AUTH", "true");
  vi.stubEnv("FINANZBLICK_DATABASE_PATH", join(directory, "accounts.sqlite"));
  vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", "test-only-password-123");
  vi.stubEnv("FINANZBLICK_ORIGIN", "http://localhost:3000");
  const { database } = await getAccountRuntime();
  const first = await database.register("alice", "test-only-password-123");
  const second = await database.register("bob", "test-only-password-123");
  alice = { id: first.user.id, token: first.token };
  bob = { id: second.user.id, token: second.token };
});
afterEach(() => {
  closeAccountDatabases();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function request(user = alice, account = user.id, body = "not parsed here") {
  return new Request("http://localhost:3000/api/statements?name=test.csv", {
    method: "POST",
    body,
    headers: {
      Origin: "http://localhost:3000",
      "Content-Type": "application/octet-stream",
      "X-Finanzblick-Account": account,
      "X-Upload-Size": String(Buffer.byteLength(body)),
      Cookie: `finanzblick_session=${user.token}`,
    },
  });
}
function events(user = alice, account = user.id) {
  return statementEvents(
    new Request(
      `http://localhost:3000/api/statements/events?account=${account}`,
      {
        headers: { Cookie: `finanzblick_session=${user.token}` },
      },
    ),
  );
}

it("only persists and enqueues the upload, returning 202 without parsing", async () => {
  const response = await uploadStatement(request());
  expect(response.status).toBe(202);
  const { id } = await response.json();
  const { database } = await getAccountRuntime();
  const store = new AutomationStore(database);
  expect((await readFile(store.filePath(id))).toString()).toBe(
    "not parsed here",
  );
  expect(store.snapshot(alice.id).jobs[0].status).toBe("QUEUED");
  expect(database.getFinance(alice.id).state).toBeNull();
});

it("rejects unauthenticated, switched-account and cross-origin uploads", async () => {
  expect(
    (await uploadStatement(request({ id: alice.id, token: "" }))).status,
  ).toBe(401);
  expect((await uploadStatement(request(alice, bob.id))).status).toBe(401);
  const cross = request();
  cross.headers.set("origin", "https://untrusted.example");
  expect((await uploadStatement(cross)).status).toBe(403);
  expect((await events(alice, bob.id)).status).toBe(401);
});

it("rejects incorrect byte counts and reports the failed upload without leaving a payload", async () => {
  const input = request();
  input.headers.set("X-Upload-Size", "1");
  expect((await uploadStatement(input)).status).toBe(413);
  const { database } = await getAccountRuntime();
  const job = new AutomationStore(database).snapshot(alice.id).jobs[0];
  expect(job.status).toBe("FAILED");
  await expect(
    readFile(new AutomationStore(database).filePath(job.id)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("streams only tenant-owned progress and releases connection slots on cancellation", async () => {
  await uploadStatement(request());
  const response = await events(bob);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain('"jobs":[]');
  expect(first).not.toContain("test.csv");
  await reader.cancel();
  const streams = [];
  for (let i = 0; i < 5; i++) streams.push(await events());
  expect((await events()).status).toBe(429);
  for (const stream of streams) await stream.body!.cancel();
  const recovered = await events();
  expect(recovered.status).toBe(200);
  await recovered.body!.cancel();
});

it("revokes an active SSE stream when the session is logged out", async () => {
  vi.useFakeTimers();
  const response = await events();
  const reader = response.body!.getReader();
  await reader.read();
  const { database } = await getAccountRuntime();
  database.logout(alice.token);
  await vi.advanceTimersByTimeAsync(1000);
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "event: unauthorized",
  );
  expect((await reader.read()).done).toBe(true);
  vi.useRealTimers();
});
