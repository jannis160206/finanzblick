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
  if (
    !db.prepare("SELECT 1 FROM automation_migrations WHERE version = 7").get()
  ) {
    db.exec(`
      DROP INDEX automation_backfill_once;
      CREATE UNIQUE INDEX automation_backfill_once ON automation_jobs(user_id)
        WHERE kind = 'backfill' AND status NOT IN ('COMPLETED', 'FAILED');
      INSERT INTO automation_migrations VALUES (7, unixepoch() * 1000);
    `);
  }
  if (
    !db.prepare("SELECT 1 FROM automation_migrations WHERE version = 8").get()
  ) {
    db.exec(`
      CREATE TABLE merchant_authorized_logos (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        merchant_id TEXT NOT NULL,
        version TEXT NOT NULL CHECK(length(version) = 64),
        canonical_name TEXT NOT NULL,
        logo_json TEXT NOT NULL CHECK(json_valid(logo_json) AND length(logo_json) <= 16384),
        is_current INTEGER NOT NULL CHECK(is_current IN (0, 1)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, merchant_id, version)
      );
      CREATE UNIQUE INDEX merchant_authorized_logo_current
        ON merchant_authorized_logos(user_id, merchant_id) WHERE is_current = 1;
      CREATE TABLE merchant_authorized_logo_imports (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE merchant_authorized_logo_assets (
        account_key TEXT NOT NULL CHECK(length(account_key) = 64),
        file TEXT NOT NULL CHECK(length(file) = 68),
        PRIMARY KEY(account_key, file)
      );
      INSERT INTO automation_migrations VALUES (8, unixepoch() * 1000);
    `);
  }
  if (
    !db.prepare("SELECT 1 FROM automation_migrations WHERE version = 9").get()
  ) {
    db.exec(`
      CREATE TABLE merchant_authorized_logo_names (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 100),
        merchant_id TEXT NOT NULL,
        PRIMARY KEY(user_id, name)
      );
      INSERT INTO automation_migrations VALUES (9, unixepoch() * 1000);
    `);
  }
  if (!db.prepare("SELECT 1 FROM automation_migrations WHERE version = 10").get()) {
    db.exec(`
      ALTER TABLE automation_jobs ADD COLUMN error_code TEXT;
      ALTER TABLE automation_jobs ADD COLUMN outcome_json TEXT
        CHECK(outcome_json IS NULL OR (json_valid(outcome_json) AND length(outcome_json) <= 262144));
      INSERT INTO automation_migrations VALUES (10, unixepoch() * 1000);
    `);
  }
  if (!db.prepare("SELECT 1 FROM automation_migrations WHERE version = 11").get()) {
    db.exec(`
      CREATE INDEX automation_statement_retention ON automation_jobs(updated_at)
        WHERE kind = 'statement' AND status IN ('COMPLETED', 'FAILED') AND bytes = 0;
      INSERT INTO automation_migrations VALUES (11, unixepoch() * 1000);
    `);
  }
  if (!db.prepare("SELECT 1 FROM automation_migrations WHERE version = 12").get()) {
    // Independently deployed migrations 10/11 may not contain job metadata.
    const columns = db.prepare("PRAGMA table_info(automation_jobs)").all();
    if (!columns.some((column) => column.name === "error_code"))
      db.exec("ALTER TABLE automation_jobs ADD COLUMN error_code TEXT");
    if (!columns.some((column) => column.name === "outcome_json"))
      db.exec(`ALTER TABLE automation_jobs ADD COLUMN outcome_json TEXT
        CHECK(outcome_json IS NULL OR (json_valid(outcome_json) AND length(outcome_json) <= 262144))`);
    db.exec(`
      CREATE INDEX IF NOT EXISTS automation_statement_retention ON automation_jobs(updated_at)
        WHERE kind = 'statement' AND status IN ('COMPLETED', 'FAILED') AND bytes = 0;
      INSERT INTO automation_migrations VALUES (12, unixepoch() * 1000);
    `);
  }
  if (!db.prepare("SELECT 1 FROM automation_migrations WHERE version = 13").get()) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS merchant_catalogue_sources (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('current', 'refreshing', 'unavailable')),
        checked_at INTEGER NOT NULL,
        next_refresh_at INTEGER NOT NULL,
        imported INTEGER NOT NULL DEFAULT 0 CHECK(imported >= 0)
      );
      INSERT INTO automation_migrations VALUES (13, unixepoch() * 1000);
    `);
  }
  if (!db.prepare("SELECT 1 FROM automation_migrations WHERE version = 14").get()) {
    const columns = db.prepare("PRAGMA table_info(merchants)").all();
    if (!columns.some((column) => column.name === "matchable"))
      db.exec("ALTER TABLE merchants ADD COLUMN matchable INTEGER NOT NULL DEFAULT 1 CHECK(matchable IN (0, 1))");
    db.exec(`
      UPDATE merchant_catalogue_sources SET next_refresh_at = 0;
      INSERT INTO automation_migrations VALUES (14, unixepoch() * 1000);
    `);
  }
  if (!db.prepare("SELECT 1 FROM automation_migrations WHERE version = 15").get()) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS merchant_catalogue_snapshots (
        source_id TEXT PRIMARY KEY REFERENCES merchant_catalogue_sources(id),
        definitions_json TEXT NOT NULL CHECK(json_valid(definitions_json) AND length(definitions_json) <= 4194304)
      );
      UPDATE merchant_catalogue_sources SET next_refresh_at = 0;
      INSERT INTO automation_migrations VALUES (15, unixepoch() * 1000);
    `);
  }
  if (!db.prepare("SELECT 1 FROM automation_migrations WHERE version = 16").get()) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS merchant_catalogue_external (
        merchant_id TEXT PRIMARY KEY,
        category TEXT,
        requires_evidence INTEGER NOT NULL CHECK(requires_evidence IN (0, 1)),
        matchable INTEGER NOT NULL CHECK(matchable IN (0, 1))
      );
      INSERT OR IGNORE INTO merchant_catalogue_external
        SELECT id, default_category, requires_category_evidence, matchable
        FROM merchants WHERE source = 'osm';
      INSERT INTO automation_migrations VALUES (16, unixepoch() * 1000);
    `);
  }
  if (!db.prepare("SELECT 1 FROM automation_migrations WHERE version = 17").get()) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS merchant_catalogue_managed (merchant_id TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO merchant_catalogue_managed
        SELECT json_extract(value, '$.id') FROM merchant_catalogue_snapshots, json_each(definitions_json);
      INSERT INTO automation_migrations VALUES (17, unixepoch() * 1000);
    `);
  }
}
