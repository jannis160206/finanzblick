import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AccountDatabase } from "@/lib/server/database";
import { AccountError } from "@/lib/server/errors";
import {
  automationJobSchema,
  BACKFILL_BATCH,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_QUEUE_BYTES,
  MAX_UPLOAD_BYTES,
  type AutomationJob,
} from "./schema";
import { merchantSchema, type Merchant } from "./merchants";
import type { DatabaseSync } from "node:sqlite";

const rowSchema = automationJobSchema.extend({
  userId: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type ClaimedJob = z.infer<typeof rowSchema>;
const columns = `id, kind, name, status, progress, attempts, cursor, total, error,
  updated_at AS updatedAt, user_id AS userId, bytes`;

export class AutomationStore {
  constructor(readonly accounts: AccountDatabase) {}

  filePath(id: string): string {
    z.string().uuid().parse(id);
    return join(dirname(this.accounts.path), "statement-uploads", id);
  }

  reserveUpload(
    userId: string,
    id: string,
    name: string,
    bytes: number,
    now = Date.now(),
  ): AutomationJob {
    z.string().uuid().parse(id);
    if (
      !/\.(csv|xlsx|pdf|png|jpe?g|webp)$/i.test(name) ||
      name.length > 200 ||
      /[\x00-\x1f]/.test(name)
    )
      throw new AccountError(400, "Ungültiges Auszugsformat oder Dateiname.");
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_UPLOAD_BYTES)
      throw new AccountError(
        413,
        "Ein Kontoauszug darf höchstens 20 MiB groß sein.",
      );
    return this.accounts.transaction((db) => {
      if (db.prepare("SELECT id FROM automation_jobs WHERE id = ?").get(id))
        throw new AccountError(409, "Dieser Upload wurde bereits angenommen.");
      const active = db
        .prepare(
          `SELECT count(*) AS total FROM automation_jobs
        WHERE user_id = ? AND status NOT IN ('COMPLETED', 'FAILED')`,
        )
        .get(userId);
      if (Number(active?.total) >= 5)
        throw new AccountError(
          429,
          "Höchstens fünf Auszüge gleichzeitig in der Warteschlange.",
        );
      const stored = db
        .prepare("SELECT coalesce(sum(bytes), 0) AS total FROM automation_jobs")
        .get();
      if (Number(stored?.total) + bytes > MAX_QUEUE_BYTES)
        throw new AccountError(
          503,
          "Die Auszugswarteschlange ist voll. Bitte später erneut versuchen.",
        );
      db.prepare(
        `INSERT INTO automation_jobs
        (id, user_id, kind, name, status, bytes, available_at, updated_at, created_at)
        VALUES (?, ?, 'statement', ?, 'UPLOADING', ?, ?, ?, ?)`,
      ).run(id, userId, name, bytes, now, now, now);
      return automationJobSchema.parse(
        db
          .prepare(`SELECT ${columns} FROM automation_jobs WHERE id = ?`)
          .get(id),
      );
    });
  }

  readyUpload(userId: string, id: string): void {
    this.accounts.transaction((db) => {
      const result = db
        .prepare(
          `UPDATE automation_jobs SET status = 'QUEUED', updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'UPLOADING'`,
        )
        .run(Date.now(), id, userId);
      if (result.changes !== 1)
        throw new AccountError(409, "Der Upload ist nicht mehr verfügbar.");
    });
  }

  failUpload(userId: string, id: string): void {
    this.accounts.transaction((db) => {
      db.prepare(
        `UPDATE automation_jobs SET status = 'FAILED', error = 'Upload abgebrochen.',
        updated_at = ? WHERE id = ? AND user_id = ? AND status = 'UPLOADING'`,
      ).run(Date.now(), id, userId);
    });
  }

  enqueueBackfill(
    userId: string,
    now = Date.now(),
    options: { rerun?: boolean } = {},
  ): AutomationJob {
    return this.accounts.transaction((db) => {
      const existing = db
        .prepare(
          `SELECT ${columns} FROM automation_jobs WHERE user_id = ? AND kind = 'backfill'`,
        )
        .get(userId);
      const previous = existing ? automationJobSchema.parse(existing) : null;
      if (
        previous &&
        (!options.rerun ||
          (previous.status !== "COMPLETED" && previous.status !== "FAILED"))
      )
        return previous;
      const id = previous?.id ?? randomUUID();
      if (previous) {
        db.prepare(
          `UPDATE automation_jobs SET status = 'QUEUED', progress = 0,
          attempts = 0, cursor = 0, total = 0, error = NULL, owner = NULL,
          available_at = ?, updated_at = ?, created_at = ?
          WHERE id = ? AND user_id = ? AND kind = 'backfill'`,
        ).run(now, now, now, id, userId);
        db.prepare(
          "DELETE FROM automation_backfill_items WHERE job_id = ?",
        ).run(id);
      } else {
        db.prepare(
          `INSERT INTO automation_jobs
        (id, user_id, kind, name, status, available_at, updated_at, created_at)
        VALUES (?, ?, 'backfill', 'Historische Händlerzuordnung', 'QUEUED', ?, ?, ?)`,
        ).run(id, userId, now, now, now);
      }
      // SQLite snapshots IDs without materializing every account's finance state in JS.
      db.prepare(
        `INSERT INTO automation_backfill_items
        WITH historical_ids AS (
          SELECT json_extract(item.value, '$.id') AS transaction_id
          FROM finance, json_each(finance.state_json, '$.transactions') AS item
          WHERE finance.user_id = ?
          UNION
          SELECT json_extract(item.value, '$.booking.id') AS transaction_id
          FROM finance, json_each(finance.state_json, '$.fixedReceipts') AS item
          WHERE finance.user_id = ? AND json_extract(item.value, '$.booking.id') IS NOT NULL
        )
        SELECT ?, row_number() OVER (ORDER BY transaction_id), transaction_id FROM historical_ids`,
      ).run(userId, userId, id);
      db.prepare(
        `UPDATE automation_jobs SET total =
        (SELECT count(*) FROM automation_backfill_items WHERE job_id = ?) WHERE id = ?`,
      ).run(id, id);
      return automationJobSchema.parse(
        db
          .prepare(`SELECT ${columns} FROM automation_jobs WHERE id = ?`)
          .get(id),
      );
    });
  }

  enqueueAllBackfills(options: { rerun?: boolean } = {}): number {
    const users = this.accounts.read((db) =>
      db.prepare("SELECT user_id FROM finance ORDER BY user_id").all(),
    );
    for (const row of users)
      this.enqueueBackfill(z.string().parse(row.user_id), Date.now(), options);
    return users.length;
  }

  snapshot(userId: string) {
    return this.accounts.read((db) => ({
      revision: Number(
        db.prepare("SELECT revision FROM finance WHERE user_id = ?").get(userId)
          ?.revision ?? 0,
      ),
      jobs: db
        .prepare(
          `SELECT ${columns} FROM automation_jobs WHERE user_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 20`,
        )
        .all(userId)
        .map((row) => automationJobSchema.parse(row)),
    }));
  }

  acquire(owner: string, now = Date.now()): boolean {
    return this.accounts.transaction((db) => {
      const lease = db
        .prepare("SELECT owner, expires_at FROM automation_worker WHERE id = 1")
        .get();
      if (lease && lease.owner !== owner && Number(lease.expires_at) > now)
        return false;
      db.prepare(
        `INSERT INTO automation_worker VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
      ).run(owner, now + LEASE_MS);
      return true;
    });
  }

  heartbeat(owner: string, now = Date.now()): void {
    this.accounts.transaction((db) => {
      const result = db
        .prepare(
          "UPDATE automation_worker SET expires_at = ? WHERE id = 1 AND owner = ? AND expires_at > ?",
        )
        .run(now + LEASE_MS, owner, now);
      if (result.changes !== 1) throw new Error("Worker lease lost");
    });
  }

  private assertOwner(db: DatabaseSync, owner: string, job?: ClaimedJob): void {
    const lease = db
      .prepare("SELECT owner, expires_at FROM automation_worker WHERE id = 1")
      .get();
    if (lease?.owner !== owner || Number(lease.expires_at) <= Date.now())
      throw new Error("Worker lease lost");
    if (
      job &&
      !db
        .prepare(
          `SELECT id FROM automation_jobs WHERE id = ? AND user_id = ?
      AND status = 'PROCESSING' AND owner = ?`,
        )
        .get(job.id, job.userId, owner)
    )
      throw new Error("Job ownership lost");
  }

  claim(owner: string, now = Date.now()): ClaimedJob | null {
    return this.accounts.transaction((db) => {
      this.assertOwner(db, owner);
      const expired = db
        .prepare(
          `SELECT id, attempts FROM automation_jobs
        WHERE status = 'PROCESSING' AND owner != ?`,
        )
        .all(owner);
      for (const row of expired) {
        const attempts = Number(row.attempts) + 1;
        db.prepare(
          `UPDATE automation_jobs SET status = ?, attempts = ?, owner = NULL,
          available_at = ?, error = ?, updated_at = ? WHERE id = ?`,
        ).run(
          attempts >= MAX_ATTEMPTS ? "FAILED" : "RETRYING",
          attempts,
          now + 1000 * 2 ** Math.min(attempts - 1, 6),
          "Worker unterbrochen; Verarbeitung wird fortgesetzt.",
          now,
          String(row.id),
        );
      }
      db.prepare(
        `UPDATE automation_jobs SET status = 'FAILED', error = 'Upload abgebrochen.', updated_at = ?
        WHERE status = 'UPLOADING' AND updated_at < ?`,
      ).run(now, now - 15 * 60_000);
      if (
        db
          .prepare("SELECT id FROM automation_jobs WHERE status = 'PROCESSING'")
          .get()
      )
        return null;
      const row = db
        .prepare(
          `SELECT ${columns} FROM automation_jobs
        WHERE status IN ('QUEUED', 'RETRYING') AND available_at <= ?
        ORDER BY created_at, id LIMIT 1`,
        )
        .get(now);
      if (!row) return null;
      db.prepare(
        `UPDATE automation_jobs SET status = 'PROCESSING', owner = ?, error = NULL, updated_at = ? WHERE id = ?`,
      ).run(owner, now, String(row.id));
      return rowSchema.parse({
        ...row,
        status: "PROCESSING",
        error: null,
        updatedAt: now,
      });
    });
  }

  progress(owner: string, job: ClaimedJob, progress: number): void {
    this.accounts.transaction((db) => {
      this.assertOwner(db, owner, job);
      db.prepare(
        "UPDATE automation_jobs SET progress = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      ).run(
        Math.min(99, Math.max(job.progress, Math.floor(progress))),
        Date.now(),
        job.id,
        job.userId,
      );
    });
  }

  batch(job: ClaimedJob): { ids: Set<string>; cursor: number } {
    const rows = this.accounts.read((db) =>
      db
        .prepare(
          `SELECT transaction_id, sequence FROM automation_backfill_items
      WHERE job_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
        )
        .all(job.id, job.cursor, BACKFILL_BATCH),
    );
    return {
      ids: new Set(rows.map((row) => z.string().parse(row.transaction_id))),
      cursor: rows.length ? Number(rows[rows.length - 1].sequence) : job.total,
    };
  }

  checkpoint(
    db: DatabaseSync,
    owner: string,
    job: ClaimedJob,
    cursor: number,
    completed: boolean,
  ): void {
    this.assertOwner(db, owner, job);
    db.prepare(
      `UPDATE automation_jobs SET cursor = ?, progress = ?, status = ?, owner = NULL,
      error = NULL, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(
      cursor,
      completed ? 100 : Math.floor((100 * cursor) / Math.max(1, job.total)),
      completed ? "COMPLETED" : "QUEUED",
      Date.now(),
      job.id,
      job.userId,
    );
    if (completed)
      db.prepare("DELETE FROM automation_backfill_items WHERE job_id = ?").run(
        job.id,
      );
  }

  fail(
    owner: string,
    job: ClaimedJob,
    message: string,
    now = Date.now(),
  ): void {
    this.accounts.transaction((db) => {
      this.assertOwner(db, owner, job);
      const attempts = job.attempts + 1;
      db.prepare(
        `UPDATE automation_jobs SET attempts = ?, status = ?, owner = NULL,
        error = ?, available_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      ).run(
        attempts,
        attempts >= MAX_ATTEMPTS ? "FAILED" : "RETRYING",
        message,
        now + 1000 * 2 ** Math.min(attempts - 1, 6),
        now,
        job.id,
        job.userId,
      );
    });
  }

  release(owner: string, graceful = true): void {
    this.accounts.transaction((db) => {
      const lease = db
        .prepare("SELECT expires_at FROM automation_worker WHERE owner = ?")
        .get(owner);
      if (graceful && lease && Number(lease.expires_at) > Date.now())
        db.prepare(
          `UPDATE automation_jobs SET status = 'QUEUED', owner = NULL WHERE owner = ? AND status = 'PROCESSING'`,
        ).run(owner);
      db.prepare("DELETE FROM automation_worker WHERE owner = ?").run(owner);
    });
  }

  cleanupCandidates(): string[] {
    return this.accounts.read((db) =>
      db
        .prepare(
          `SELECT id FROM automation_jobs
      WHERE status IN ('COMPLETED', 'FAILED') AND bytes > 0 LIMIT 20`,
        )
        .all()
        .map((row) => String(row.id)),
    );
  }

  cleaned(id: string): void {
    this.accounts.transaction((db) => {
      db.prepare(
        "UPDATE automation_jobs SET bytes = 0 WHERE id = ? AND status IN ('COMPLETED', 'FAILED')",
      ).run(id);
      db.prepare(
        `DELETE FROM automation_jobs WHERE status IN ('COMPLETED', 'FAILED')
        AND kind = 'statement' AND bytes = 0 AND updated_at < ?`,
      ).run(Date.now() - 7 * 86_400_000);
    });
  }

  upsertMerchants(merchants: Merchant[]): void {
    const validated = merchants.map((merchant) =>
      merchantSchema.parse(merchant),
    );
    this.accounts.transaction((db) => {
      const statement =
        db.prepare(`INSERT INTO merchants VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET canonical_name = excluded.canonical_name,
        aliases_json = excluded.aliases_json, regex_json = excluded.regex_json,
        default_category = excluded.default_category, region = excluded.region,
        source = excluded.source, updated_at = excluded.updated_at
        WHERE excluded.updated_at > merchants.updated_at`);
      for (const merchant of validated)
        statement.run(
          merchant.id,
          merchant.canonicalName,
          JSON.stringify(merchant.aliases),
          JSON.stringify(merchant.regexPatterns),
          merchant.defaultCategory,
          merchant.region,
          merchant.source,
          merchant.updatedAt,
        );
    });
  }

  loadMerchants(): Merchant[] {
    return this.accounts.read((db) =>
      db
        .prepare(
          `SELECT id, canonical_name AS canonicalName,
      aliases_json, regex_json, default_category AS defaultCategory, region, source,
      updated_at AS updatedAt FROM merchants`,
        )
        .all()
        .map((row) =>
          merchantSchema.parse({
            ...row,
            aliases: JSON.parse(String(row.aliases_json)),
            regexPatterns: JSON.parse(String(row.regex_json)),
          }),
        ),
    );
  }
}
