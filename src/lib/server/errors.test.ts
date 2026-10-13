import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createTestDirectory } from "./test-support";
import { isSqliteContentionError } from "./errors";
import { accountErrorResponse } from "./http";
afterEach(() => vi.restoreAllMocks());

it("preserves safe public errors across route-module instances without exposing configuration details", async () => {
  const original = await import("./errors");
  const conflict = new original.AccountError(409, "Dieser Benutzername ist nicht verfügbar.");
  const configuration = new original.AccountConfigError("Private configuration detail");
  vi.resetModules();
  const current = await import("./errors");
  const { accountErrorResponse } = await import("./http");
  expect(conflict).not.toBeInstanceOf(current.AccountError);
  expect(accountErrorResponse(conflict).status).toBe(409);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const response = accountErrorResponse(configuration);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Die Kontoanmeldung ist momentan nicht verfügbar." });
  const unexpected = new Error("Private database detail");
  unexpected.name = "AccountError";
  expect(await accountErrorResponse(unexpected).json()).toEqual({ error: "Die Anfrage konnte nicht verarbeitet werden." });
});

it("classifies real Node SQLite BUSY, BUSY_SNAPSHOT and LOCKED without exposing diagnostics", async () => {
  const directory = createTestDirectory();
  const first = new DatabaseSync(join(directory, "codes.sqlite"));
  const second = new DatabaseSync(join(directory, "codes.sqlite"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  function capture(action: () => void): unknown {
    try { action(); } catch (error) { return error; }
    throw new Error("Expected SQLite failure");
  }
  try {
    first.exec("PRAGMA journal_mode = WAL; CREATE TABLE test (n INTEGER); INSERT INTO test VALUES (1)");
    second.exec("PRAGMA busy_timeout = 1");
    first.exec("BEGIN IMMEDIATE");
    const busy = capture(() => second.exec("BEGIN IMMEDIATE"));
    first.exec("ROLLBACK");
    second.exec("BEGIN; SELECT * FROM test");
    first.exec("UPDATE test SET n = 2");
    const snapshot = capture(() => second.exec("UPDATE test SET n = 3"));
    second.exec("ROLLBACK");
    const rows = first.prepare("SELECT * FROM test").iterate();
    rows.next();
    let locked: unknown;
    try { locked = capture(() => first.exec("DROP TABLE test")); }
    finally { rows.return?.(); }
    for (const [error, errcode] of [[busy, 5], [snapshot, 517], [locked, 6]]) {
      expect(error).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode });
      expect(isSqliteContentionError(error)).toBe(true);
      const response = accountErrorResponse(error);
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("5");
      expect(await response.json()).toEqual({
        error: "Der Server ist vorübergehend ausgelastet. Bitte kurz warten und erneut versuchen.",
      });
    }
    expect(log).not.toHaveBeenCalled();
  } finally {
    first.close(); second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  new Error("database is locked"),
  { code: "ERR_SQLITE_ERROR", errcode: 5 },
  Object.assign(new Error("private"), { code: "SQLITE_BUSY", errcode: 5 }),
  Object.assign(new Error("private"), { code: "ERR_SQLITE_ERROR", errcode: "5" }),
  Object.assign(new Error("private"), { code: "ERR_SQLITE_ERROR", errcode: 5.5 }),
  Object.assign(new Error("private"), { code: "ERR_SQLITE_ERROR", errcode: -251 }),
  Object.assign(new Error("private"), { code: "ERR_SQLITE_ERROR", errcode: 0x100000005 }),
  Object.assign(new Error("private"), { code: "ERR_SQLITE_ERROR", errcode: 19 }),
  Object.assign(new Error("private"), { code: "ERR_SQLITE_ERROR", errcode: 10 }),
])("keeps unrelated and malformed errors private and non-retryable (%#)", async (error) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(isSqliteContentionError(error)).toBe(false);
  const response = accountErrorResponse(error);
  expect(response.status).toBe(500);
  expect(response.headers.get("Retry-After")).toBeNull();
  expect(await response.json()).toEqual({ error: "Die Anfrage konnte nicht verarbeitet werden." });
});
