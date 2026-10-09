import type { DatabaseSync } from "node:sqlite";

export function migrateAutomation(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_migrations (
      version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      aliases_json TEXT NOT NULL CHECK(json_valid(aliases_json)),
      regex_json TEXT NOT NULL CHECK(json_valid(regex_json)),
      default_category TEXT NOT NULL,
      region TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('statement', 'backfill')),
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN
        ('UPLOADING', 'QUEUED', 'PROCESSING', 'RETRYING', 'COMPLETED', 'FAILED')),
      progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
      attempts INTEGER NOT NULL DEFAULT 0,
      cursor INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      available_at INTEGER NOT NULL,
      owner TEXT,
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS automation_ready
      ON automation_jobs(status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS automation_tenant
      ON automation_jobs(user_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS automation_backfill_once
      ON automation_jobs(user_id) WHERE kind = 'backfill';
    CREATE TABLE IF NOT EXISTS automation_backfill_items (
      job_id TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      transaction_id TEXT NOT NULL,
      PRIMARY KEY(job_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS automation_worker (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO automation_migrations VALUES (1, unixepoch() * 1000);
  `);
  if (
    !db.prepare("SELECT 1 FROM automation_migrations WHERE version = 2").get()
  ) {
    db.exec(`
      ALTER TABLE merchants RENAME TO merchants_v1;
      CREATE TABLE merchants (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL CHECK(json_valid(aliases_json)),
        regex_json TEXT NOT NULL CHECK(json_valid(regex_json)),
        default_category TEXT,
        region TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        city TEXT,
        license TEXT,
        attribution TEXT,
        logo_json TEXT CHECK(logo_json IS NULL OR json_valid(logo_json))
      );
      INSERT INTO merchants
        (id, canonical_name, aliases_json, regex_json, default_category, region, source, updated_at)
        SELECT id, canonical_name, aliases_json, regex_json, default_category, region, source, updated_at
        FROM merchants_v1;
      DROP TABLE merchants_v1;
      CREATE TABLE automation_backfill_passes (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        completed_at INTEGER,
        PRIMARY KEY(user_id, version)
      );
      INSERT INTO automation_migrations VALUES (2, unixepoch() * 1000);
    `);
  }
  if (
    !db.prepare("SELECT 1 FROM automation_migrations WHERE version = 3").get()
  ) {
    db.exec(`
      ALTER TABLE merchants ADD COLUMN wikidata_id TEXT;
      INSERT INTO automation_migrations VALUES (3, unixepoch() * 1000);
    `);
  }
  if (
    !db.prepare("SELECT 1 FROM automation_migrations WHERE version = 4").get()
  ) {
    db.exec(`
      ALTER TABLE merchants ADD COLUMN requires_category_evidence INTEGER NOT NULL DEFAULT 0
        CHECK(requires_category_evidence IN (0, 1));
      UPDATE merchants SET requires_category_evidence = 1 WHERE default_category = 'Tanken';
      INSERT INTO automation_migrations VALUES (4, unixepoch() * 1000);
    `);
  }
  if (
    !db.prepare("SELECT 1 FROM automation_migrations WHERE version = 5").get()
  ) {
    db.exec(`
      CREATE INDEX merchants_logo_entity ON merchants(wikidata_id) WHERE logo_json IS NOT NULL;
      INSERT INTO automation_migrations VALUES (5, unixepoch() * 1000);
    `);
  }
  if (
    !db.prepare("SELECT 1 FROM automation_migrations WHERE version = 6").get()
  ) {
    db.exec(`
      CREATE TABLE merchant_logo_attributions (
        merchant_id TEXT NOT NULL,
        version TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        logo_json TEXT NOT NULL CHECK(json_valid(logo_json)),
        PRIMARY KEY(merchant_id, version)
      );
      INSERT INTO automation_migrations VALUES (6, unixepoch() * 1000);
    `);
  }
}
