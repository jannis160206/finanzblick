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
      BEGIN IMMEDIATE;
    `);
    migrateAutomation(db);
    db.exec("COMMIT");
    expect(
      db
        .prepare(
          "SELECT canonical_name, default_category, aliases_json, license, logo_json FROM merchants",
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
    ).toBe(2);
    expect(
      db.prepare("SELECT count(*) AS count FROM automation_migrations").get()
        ?.count,
    ).toBe(2);
  } finally {
    db.close();
  }
});
