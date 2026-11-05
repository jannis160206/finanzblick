import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { createTestDirectory } from "@/lib/server/test-support";
import { AutomationStore } from "./store";

it("processes persisted uploads in an independent, memory-bounded TypeScript process", async () => {
  const directory = createTestDirectory();
  const path = join(directory, "process.sqlite");
  const database = new AccountDatabase(path);
  let child: ChildProcess | undefined;
  let output = "";
  try {
    const user = (await database.register("alice", "test-only-password-123"))
      .user;
    const store = new AutomationStore(database);
    const bytes = Buffer.from(
      'American Express\nDatum,Beschreibung,Karteninhaber,Kartennummer,Betrag\n08.10.2026,PENNY FILIALE 1234,Test User,XXXX-1001,"42,00"',
    );
    const id = randomUUID();
    store.reserveUpload(user.id, id, "statement.csv", bytes.length);
    await mkdir(dirname(store.filePath(id)), { recursive: true });
    await writeFile(store.filePath(id), bytes);
    store.readyUpload(user.id, id);
    child = spawn(
      process.execPath,
      [
        "--max-old-space-size=384",
        "--import",
        "tsx",
        join("scripts", "statement-worker.ts"),
      ],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          TSX_DISABLE_CACHE: "1",
          NODE_ENV: "test",
          FINANZBLICK_AUTH: "true",
          FINANZBLICK_DATABASE_PATH: path,
          FINANZBLICK_ORIGIN: "http://localhost:3000",
          FINANZBLICK_ADMIN_PASSWORD: "test-only-password-123",
          FINANZBLICK_MAX_ACCOUNTS: "100",
          FINANZBLICK_MAX_STORAGE_MB: "256",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    // A cold tsx start can take well over 10 s on a busy machine.
    for (let attempt = 0; attempt < 600; attempt++) {
      if (store.snapshot(user.id).jobs[0].status === "COMPLETED") break;
      if (child.exitCode !== null)
        throw new Error(`Worker exited unexpectedly: ${output}`);
      await delay(100);
    }
    expect(child.exitCode).toBeNull();
    expect(output).toContain("concurrency=1");
    expect(store.snapshot(user.id).jobs[0].status).toBe("COMPLETED");
    expect(database.getFinance(user.id).state?.transactions[0]).toMatchObject({
      merchantAlias: "PENNY",
      amount: -42,
      requires_manual_review: false,
    });
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        child!.once("exit", () => resolve()),
      );
      child.kill("SIGTERM");
      await exited;
    }
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
