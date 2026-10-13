import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestDirectory } from "@/lib/server/test-support";
import { parseStatementInChild } from "./parser-runtime";
import { parserResultSchema } from "./parser-ipc";

let directory: string;
let path: string;
const csv = Buffer.from(
  'American Express\nDatum,Beschreibung,Karteninhaber,Kartennummer,Betrag\n08.10.2026,BILLA,Test User,XXXX-1001,"42,00"',
);
beforeEach(async () => {
  directory = createTestDirectory();
  path = join(directory, randomUUID());
  await writeFile(path, csv);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function expectDead(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow();
}
async function waitForStart() {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(`${path}.started`)) return;
    await delay(10);
  }
  throw new Error("Synthetic parser did not start");
}
async function hangingParser() {
  const entrypoint = join(directory, "hanging.mjs");
  const watchdog = pathToFileURL(join(process.cwd(), "src", "lib", "automation", "parser-watchdog.ts")).href;
  await writeFile(entrypoint, `
    import { writeFileSync } from "node:fs";
    import { Worker } from "node:worker_threads";
    import { startParserWatchdog } from ${JSON.stringify(watchdog)};
    process.on("SIGTERM", () => {});
    process.once("message", (request) => {
      startParserWatchdog(process.ppid, request.deadline);
      new Worker("while (true) {}", { eval: true });
      writeFileSync(request.path + ".started", String(process.pid));
      while (true) {}
    });
  `);
  return entrypoint;
}

it("kills a truly blocked parser and its threads at the total deadline, then parses the next file", async () => {
  const entrypoint = await hangingParser();
  let pid = 0;
  const failure = parseStatementInChild(path, "statement.csv", csv.length, {
    entrypoint, budgetMs: 5000, onSpawn: (value) => { pid = value; },
  }).catch((error: unknown) => error);
  await waitForStart();
  expect(Number(await readFile(`${path}.started`, "utf8"))).toBe(pid);
  expect(await failure).toMatchObject({ code: "PARSE_TIMEOUT" });
  expectDead(pid);
  expect((await readdir(directory)).some((name) => name.startsWith(".parser-"))).toBe(false);
  expect(await parseStatementInChild(path, "statement.csv", csv.length)).toMatchObject({
    source: "Amex", rows: [{ amount: -42, description: "BILLA" }],
  });
});

it("immediately kills blocked parsing on shutdown and waits for actual exit before rejecting", async () => {
  const entrypoint = await hangingParser();
  const stop = new AbortController();
  let pid = 0;
  const pending = parseStatementInChild(path, "statement.csv", csv.length, {
    entrypoint, signal: stop.signal, onSpawn: (value) => { pid = value; },
  }).catch((error: unknown) => error);
  await waitForStart();
  const started = Date.now();
  stop.abort();
  expect(await pending).toMatchObject({ code: "WORKER_ABORTED" });
  expect(Date.now() - started).toBeLessThan(2000);
  expectDead(pid);
  expect((await readdir(directory)).some((name) => name.startsWith(".parser-"))).toBe(false);
});

it("rejects malformed or mismatched IPC without accepting a partial result", async () => {
  const entrypoint = join(directory, "bad-ipc.mjs");
  await writeFile(entrypoint, `
    process.once("message", (request) => {
      process.send({type:"result", id:request.id, result:{rows:[{amount:42}]}});
      setInterval(() => {}, 1000);
    });
  `);
  let pid = 0;
  await expect(parseStatementInChild(path, "statement.csv", csv.length, {
    entrypoint, onSpawn: (value) => { pid = value; },
  })).rejects.toMatchObject({ code: "PARSE_INFRASTRUCTURE" });
  expectDead(pid);
});

it("does not expose damaged input in IPC errors and validates stored byte counts", async () => {
  await writeFile(path, Buffer.from("private damaged PDF text"));
  await expect(parseStatementInChild(path, "broken.pdf", 24)).rejects.toMatchObject({
    code: "PARSE_DAMAGED",
    message: expect.not.stringContaining("private"),
  });
  await expect(parseStatementInChild(path, "statement.csv", 1)).rejects.toMatchObject({
    code: "PARSE_DAMAGED",
  });
});

