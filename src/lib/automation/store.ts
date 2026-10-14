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
import {
  merchantSchema,
  normalizeMerchantText,
  type Merchant,
} from "./merchants";
import { merchantMarksRequestSchema } from "./merchant-presentation-schema";
import {
  privateMerchantLogoSchema,
  type PrivateMerchantLogo,
} from "./merchant-logo-metadata";
import type { DatabaseSync } from "node:sqlite";
import { merchantLogoVersion } from "./merchant-logo-version";
import {
  readAuthorizedLogoGrant,
  readAuthorizedLogoCandidates,
  saveAuthorizedLogoGrant,
} from "./merchant-logo-grants";
import {
  logoAccountIdSchema,
  type AuthorizedMerchantLogo,
} from "./merchant-logo-grant-metadata";
import { merchantCatalogueStatus } from "./catalogue-refresh";
import {
  automationErrorCodeSchema,
  automationFailure,
  type AutomationErrorCode,
  type AutomationFailure,
} from "./errors";
import {
  IMPORT_RESULT_RETENTION_MS,
  importResultSchema,
  type ImportResult,
} from "@/lib/import/result-schema";

const rowSchema = automationJobSchema.safeExtend({
  userId: z.string(),
  bytes: z.number().int().nonnegative(),
  errorCode: automationErrorCodeSchema.nullable().default(null),
});
export type ClaimedJob = z.infer<typeof rowSchema>;
export class WorkerLeaseError extends Error {
  constructor() {
    super("Worker lease lost");
    this.name = "WorkerLeaseError";
  }
}

const columns = `id, kind, name, status, progress, attempts, cursor, total, error,
  error_code AS errorCode,
  outcome_json AS result,
  updated_at AS updatedAt, user_id AS userId, bytes`;

function jobFromRow(row: Record<string, unknown> | undefined): AutomationJob & { errorCode: AutomationErrorCode | null } {
  if (!row) throw new Error("Automation job missing");
  const job = automationJobSchema.parse({
    ...row,
    result: typeof row.result === "string" ? JSON.parse(row.result) : row.result ?? null,
  });
  if (job.result && (job.kind !== "statement" || job.result.uploadId !== job.id))
    throw new Error("Import result/job mismatch");
  return {
    ...job,
    errorCode: automationErrorCodeSchema.nullable().parse(row.errorCode ?? null),
  };
}

const merchantColumns = `id, canonical_name AS canonicalName, aliases_json, regex_json,
  default_category AS defaultCategory, region, source, updated_at AS updatedAt,
  city, license, attribution, logo_json, wikidata_id AS wikidataId,
  requires_category_evidence AS requiresCategoryEvidence, matchable`;

function merchantFromRow(row: Record<string, unknown>): Merchant {
  const legacyBrand =
    row.source === "osm" && typeof row.id === "string"
      ? /^osm-brand-(Q[1-9]\d{0,13})-[a-f0-9]{16}$/.exec(row.id)?.[1]
      : undefined;
  return merchantSchema.parse({
    ...row,
    wikidataId: row.wikidataId ?? legacyBrand ?? null,
    requiresCategoryEvidence: row.requiresCategoryEvidence === 1,
    matchable: row.matchable === 1,
    aliases: JSON.parse(String(row.aliases_json)),
    regexPatterns: JSON.parse(String(row.regex_json)),
    logo: row.logo_json === null ? null : JSON.parse(String(row.logo_json)),
  });
}

export function readMerchantDefinitions(db: DatabaseSync): Merchant[] {
  return db
    .prepare(`SELECT ${merchantColumns} FROM merchants`)
    .all()
    .map(merchantFromRow);
}

