import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/statements/route";
import { GET as events } from "@/app/api/statements/events/route";
import { GET as session } from "@/app/api/auth/session/route";
import { GET as finance } from "@/app/api/finance/route";
import { closeAccountDatabases, getAccountRuntime } from "@/lib/server/runtime";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { AutomationStore } from "./store";
import { AutomationWorker } from "./worker";
import { MerchantIndex, seedMerchants } from "./merchants";

let directory: string;
let server: Server;
let origin: string;
let user: { id: string; token: string };

beforeEach(async () => {
  directory = createTestDirectory();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("FINANZBLICK_AUTH", "true");
  vi.stubEnv("FINANZBLICK_DATABASE_PATH", join(directory, "accounts.sqlite"));
  vi.stubEnv("FINANZBLICK_ADMIN_PASSWORD", "synthetic-test-password");
  // Exercise the published route exports over real loopback HTTP, without Next
  // startup, dotenv loading, production data, or a persistent service.
  server = createServer(async (input, output) => {
    const abort = new AbortController();
    output.once("close", () => abort.abort());
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(input.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const request = new Request(`${origin}${input.url}`, {
        method: input.method, headers, signal: abort.signal,
        ...(input.method === "POST" ? { body: Readable.toWeb(input), duplex: "half" } : {}),
      } as RequestInit);
      const pathname = new URL(request.url).pathname;
      const handler = pathname === "/api/statements" ? POST
        : pathname === "/api/statements/events" ? events
        : pathname === "/api/auth/session" ? session : finance;
      const response = await handler(request);
      output.statusCode = response.status;
      response.headers.forEach((value, name) => output.setHeader(name, value));
      output.flushHeaders();
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (!abort.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            output.write(chunk.value);
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
      }
      output.end();
    } catch (error) {
      output.destroy(error instanceof Error ? error : new Error("Synthetic route failed"));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("FINANZBLICK_ORIGIN", origin);
  const { database } = await getAccountRuntime();
  const registered = await database.register("alice", "synthetic-test-password");
  user = { id: registered.user.id, token: registered.token };
  database.putFinance(user.id, {
    ...blankTestState(),
    transactions: [{
      id: "existing-purchase", bank: "Revolut", pocket: null, date: "2026-10-01",
      description: "Existing synthetic purchase", amount: -11, category: "Prüfen",
      includeInPlan: false,
    }],
  }, 0);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeAccountDatabases();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function headers() {
  return { Cookie: `finanzblick_session=${user.token}`, "X-Finanzblick-Account": user.id };
}

function upload(name: string, bytes: Uint8Array, id: string) {
  return fetch(`${origin}/api/statements?name=${encodeURIComponent(name)}`, {
    method: "POST", body: Buffer.from(bytes),
    headers: {
      ...headers(), Origin: origin, "Content-Type": "application/octet-stream",
      "X-Upload-Size": String(bytes.byteLength), "X-Upload-Id": id,
    },
  });
}

function syntheticPdf() {
  const text = "American Express Platinum Card\n31.10.2026\nUmsatz vom Buchung am Details Betrag in EUR\n08.10 08.10 BILLA 4711 23,00";
  const content = `BT /F1 10 Tf 14 TL 30 750 Td ${text.split("\n").map((line) => `(${line}) Tj T*`).join("\n")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf, "latin1");
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const start = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

it.each([
  { name: "synthetic.csv", bytes: Buffer.from('American Express\nDatum,Beschreibung,Karteninhaber,Kartennummer,Betrag\n08.10.2026,BILLA FILIALE 4711,Test User,XXXX-1001,"23,00"') },
  { name: "synthetic.pdf", bytes: syntheticPdf() },
])("keeps HTTP session/finance/SSE readable and returns retryable 503 for $name under an exhausted 5-second writer wait", async ({ name, bytes }) => {
  const { database } = await getAccountRuntime();
  const store = new AutomationStore(database);
  const before = database.getFinance(user.id);
  const writer = new DatabaseSync(database.path);
  const id = randomUUID();
  try {
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("UPDATE finance SET revision = revision + 1 WHERE user_id = ?").run(user.id);
    const authenticated = await fetch(`${origin}/api/auth/session`, { headers: headers() });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({ user: { id: user.id } });
    const snapshot = await fetch(`${origin}/api/finance`, { headers: headers() });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toEqual(before);
    const stream = await fetch(`${origin}/api/statements/events?account=${user.id}`, { headers: headers() });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const progress = new TextDecoder().decode((await reader.read()).value);
    expect(progress).toContain("event: progress");
    expect(progress).toContain('"revision":1');
    expect(progress).not.toContain("unavailable");
    await reader.cancel();
    const start = Date.now();
    const refused = await upload(name, bytes, id);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4500);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("Retry-After")).toBe("5");
    expect(await refused.json()).toEqual({
      error: "Der Server ist vorübergehend ausgelastet. Bitte kurz warten und erneut versuchen.",
    });
    expect(store.snapshot(user.id).jobs).toEqual([]);
    writer.exec("ROLLBACK");
    expect(database.getFinance(user.id)).toEqual(before);
    const accepted = await upload(name, bytes, id);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ id });
    expect(store.snapshot(user.id).jobs).toMatchObject([{ id, status: "QUEUED" }]);
    expect(await readFile(store.filePath(id))).toEqual(bytes);
    expect((await upload(name, bytes, id)).status).toBe(409);
    expect(store.snapshot(user.id).jobs).toHaveLength(1);
    expect(database.getFinance(user.id)).toEqual(before);

    store.upsertMerchants(seedMerchants);
    expect(store.acquire("synthetic-worker")).toBe(true);
    const worker = new AutomationWorker(store, "synthetic-worker", new MerchantIndex(store.loadMerchants()));
    await worker.process(store.claim("synthetic-worker")!);
    expect(store.snapshot(user.id).jobs).toMatchObject([{ id, status: "COMPLETED" }]);
    const final = database.getFinance(user.id);
    expect(final.revision).toBe(2);
    expect(final.state?.transactions).toHaveLength(2);
    expect(final.state?.transactions.find((row) => row.id === "existing-purchase")).toEqual(before.state!.transactions[0]);
    expect(final.state?.transactions).toEqual(expect.arrayContaining([expect.objectContaining({ amount: -23 })]));
    await worker.cleanup();
    await expect(readFile(store.filePath(id))).rejects.toMatchObject({ code: "ENOENT" });
    store.release("synthetic-worker");
  } finally { writer.close(); }
});
