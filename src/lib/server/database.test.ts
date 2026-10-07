import {
  linkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountDatabase, hashToken, SESSION_SECONDS } from "./database";
import { blankTestState, createTestDirectory } from "./test-support";

const password = "test-only-password-123";
let directory: string;
let databases: AccountDatabase[];

function open(): AccountDatabase {
  const database = new AccountDatabase(join(directory, "accounts.sqlite"));
  databases.push(database);
  return database;
}

beforeEach(() => {
  directory = createTestDirectory();
  databases = [];
});

afterEach(() => {
  for (const database of databases) database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("AccountDatabase", () => {
  it("requires strong administrator provisioning unless the runtime explicitly allows local development", async () => {
    const database = open();
    await expect(database.synchronizeAdmin("1234")).rejects.toThrow(/12–128/);
    await database.synchronizeAdmin("1234", Date.now(), 4);
    expect((await database.login("admin", "1234")).user.role).toBe("admin");
    await expect(database.register("alice", "1234")).rejects.toThrow();
  });

  it("rejects hard-linked database files before opening them", () => {
    const original = join(directory, "original.sqlite");
    const linked = join(directory, "accounts.sqlite");
    writeFileSync(original, "");
    linkSync(original, linked);
    expect(() => open()).toThrow(/linked database/);
  });

  it.skipIf(process.platform === "win32")(
    "rejects dangling symbolic links instead of creating the database at their target",
    () => {
      symlinkSync(
        join(directory, "missing-target.sqlite"),
        join(directory, "accounts.sqlite"),
      );
      expect(() => open()).toThrow(/symbolic links/);
    },
  );

  it("persists isolated complete snapshots and sessions across reopen", async () => {
    let database = open();
    const alice = await database.register("Alice", password);
    const bob = await database.register("Bob", password);
    expect(alice.user.username).toBe("alice");
    expect(database.getFinance(alice.user.id)).toEqual({
      state: null,
      revision: 0,
    });
    expect(database.getFinance(bob.user.id)).toEqual({
      state: null,
      revision: 0,
    });
    const state = {
      ...blankTestState(),
      seasonalTheme: { reduceMotion: true },
      ignoredStatementKeys: ["test"],
    };
    expect(database.putFinance(alice.user.id, state, 0)).toEqual({
      state,
      revision: 1,
    });
    database.close();
    databases = [];
    database = open();
    expect(database.currentUser(alice.token)).toEqual(alice.user);
    expect(database.getFinance(alice.user.id)).toEqual({ state, revision: 1 });
    expect(database.getFinance(bob.user.id)).toEqual({
      state: null,
      revision: 0,
    });
  });

  it("uses transactional revisions across connections and never overwrites a newer snapshot", async () => {
    const first = open();
    const session = await first.register("alice", password);
    const second = open();
    const initial = blankTestState();
    const changed = { ...initial, seasonalTheme: { reduceMotion: true } };
    first.putFinance(session.user.id, initial, 0);
    expect(() => second.putFinance(session.user.id, changed, 0)).toThrow(
      /anderen Gerät/,
    );
    expect(second.getFinance(session.user.id)).toEqual({
      state: initial,
      revision: 1,
    });
    second.putFinance(session.user.id, changed, 1);
    expect(() => first.putFinance(session.user.id, initial, 1)).toThrow(
      /anderen Gerät/,
    );
    expect(first.getFinance(session.user.id)).toEqual({
      state: changed,
      revision: 2,
    });
  });

  it("reserves the administrator name, validates credentials, and rejects duplicate registrations", async () => {
    const database = open();
    await expect(database.register("AdMiN", password)).rejects.toMatchObject({
      status: 409,
    });
    await expect(database.register("bad name", password)).rejects.toThrow();
    await expect(database.register("alice", "too short")).rejects.toThrow();
    await database.register("Alice", password);
    await expect(database.register("ALICE", password)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("gives identical errors for unknown users and wrong passwords without trimming passwords", async () => {
    const database = open();
    await database.register("alice", ` ${password} `);
    await expect(database.login("alice", password)).rejects.toMatchObject({
      status: 401,
    });
    await expect(database.login("unknown", password)).rejects.toMatchObject({
      status: 401,
      message: "Benutzername oder Passwort ist falsch.",
    });
    expect((await database.login("ALICE", ` ${password} `)).user.username).toBe(
      "alice",
    );
  });

  it("rotates, revokes, and expires sessions and stores only hashed tokens/passwords", async () => {
    const database = open();
    const now = 1_800_000_000_000;
    const first = await database.register("alice", password, null, now);
    const second = await database.login(
      "alice",
      password,
      first.token,
      now + 1,
    );
    expect(second.token).not.toBe(first.token);
    expect(second.token).toMatch(/^[a-f0-9]{64}$/);
    expect(database.currentUser(first.token, now + 2)).toBeNull();
    expect(database.currentUser(second.token, second.expiresAt - 1)).toEqual(
      first.user,
    );
    const inspector = new DatabaseSync(join(directory, "accounts.sqlite"));
    try {
      expect(
        inspector.prepare("SELECT token_hash FROM sessions").get(),
      ).toEqual({ token_hash: hashToken(second.token) });
      expect(
        inspector.prepare("SELECT password_hash FROM users").get(),
      ).toMatchObject({ password_hash: expect.stringMatching(/^scrypt-v1\$/) });
    } finally {
      inspector.close();
    }
    expect(
      database.currentUser(second.token, now + 1 + SESSION_SECONDS * 1000),
    ).toBeNull();
    const third = await database.login("alice", password);
    database.logout(third.token);
    expect(database.currentUser(third.token)).toBeNull();
    if (process.platform !== "win32") {
      expect(statSync(join(directory, "accounts.sqlite")).mode & 0o777).toBe(
        0o600,
      );
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it("updates administrator credentials idempotently, revoking sessions while preserving ID and finances", async () => {
    const database = open();
    await database.synchronizeAdmin(password);
    const original = await database.login("admin", password);
    const state = blankTestState();
    database.putFinance(original.user.id, state, 0);
    await database.synchronizeAdmin(password);
    expect(database.currentUser(original.token)).toEqual(original.user);
    const changedPassword = "new-test-admin-password";
    await database.synchronizeAdmin(changedPassword);
    expect(database.currentUser(original.token)).toBeNull();
    await expect(database.login("admin", password)).rejects.toMatchObject({
      status: 401,
    });
    const changed = await database.login("admin", changedPassword);
    expect(changed.user).toEqual(original.user);
    expect(changed.user.role).toBe("admin");
    expect(database.getFinance(changed.user.id)).toEqual({
      state,
      revision: 1,
    });
  });

  it("retains rate limits across database reopen and releases expired windows", () => {
    let database = open();
    const now = 1_800_000_000_000;
    database.consumeRateLimit("login:alice", 2, 60_000, now);
    database.close();
    databases = [];
    database = open();
    database.consumeRateLimit("login:alice", 2, 60_000, now + 1);
    expect(() =>
      database.consumeRateLimit("login:alice", 2, 60_000, now + 2),
    ).toThrow(/Zu viele/);
    expect(() =>
      database.consumeRateLimit("login:alice", 2, 60_000, now + 60_000),
    ).not.toThrow();
  });

  it("handles concurrent duplicate registration without creating multiple accounts", async () => {
    const database = open();
    const results = await Promise.allSettled([
      database.register("alice", password),
      database.register("ALICE", password),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 409 } });
  });

  it("enforces account and aggregate storage quotas without changing stored revisions", async () => {
    const database = open();
    database.configureLimits({
      maxAccounts: 2,
      maxStorageBytes: 256 * 1024 * 1024,
    });
    const alice = await database.register("alice", password);
    const bob = await database.register("bob", password);
    await expect(database.register("carol", password)).rejects.toMatchObject({
      status: 503,
    });
    const state = blankTestState();
    const bytes = Buffer.byteLength(JSON.stringify(state));
    database.configureLimits({ maxAccounts: 2, maxStorageBytes: bytes * 2 });
    database.putFinance(alice.user.id, state, 0);
    database.putFinance(bob.user.id, state, 0);
    const enlarged = { ...state, seasonalTheme: { reduceMotion: true } };
    expect(() => database.putFinance(alice.user.id, enlarged, 1)).toThrow(
      /Speicherplatz/,
    );
    expect(database.getFinance(alice.user.id)).toEqual({ state, revision: 1 });
    expect(database.putFinance(alice.user.id, state, 1)).toEqual({
      state,
      revision: 2,
    });
    const smaller = {
      ...enlarged,
      settings: { ...enlarged.settings, interestRates: [] },
    };
    database.configureLimits({ maxAccounts: 2, maxStorageBytes: bytes });
    expect(() => database.putFinance(bob.user.id, smaller, 1)).toThrow(
      /Speicherplatz/,
    );
    expect(database.getFinance(bob.user.id)).toEqual({ state, revision: 1 });
  });

  it("migrates existing snapshot byte counts on reopen without losing data", () => {
    const state = blankTestState();
    const serialized = JSON.stringify(state);
    const legacy = new DatabaseSync(join(directory, "accounts.sqlite"));
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
        password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE finance (user_id TEXT PRIMARY KEY REFERENCES users(id), state_json TEXT NOT NULL,
        revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO users VALUES ('legacy', 'legacy', 'user', 'unused-test-hash', 0);
    `);
    legacy
      .prepare("INSERT INTO finance VALUES ('legacy', ?, 5, 0)")
      .run(serialized);
    legacy.close();
    const database = open();
    expect(database.getFinance("legacy")).toEqual({ state, revision: 5 });
    database.configureLimits({
      maxAccounts: 2,
      maxStorageBytes: Buffer.byteLength(serialized),
    });
    expect(() =>
      database.putFinance(
        "legacy",
        { ...state, seasonalTheme: { reduceMotion: true } },
        5,
      ),
    ).toThrow(/Speicherplatz/);
    expect(database.putFinance("legacy", state, 5)).toEqual({
      state,
      revision: 6,
    });
  });
});