function retainLogoAttribution(db: DatabaseSync, reference: Merchant): void {
  if (!reference.logo) return;
  const version = merchantLogoVersion(reference.logo);
  const existing = db
    .prepare(
      "SELECT 1 FROM merchant_logo_attributions WHERE merchant_id = ? AND version = ?",
    )
    .get(reference.id, version);
  if (
    !existing &&
    Number(
      db.prepare("SELECT count(*) AS n FROM merchant_logo_attributions").get()
        ?.n,
    ) >= 10_000
  )
    throw new RangeError("Logo attribution archive limit reached.");
  db.prepare(
    `INSERT OR IGNORE INTO merchant_logo_attributions VALUES (?, ?, ?, ?)`,
  ).run(
    reference.id,
    version,
    reference.canonicalName,
    JSON.stringify(reference.logo),
  );
}

export class AutomationStore {
  constructor(readonly accounts: AccountDatabase) {}

  authorizedLogo(userId: string, merchantId: string, version?: string) {
    return readAuthorizedLogoGrant(this.accounts, userId, merchantId, version);
  }

  saveAuthorizedLogo(
    userId: string,
    merchantId: string,
    logo: AuthorizedMerchantLogo,
  ) {
    const merchant = this.getMerchant(merchantId);
    if (!merchant) throw new Error("Unknown public merchant ID");
    return saveAuthorizedLogoGrant(
      this.accounts,
      userId,
      merchantId,
      merchant.canonicalName,
      logo,
    );
  }

