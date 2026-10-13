import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { migrateAutomation } from "./migration";

it("migrates legacy merchants atomically, preserves their data and permits unknown categories", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE automation_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO automation_migrations VALUES (1, 0);
      CREATE TABLE merchants (
        id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, aliases_json TEXT NOT NULL,
        regex_json TEXT NOT NULL, default_category TEXT NOT NULL, region TEXT NOT NULL,
        source TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO merchants VALUES ('at-billa', 'BILLA', '["Billa Plus"]', '[]', 'Lebensmittel', 'AT', 'local', 1);
      INSERT INTO merchants VALUES ('fuel', 'Test Tankstelle', '[]', '[]', 'Tanken', 'AT', 'osm', 1);
      BEGIN IMMEDIATE;
    `);
    migrateAutomation(db);
    db.exec("COMMIT");
    expect(
      db
        .prepare(
          "SELECT canonical_name, default_category, aliases_json, license, logo_json FROM merchants WHERE id = 'at-billa'",
        )
        .get(),
    ).toEqual({
      canonical_name: "BILLA",
      default_category: "Lebensmittel",
      aliases_json: '["Billa Plus"]',
      license: null,
      logo_json: null,
    });
    db.prepare(
      "INSERT INTO merchants (id, canonical_name, aliases_json, regex_json, region, source, updated_at) VALUES (?, ?, '[]', '[]', 'AT', 'osm', 1)",
    ).run("unknown", "Nordlicht");
    expect(
      db
        .prepare("SELECT default_category FROM merchants WHERE id = 'unknown'")
        .get()?.default_category,
    ).toBeNull();
    db.exec("BEGIN IMMEDIATE");
    migrateAutomation(db);
    db.exec("COMMIT");
    expect(
      db.prepare("SELECT count(*) AS count FROM merchants").get()?.count,
    ).toBe(3);
    expect(
      db
        .prepare(
          "SELECT requires_category_evidence FROM merchants WHERE id = 'fuel'",
        )
        .get()?.requires_category_evidence,
    ).toBe(1);
    expect(
      db
        .prepare("SELECT wikidata_id FROM merchants WHERE id = 'at-billa'")
        .get()?.wikidata_id,
    ).toBeNull();
    expect(() =>
      db.exec("UPDATE merchants SET requires_category_evidence = 2"),
    ).toThrow();
    expect(
      db.prepare("SELECT count(*) AS count FROM automation_migrations").get()
        ?.count,
    ).toBe(12);
    expect(
      db.prepare("SELECT count(*) AS count FROM merchant_authorized_logo_names")
        .get()?.count,
    ).toBe(0);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'merchants_logo_entity'",
        )
        .get(),
    ).toMatchObject({ name: "merchants_logo_entity" });
  } finally {
    db.close();
  }
});

it("repairs independently deployed migration-10 job metadata without losing queued uploads", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    migrateAutomation(db);
    db.exec(`
      ALTER TABLE automation_jobs DROP COLUMN error_code;
      ALTER TABLE automation_jobs DROP COLUMN outcome_json;
      DELETE FROM automation_migrations WHERE version >= 11;
      DROP INDEX automation_statement_retention;
      INSERT INTO users VALUES ('alice');
      INSERT INTO automation_jobs (id, user_id, kind, name, status, bytes, available_at, updated_at, created_at)
      VALUES ('synthetic-job', 'alice', 'statement', 'test.csv', 'QUEUED', 2, 0, 0, 0);
      BEGIN IMMEDIATE;
    `);
    migrateAutomation(db);
    db.exec("COMMIT");
    expect(db.prepare("SELECT status, bytes, error_code, outcome_json FROM automation_jobs WHERE id = 'synthetic-job'").get())
      .toEqual({ status: "QUEUED", bytes: 2, error_code: null, outcome_json: null });
    expect(db.prepare("SELECT count(*) AS count FROM automation_migrations").get()?.count).toBe(12);
    migrateAutomation(db);
    expect(db.prepare("SELECT count(*) AS count FROM automation_jobs").get()?.count).toBe(1);
  } finally {
    db.close();
  }
});
