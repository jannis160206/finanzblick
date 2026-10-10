import { execFile } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";

const run = promisify(execFile);
let directory: string;
let accounts: AccountDatabase;
beforeEach(() => {
  directory = createTestDirectory();
  accounts = new AccountDatabase(join(directory, "operator.sqlite"));
  accounts.transaction((db) =>
    db
      .prepare(
        "INSERT INTO users VALUES ('operator', 'operator', 'user', 'fixture-not-a-password', 1)",
      )
      .run(),
  );
  accounts.putFinance("operator", blankTestState(), 0);
});
afterEach(async () => {
  accounts.close();
  await rm(directory, { recursive: true, force: true });
});

function command(args: string[]) {
  return run(
    process.execPath,
    ["--import", "tsx", resolve("scripts", "merchant-complete.ts"), ...args],
    {
      timeout: 20_000,
      maxBuffer: 128 * 1024,
      env: { ...process.env, NODE_ENV: "test" },
    },
  );
}
function options() {
  return [
    "--database",
    accounts.path,
    "--account",
    "operator",
    "--rights-reference",
    "Synthetic operator private usage declaration",
  ];
}

it("exposes the bounded operator workflow without credentials or .env loading", async () => {
  const result = await command(["--help"]);
  expect(result.stdout).toContain("no .env loading");
  expect(result.stdout).toContain("200-entity");
  expect(result.stdout).toContain("no finance");
});

it("requires explicit operator credentials and never seeds on absent account input", async () => {
  const before = accounts.getFinance("operator");
  await expect(command(["--database", accounts.path])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Explicit --database"),
  });
  expect(accounts.getFinance("operator")).toEqual(before);
  expect(
    accounts.read(
      (db) =>
        db.prepare("SELECT count(*) AS count FROM merchants").get()?.count,
    ),
  ).toBe(0);
});

it("rejects unknown reviewed identities before any catalogue or logo writes", async () => {
  const manifest = join(directory, "unknown.json");
  await writeFile(
    manifest,
    JSON.stringify({
      entries: [
        {
          wiki: "de",
          merchantId: "unknown",
          wikidataId: "Q123",
          filename: "Example.svg",
          evidence:
            "Synthetic operator review of a nonexistent public identity, intentionally invalid for preflight.",
        },
      ],
    }),
  );
  const before = accounts.getFinance("operator");
  await expect(
    command([...options(), "--wikimedia-manifest", manifest]),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("unique known merchant identities"),
  });
  expect(accounts.getFinance("operator")).toEqual(before);
  expect(
    accounts.read(
      (db) =>
        db.prepare("SELECT count(*) AS count FROM merchants").get()?.count,
    ),
  ).toBe(0);
});

it("does not import to a different or nonexistent account", async () => {
  await expect(
    command([...options(), "--account", "foreign"]),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Selected account does not exist"),
  });
  expect(
    accounts.read(
      (db) =>
        db.prepare("SELECT count(*) AS count FROM merchants").get()?.count,
    ),
  ).toBe(0);
});