  authorizedLogoCandidates(userId: string, ids: string[]) {
    logoAccountIdSchema.parse(userId);
    const { merchantIds } = merchantMarksRequestSchema.parse({
      merchantIds: ids,
    });
    const requested = new Map(
      [...new Set(merchantIds)].map((id) => [id, this.getMerchant(id)]),
    );
    const entities = [
      ...new Set(
        [...requested.values()].flatMap((merchant) =>
          merchant?.wikidataId ? [merchant.wikidataId] : [],
        ),
      ),
    ];
    const current = readAuthorizedLogoCandidates(
      this.accounts,
      userId,
      [...requested.keys()],
      entities,
    );
    const references = current.flatMap((grant) => {
      const merchant =
        requested.get(grant.merchantId) ?? this.getMerchant(grant.merchantId);
      return merchant &&
        normalizeMerchantText(grant.canonicalName) ===
          normalizeMerchantText(merchant.canonicalName) &&
        (grant.logo.provenance.kind === "local-file" ||
          grant.logo.provenance.wikidataId === merchant.wikidataId)
        ? [{ merchant, grant }]
        : [];
    });
    return new Map(
      [...new Set(merchantIds)].map((id) => {
        const merchant = requested.get(id);
        const direct = references.filter(
          (reference) =>
            reference.merchant.id === id &&
            (reference.grant.logo.provenance.kind === "local-file" ||
              reference.grant.logo.provenance.wikidataId ===
                merchant?.wikidataId),
        );
        const related = merchant?.wikidataId
          ? references.filter(
              (reference) =>
                reference.merchant.id !== id &&
                reference.grant.logo.provenance.kind !== "local-file" &&
                reference.grant.logo.provenance.wikidataId ===
                  merchant.wikidataId &&
                reference.merchant.wikidataId === merchant.wikidataId &&
                reference.merchant.region === merchant.region &&
                normalizeMerchantText(reference.merchant.canonicalName) ===
                  normalizeMerchantText(merchant.canonicalName),
            )
          : [];
        return [
          id,
          [...direct, ...related].map((reference) => reference.grant),
        ];
      }),
    );
  }

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
      return jobFromRow(
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

  failUpload(userId: string, id: string): boolean {
    return this.accounts.transaction((db) => {
      const result = db.prepare(
        `UPDATE automation_jobs SET status = 'FAILED', error = 'Upload abgebrochen.',
        updated_at = ? WHERE id = ? AND user_id = ? AND status = 'UPLOADING'`,
      ).run(Date.now(), id, userId);
      return result.changes === 1 || db.prepare(
        "SELECT id FROM automation_jobs WHERE id = ? AND user_id = ? AND status = 'FAILED'",
      ).get(id, userId) !== undefined;
    });
  }

  enqueueBackfill(
    userId: string,
    now = Date.now(),
    options: { rerun?: boolean; onceVersion?: string; workerOwner?: string } = {},
  ): AutomationJob {
    if (options.onceVersion !== undefined) {
      z.string()
        .regex(/^[a-z0-9-]{1,80}$/)
        .parse(options.onceVersion);
      if (options.rerun)
        throw new AccountError(
          400,
          "Ein einmaliger Nachlauf darf nicht zurückgesetzt werden.",
        );
    }
    return this.accounts.transaction((db) => {
      if (options.workerOwner) this.assertOwner(db, options.workerOwner);
      const existing = db
        .prepare(
          `SELECT ${columns} FROM automation_jobs WHERE user_id = ? AND kind = 'backfill'
          ORDER BY (status NOT IN ('COMPLETED', 'FAILED')) DESC, created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(userId);
      let previous = existing ? jobFromRow(existing) : null;
      if (options.onceVersion) {
        const pass = db
          .prepare(
            `SELECT ${columns} FROM automation_jobs WHERE user_id = ? AND id =
              (SELECT job_id FROM automation_backfill_passes WHERE user_id = ? AND version = ?)`,
          )
          .get(userId, userId, options.onceVersion);
        if (pass) return jobFromRow(pass);
        if (
          previous &&
          previous.status !== "COMPLETED" &&
          previous.status !== "FAILED"
        )
          throw new AccountError(
            409,
            "Der bisherige Backfill läuft noch. Den einmaligen Nachlauf danach starten.",
          );
      }
      if (
        previous &&
        (options.rerun || options.onceVersion) &&
        db
          .prepare(
            "SELECT job_id FROM automation_backfill_passes WHERE job_id = ?",
          )
          .get(previous.id)
      ) {
        if (options.rerun)
          throw new AccountError(
            409,
            "Ein versionierter Nachlauf darf nicht zurückgesetzt werden.",
          );
        previous = null;
      }
      if (
        previous &&
        ((!options.rerun && !options.onceVersion) ||
          (previous.status !== "COMPLETED" && previous.status !== "FAILED"))
      )
        return previous;
      const id = previous?.id ?? randomUUID();
      if (previous) {
        db.prepare(
          `UPDATE automation_jobs SET status = 'QUEUED', progress = 0,
          attempts = 0, cursor = 0, total = 0, error = NULL, error_code = NULL,
          outcome_json = NULL, owner = NULL,
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
          UNION
          SELECT json_extract(item.value, '$.draft.id') AS transaction_id
          FROM finance, json_each(finance.state_json, '$.reviewQueue') AS item
          WHERE finance.user_id = ? AND json_extract(item.value, '$.kind') = 'booking'
          UNION
          SELECT json_extract(booking.value, '$.id') AS transaction_id
          FROM finance, json_each(finance.state_json, '$.reviewQueue') AS item,
            json_each(item.value, '$.change.bookings') AS booking
          WHERE finance.user_id = ? AND json_extract(item.value, '$.kind') = 'fixed'
        )
        SELECT ?, row_number() OVER (ORDER BY transaction_id), transaction_id FROM historical_ids`,
      ).run(userId, userId, userId, userId, id);
      db.prepare(
        `UPDATE automation_jobs SET total =
        (SELECT count(*) FROM automation_backfill_items WHERE job_id = ?) WHERE id = ?`,
      ).run(id, id);
      if (options.onceVersion)
        db.prepare(
          "INSERT INTO automation_backfill_passes (user_id, version, job_id) VALUES (?, ?, ?)",
        ).run(userId, options.onceVersion, id);
      return jobFromRow(
        db
          .prepare(`SELECT ${columns} FROM automation_jobs WHERE id = ?`)
          .get(id),
      );
    });
  }

  enqueueAllBackfills(
    options: { rerun?: boolean; onceVersion?: string } = {},
  ): number {
    const users = this.accounts.read((db) =>
      db.prepare("SELECT user_id FROM finance ORDER BY user_id").all(),
    );
    for (const row of users)
      this.enqueueBackfill(z.string().parse(row.user_id), Date.now(), options);
    return users.length;
  }

  snapshot(userId: string) {
    const catalogue = merchantCatalogueStatus(this.accounts);
    return this.accounts.read((db) => ({
      ...(catalogue ? { catalogue } : {}),
      revision: Number(
        db.prepare("SELECT revision FROM finance WHERE user_id = ?").get(userId)
          ?.revision ?? 0,
      ),
      jobs: db
        .prepare(
          `SELECT ${columns} FROM automation_jobs WHERE user_id = ?
        ORDER BY (status NOT IN ('COMPLETED', 'FAILED')) DESC, created_at DESC, id DESC LIMIT 20`,
        )
        .all(userId)
        .map(jobFromRow),
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
      if (result.changes !== 1) throw new WorkerLeaseError();
    });
  }

  assertOwner(db: DatabaseSync, owner: string, job?: ClaimedJob): void {
    const lease = db
      .prepare("SELECT owner, expires_at FROM automation_worker WHERE id = 1")
      .get();
    if (lease?.owner !== owner || Number(lease.expires_at) <= Date.now())
      throw new WorkerLeaseError();
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
          automationFailure("WORKER_INTERRUPTED").message,
          now,
          String(row.id),
        );
        db.prepare("UPDATE automation_jobs SET error_code = ? WHERE id = ?")
          .run("WORKER_INTERRUPTED", String(row.id));
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
        ORDER BY (kind = 'backfill'), created_at, id LIMIT 1`,
        )
        .get(now);
      if (!row) return null;
      db.prepare(
        `UPDATE automation_jobs SET status = 'PROCESSING', owner = ?, error = NULL, error_code = NULL, updated_at = ? WHERE id = ?`,
      ).run(owner, now, String(row.id));
      return rowSchema.parse({
        ...row,
        result: jobFromRow(row).result,
        status: "PROCESSING",
        error: null,
        errorCode: null,
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
    result?: ImportResult,
  ): void {
    this.assertOwner(db, owner, job);
    if (result) {
      const validated = importResultSchema.parse(result);
      if (!completed || job.kind !== "statement" || validated.uploadId !== job.id)
        throw new Error("Import result/job mismatch");
      db.prepare("UPDATE automation_jobs SET outcome_json = ? WHERE id = ? AND user_id = ?")
        .run(JSON.stringify(validated), job.id, job.userId);
    }
    db.prepare(
      `UPDATE automation_jobs SET cursor = ?, progress = ?, status = ?, owner = NULL,
      error = NULL, error_code = NULL, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).run(
      cursor,
      completed ? 100 : Math.floor((100 * cursor) / Math.max(1, job.total)),
      completed ? "COMPLETED" : "QUEUED",
      Date.now(),
      job.id,
      job.userId,
    );
    if (completed) {
      db.prepare(
        "UPDATE automation_backfill_passes SET completed_at = ? WHERE job_id = ? AND completed_at IS NULL",
      ).run(Date.now(), job.id);
      db.prepare("DELETE FROM automation_backfill_items WHERE job_id = ?").run(
        job.id,
      );
    }
  }

  fail(
    owner: string,
    job: ClaimedJob,
    failure: string | AutomationFailure,
    now = Date.now(),
  ): void {
    this.accounts.transaction((db) => {
      this.assertOwner(db, owner, job);
      const attempts = job.attempts + 1;
      const retryable = typeof failure === "string" || failure.retryable;
      db.prepare(
        `UPDATE automation_jobs SET attempts = ?, status = ?, owner = NULL,
        error = ?, error_code = ?, available_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      ).run(
        attempts,
        !retryable || attempts >= MAX_ATTEMPTS ? "FAILED" : "RETRYING",
        typeof failure === "string" ? failure : failure.message,
        typeof failure === "string" ? null : failure.code,
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
          `UPDATE automation_jobs SET status = 'QUEUED', owner = NULL,
            error = ?, error_code = 'WORKER_ABORTED', updated_at = ?
            WHERE owner = ? AND status = 'PROCESSING'`,
        ).run(automationFailure("WORKER_ABORTED").message, Date.now(), owner);
      db.prepare("DELETE FROM automation_worker WHERE owner = ?").run(owner);
    });
  }

  cancel(owner: string, job: ClaimedJob): void {
    this.accounts.transaction((db) => {
      this.assertOwner(db, owner, job);
      db.prepare(
        `UPDATE automation_jobs SET status = 'QUEUED', owner = NULL,
          error = ?, error_code = 'WORKER_ABORTED', updated_at = ?
          WHERE id = ? AND user_id = ?`,
      ).run(automationFailure("WORKER_ABORTED").message, Date.now(), job.id, job.userId);
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
    });
  }

  pruneCompletedStatements(now = Date.now()): void {
    this.accounts.transaction((db) => {
      db.prepare(
        `DELETE FROM automation_jobs WHERE status IN ('COMPLETED', 'FAILED')
        AND kind = 'statement' AND bytes = 0 AND updated_at <= ?`,
      ).run(now - IMPORT_RESULT_RETENTION_MS);
    });
  }

  upsertMerchants(
    merchants: Merchant[],
    options: { replaceLogos?: boolean; workerOwner?: string; checkpoint?: (db: DatabaseSync) => void } = {},
  ): void {
    const validated = merchants.map((merchant) =>
      merchantSchema.parse(merchant),
    );
    this.accounts.transaction((db) => {
      if (options.workerOwner) this.assertOwner(db, options.workerOwner);
      const statement = db.prepare(`INSERT INTO merchants
        (id, canonical_name, aliases_json, regex_json, default_category, region, source,
        updated_at, city, license, attribution, logo_json, wikidata_id, requires_category_evidence, matchable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET canonical_name = excluded.canonical_name,
        aliases_json = excluded.aliases_json, regex_json = excluded.regex_json,
        default_category = excluded.default_category, region = excluded.region,
        source = excluded.source, updated_at = excluded.updated_at,
        city = excluded.city, license = excluded.license,
        attribution = excluded.attribution, logo_json = CASE
          WHEN ? OR excluded.logo_json IS NOT NULL THEN excluded.logo_json
          WHEN merchants.canonical_name = excluded.canonical_name
            AND merchants.region = excluded.region
            AND merchants.wikidata_id IS excluded.wikidata_id THEN merchants.logo_json
          ELSE NULL END,
        wikidata_id = excluded.wikidata_id, requires_category_evidence = excluded.requires_category_evidence,
        matchable = excluded.matchable
        WHERE excluded.updated_at > merchants.updated_at`);
      for (const merchant of validated) {
        const previous = db
          .prepare(`SELECT ${merchantColumns} FROM merchants WHERE id = ?`)
          .get(merchant.id);
        if (previous && Number(previous.updatedAt) < merchant.updatedAt)
          retainLogoAttribution(db, merchantFromRow(previous));
        statement.run(
          merchant.id,
          merchant.canonicalName,
          JSON.stringify(merchant.aliases),
          JSON.stringify(merchant.regexPatterns),
          merchant.defaultCategory,
          merchant.region,
          merchant.source,
          merchant.updatedAt,
          merchant.city,
          merchant.license,
          merchant.attribution,
          merchant.logo ? JSON.stringify(merchant.logo) : null,
          merchant.wikidataId,
          merchant.requiresCategoryEvidence ? 1 : 0,
          merchant.matchable ? 1 : 0,
          options.replaceLogos ? 1 : 0,
        );
      }
      options.checkpoint?.(db);
    });
  }

  loadMerchants(): Merchant[] {
    return this.accounts.read(readMerchantDefinitions);
  }

  getMerchant(id: string): Merchant | null {
    return this.accounts.read((db) => {
      const row = db
        .prepare(`SELECT ${merchantColumns} FROM merchants WHERE id = ?`)
        .get(id);
      return row ? merchantFromRow(row) : null;
    });
  }

  updateMerchantLogo(
    reference: Merchant,
    logo: PrivateMerchantLogo | null,
  ): boolean {
    const expected = merchantSchema.parse(reference);
    const validated =
      logo === null ? null : privateMerchantLogoSchema.parse(logo);
    const updatedAt = z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(Math.max(Date.now(), expected.updatedAt + 1));
    return this.accounts.transaction((db) => {
      const current = db
        .prepare(`SELECT ${merchantColumns} FROM merchants WHERE id = ?`)
        .get(expected.id);
      if (!current || current.updatedAt !== expected.updatedAt) return false;
      retainLogoAttribution(db, merchantFromRow(current));
      return (
        db
          .prepare(
            `UPDATE merchants SET logo_json = ?,
      updated_at = ?, wikidata_id = ? WHERE id = ? AND updated_at = ?`,
          )
          .run(
            validated ? JSON.stringify(validated) : null,
            updatedAt,
            expected.wikidataId,
            expected.id,
            expected.updatedAt,
          ).changes === 1
      );
    });
  }

  logoAttribution(
    id: string,
    version: string,
  ): { canonicalName: string; logo: PrivateMerchantLogo } | null {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(version);
    return this.accounts.read((db) => {
      const current = db
        .prepare(`SELECT ${merchantColumns} FROM merchants WHERE id = ?`)
        .get(id);
      if (current) {
        const merchant = merchantFromRow(current);
        if (merchant.logo && merchantLogoVersion(merchant.logo) === version)
          return { canonicalName: merchant.canonicalName, logo: merchant.logo };
      }
      const archived = db
        .prepare(
          `SELECT canonical_name,logo_json FROM merchant_logo_attributions
        WHERE merchant_id = ? AND version = ?`,
        )
        .get(id, version);
      return archived
        ? {
            canonicalName: String(archived.canonical_name),
            logo: privateMerchantLogoSchema.parse(
              JSON.parse(String(archived.logo_json)),
            ),
          }
        : null;
    });
  }

  logoCandidates(ids: string[]): Map<string, Merchant[]> {
    const { merchantIds } = merchantMarksRequestSchema.parse({
      merchantIds: ids,
    });
    return this.accounts.read((db) => {
      const unique = [...new Set(merchantIds)];
      if (!unique.length) return new Map();
      const requested = db
        .prepare(
          `SELECT ${merchantColumns} FROM merchants
        WHERE id IN (${unique.map(() => "?").join(",")})`,
        )
        .all(...unique)
        .map(merchantFromRow);
      const byId = new Map(
        requested.map((merchant) => [merchant.id, merchant]),
      );
      const entities = [
        ...new Set(
          requested.flatMap((merchant) =>
            merchant.wikidataId ? [merchant.wikidataId] : [],
          ),
        ),
      ];
      const related = entities.length
        ? db
            .prepare(
              `SELECT ${merchantColumns} FROM merchants
        WHERE (wikidata_id IN (${entities.map(() => "?").join(",")}) OR
          (wikidata_id IS NULL AND source = 'osm' AND (${entities.map(() => "id LIKE ?").join(" OR ")})))
        AND logo_json IS NOT NULL ORDER BY updated_at DESC, id LIMIT 1001`,
            )
            .all(
              ...entities,
              ...entities.map((entity) => `osm-brand-${entity}-%`),
            )
            .map(merchantFromRow)
        : [];
      if (related.length > 1000)
        throw new RangeError("Merchant logo reference limit exceeded.");
      return new Map(
        unique.map((id) => {
          const merchant = byId.get(id);
          const matches = merchant
            ? [
                ...(merchant.logo ? [merchant] : []),
                ...related.filter(
                  (candidate) =>
                    candidate.id !== id &&
                    merchant.wikidataId &&
                    candidate.wikidataId === merchant.wikidataId &&
                    candidate.region === merchant.region &&
                    normalizeMerchantText(candidate.canonicalName) ===
                      normalizeMerchantText(merchant.canonicalName),
                ),
              ]
            : [];
          return [id, matches];
        }),
      );
    });
  }
}
