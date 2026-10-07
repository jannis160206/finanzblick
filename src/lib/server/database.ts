import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  accountCredentialsSchema,
  accountLoginCredentialsSchema,
  accountUserSchema,
  financeSnapshotSchema,
  financeUpdateSchema,
  type AccountUser,
  type FinanceSnapshot,
} from "@/lib/account-schema";
import type { AppState } from "@/lib/types";
import { AccountConfigError, AccountError } from "./errors";
import { hashPassword, verifyPassword } from "./password";

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
// Large workbook imports can contain 100,000 transactions; bound both input and storage.
export const MAX_FINANCE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_ACCOUNTS = 100;
export const DEFAULT_MAX_STORAGE_BYTES = 256 * 1024 * 1024;

export interface AccountLimits {
  maxAccounts: number;
  maxStorageBytes: number;
}

interface UserRow {
  id: string;
  username: string;
  role: "admin" | "user";
  password_hash: string;
}

export interface AccountSession {
  user: AccountUser;
  token: string;
  expiresAt: number;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function protectPath(path: string): void {
  let current = resolve(path);
  while (true) {
    try {
      const stat = lstatSync(current);
      if (
        stat.isSymbolicLink() ||
        (current === resolve(path) && stat.nlink > 1)
      ) {
        throw new AccountConfigError(
          "Database paths must not contain symbolic links or linked database files.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
}

export class AccountDatabase {
  private readonly db: DatabaseSync;
  private lastCleanup = 0;
  private limits: AccountLimits = {
    maxAccounts: DEFAULT_MAX_ACCOUNTS,
    maxStorageBytes: DEFAULT_MAX_STORAGE_BYTES,
  };

  constructor(readonly path: string) {
    protectPath(path);
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS finance (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          state_json TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          state_bytes INTEGER NOT NULL CHECK (state_bytes >= 0),
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rate_limits (
          key TEXT PRIMARY KEY,
          attempts INTEGER NOT NULL,
          reset_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(reset_at);
      `);
      this.transaction(() => {
        const columns = this.db.prepare("PRAGMA table_info(finance)").all();
        if (!columns.some((column) => column.name === "state_bytes")) {
          this.db.exec(
            "ALTER TABLE finance ADD COLUMN state_bytes INTEGER NOT NULL DEFAULT 0",
          );
          this.db.exec(
            "UPDATE finance SET state_bytes = length(CAST(state_json AS BLOB))",
          );
        }
      });
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  configureLimits(limits: AccountLimits): void {
    if (
      !Number.isSafeInteger(limits.maxAccounts) ||
      limits.maxAccounts < 1 ||
      !Number.isSafeInteger(limits.maxStorageBytes) ||
      limits.maxStorageBytes < 1
    )
      throw new AccountConfigError(
        "Account and storage quotas must be positive safe integers.",
      );
    this.limits = { ...limits };
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private findUser(username: string): UserRow | null {
    return (
      (this.db
        .prepare(
          "SELECT id, username, role, password_hash FROM users WHERE username = ?",
        )
        .get(username) as unknown as UserRow | undefined) ?? null
    );
  }

  async synchronizeAdmin(password: string, now = Date.now(), minimumLength: 4 | 12 = 12): Promise<void> {
    if (password.length < minimumLength || password.length > 128) {
      throw new AccountConfigError(
        `Administrator password must contain ${minimumLength}–128 characters.`,
      );
    }
    const existing = this.findUser("admin");
    if (
      existing &&
      existing.role === "admin" &&
      (await verifyPassword(password, existing.password_hash))
    )
      return;
    const encoded = await hashPassword(password);
    this.transaction(() => {
      const current = this.findUser("admin");
      if (current) {
        this.db
          .prepare(
            "UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?",
          )
          .run(encoded, current.id);
        this.db
          .prepare("DELETE FROM sessions WHERE user_id = ?")
          .run(current.id);
      } else {
        this.db
          .prepare("INSERT INTO users VALUES (?, 'admin', 'admin', ?, ?)")
          .run(randomUUID(), encoded, now);
      }
    });
  }

  async register(
    username: string,
    password: string,
    oldToken?: string | null,
    now = Date.now(),
  ): Promise<AccountSession> {
    const credentials = accountCredentialsSchema.parse({ username, password });
    if (credentials.username === "admin") {
      throw new AccountError(409, "Dieser Benutzername ist nicht verfügbar.");
    }
    if (this.findUser(credentials.username))
      throw new AccountError(409, "Dieser Benutzername ist nicht verfügbar.");
    const encoded = await hashPassword(credentials.password);
    return this.transaction(() => {
      if (this.findUser(credentials.username))
        throw new AccountError(409, "Dieser Benutzername ist nicht verfügbar.");
      const count = this.db
        .prepare("SELECT COUNT(*) AS total FROM users")
        .get() as { total: number };
      if (count.total >= this.limits.maxAccounts)
        throw new AccountError(
          503,
          "Die Registrierung ist momentan nicht verfügbar.",
        );
      const user: AccountUser = {
        id: randomUUID(),
        username: credentials.username,
        role: "user",
      };
      this.db
        .prepare("INSERT INTO users VALUES (?, ?, 'user', ?, ?)")
        .run(user.id, user.username, encoded, now);
      return this.createSession(user, oldToken, now);
    });
  }

  async login(
    username: string,
    password: string,
    oldToken?: string | null,
    now = Date.now(),
  ): Promise<AccountSession> {
    const credentials = accountLoginCredentialsSchema.parse({ username, password });
    const user = this.findUser(credentials.username);
    const valid = await verifyPassword(
      credentials.password,
      user?.password_hash ?? null,
    );
    if (!user || !valid)
      throw new AccountError(401, "Benutzername oder Passwort ist falsch.");
    return this.transaction(() => {
      if (
        this.findUser(credentials.username)?.password_hash !==
        user.password_hash
      ) {
        throw new AccountError(401, "Benutzername oder Passwort ist falsch.");
      }
      return this.createSession(accountUserSchema.parse(user), oldToken, now);
    });
  }

  private createSession(
    user: AccountUser,
    oldToken: string | null | undefined,
    now: number,
  ): AccountSession {
    this.cleanup(now);
    if (oldToken)
      this.db
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .run(hashToken(oldToken));
    const token = randomBytes(32).toString("hex");
    const expiresAt = now + SESSION_SECONDS * 1000;
    this.db
      .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
      .run(hashToken(token), user.id, expiresAt);
    return { user, token, expiresAt };
  }

  currentUser(
    token: string | null | undefined,
    now = Date.now(),
  ): AccountUser | null {
    this.cleanup(now);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = this.db
      .prepare(
        `
      SELECT users.id, users.username, users.role
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `,
      )
      .get(hashToken(token), now);
    return row ? accountUserSchema.parse(row) : null;
  }

  logout(token: string | null | undefined): void {
    if (token)
      this.db
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .run(hashToken(token));
  }

  getFinance(userId: string): FinanceSnapshot {
    const row = this.db
      .prepare("SELECT state_json, revision FROM finance WHERE user_id = ?")
      .get(userId) as { state_json: string; revision: number } | undefined;
    return row
      ? financeSnapshotSchema.parse({
          state: JSON.parse(row.state_json),
          revision: row.revision,
        })
      : { state: null, revision: 0 };
  }

  putFinance(
    userId: string,
    state: AppState,
    revision: number,
    now = Date.now(),
  ): FinanceSnapshot {
    const validated = financeUpdateSchema.parse({ state, revision });
    const serialized = JSON.stringify(validated.state);
    const stateBytes = Buffer.byteLength(serialized);
    if (stateBytes > MAX_FINANCE_BYTES) {
      throw new AccountError(413, "Der Finanzdatenstand überschreitet 20 MiB.");
    }
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT revision, state_bytes FROM finance WHERE user_id = ?")
        .get(userId) as { revision: number; state_bytes: number } | undefined;
      if ((row?.revision ?? 0) !== validated.revision) {
        throw new AccountError(
          409,
          "Die Finanzdaten wurden auf einem anderen Gerät geändert. Bitte den aktuellen Stand laden, bevor erneut gespeichert wird.",
        );
      }
      const stored = this.db
        .prepare("SELECT COALESCE(SUM(state_bytes), 0) AS total FROM finance")
        .get() as { total: number };
      if (
        stored.total - (row?.state_bytes ?? 0) + stateBytes >
        this.limits.maxStorageBytes
      ) {
        throw new AccountError(
          507,
          "Der Speicherplatz für Finanzdaten ist ausgeschöpft. Bitte den Administrator kontaktieren.",
        );
      }
      const nextRevision = validated.revision + 1;
      this.db
        .prepare(
          `
        INSERT INTO finance (user_id, state_json, revision, state_bytes, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json,
          revision = excluded.revision, state_bytes = excluded.state_bytes, updated_at = excluded.updated_at
      `,
        )
        .run(userId, serialized, nextRevision, stateBytes, now);
      return { state: validated.state, revision: nextRevision };
    });
  }

  consumeRateLimit(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): void {
    this.cleanup(now);
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT attempts, reset_at FROM rate_limits WHERE key = ?")
        .get(hashToken(key)) as
        { attempts: number; reset_at: number } | undefined;
      if (row && row.reset_at > now && row.attempts >= limit) {
        throw new AccountError(
          429,
          "Zu viele Versuche. Bitte später erneut versuchen.",
        );
      }
      const attempts = row && row.reset_at > now ? row.attempts + 1 : 1;
      const resetAt = row && row.reset_at > now ? row.reset_at : now + windowMs;
      this.db
        .prepare(
          `
        INSERT INTO rate_limits VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET attempts = excluded.attempts, reset_at = excluded.reset_at
      `,
        )
        .run(hashToken(key), attempts, resetAt);
    });
  }

  private cleanup(now: number): void {
    if (now - this.lastCleanup < 60_000) return;
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").run(now);
    this.lastCleanup = now;
  }
}