it("never creates a parser when already cancelled", async () => {
  const stop = new AbortController();
  stop.abort();
  let spawned = false;
  await expect(parseStatementInChild(path, "statement.csv", csv.length, {
    signal: stop.signal, onSpawn: () => { spawned = true; },
  })).rejects.toMatchObject({ code: "WORKER_ABORTED" });
  expect(spawned).toBe(false);
  expect(await readdir(directory)).toEqual([path.slice(directory.length + 1)]);
});

it("frees a blocked orphan parser when its isolated parent crashes", async () => {
  const entrypoint = await hangingParser();
  const runtime = pathToFileURL(join(process.cwd(), "src", "lib", "automation", "parser-runtime.ts")).href;
  const parentScript = join(directory, "isolated-parent.mjs");
  await writeFile(parentScript, `
    import { parseStatementInChild } from ${JSON.stringify(runtime)};
    parseStatementInChild(${JSON.stringify(path)}, "statement.csv", ${csv.length}, {
      entrypoint: ${JSON.stringify(entrypoint)},
      onSpawn: (pid) => process.send({pid}),
    }).then(() => process.exit(0), () => process.exit(1));
  `);
  const requireLocal = createRequire(import.meta.url);
  const parent = fork(parentScript, [], {
    execArgv: ["--max-old-space-size=384", "--import", pathToFileURL(requireLocal.resolve("tsx")).href],
    env: { NODE_ENV: "test", PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TSX_DISABLE_CACHE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let pid = 0;
  parent.on("message", (message: { pid: number }) => { pid = message.pid; });
  const closed = new Promise<void>((resolve) => parent.once("close", () => resolve()));
  try {
    await waitForStart();
    expect(pid).toBeGreaterThan(0);
    parent.kill("SIGKILL");
    await closed;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { process.kill(pid, 0); } catch { break; }
      await delay(10);
    }
    expectDead(pid);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await closed;
    if (pid) {
      try { process.kill(pid, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
});

it("preserves incomplete source repair facts through real child IPC without relaxing valid rows", async () => {
  const bytes = Buffer.from(
    "Raiffeisen\nBuchungsdatum;Verwendungszweck/Text;Betrag\n;SPAR;-12,00\n2026-10-05;;-5,00",
  );
  await writeFile(path, bytes);
  const result = await parseStatementInChild(path, "repair.csv", bytes.length);
  expect(result.source).toBe("Raiffeisen");
  expect(result.rows).toEqual([]);
  expect(result.issues).toEqual([
    expect.objectContaining({ draft: expect.objectContaining({ date: "", description: "SPAR" }) }),
    expect.objectContaining({ draft: expect.objectContaining({ date: "2026-10-05", description: "" }) }),
  ]);
  for (const issue of result.issues)
    expect(parserResultSchema.safeParse({
      ...result, rows: [{ ...issue.draft, amount: -12 }],
    }).success).toBe(false);
});

it("preserves typed reupload reasons and bounded evidence through real child IPC", async () => {
  const bytes = Buffer.from("Raiffeisen\nBuchungsdatum;Verwendungszweck/Text;Betrag;Währung\n2026-10-05;SPAR;-12,00;EUR\n2026-10-06;" +
    "X".repeat(1001) + ";-5,00;EUR\n2026-10-07;BILLA;-9,00;USD");
  await writeFile(path, bytes);
  const result = await parseStatementInChild(path, "boundary.csv", bytes.length);
  expect(result.rows).toHaveLength(1);
  expect(result.skipped).toBe(2);
  expect(result.issues).toMatchObject([
    { action: "reupload", reason: "invalid-repair-draft" },
    { action: "reupload", reason: "foreign-currency", evidence: expect.stringContaining("USD") },
  ]);
  for (const issue of result.issues) {
    expect(issue.draft).toBeUndefined();
    expect(issue.evidence!.length).toBeLessThanOrEqual(2000);
  }
  expect(parserResultSchema.safeParse({ ...result, rows: [{ ...result.rows[0], description: "" }] }).success).toBe(false);
});
