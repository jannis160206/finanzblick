import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { createTestDirectory } from "@/lib/server/test-support";
import { seedMerchants } from "./merchants";
import { AutomationStore, readMerchantDefinitions } from "./store";

it("round-trips identity/evidence metadata and recognizes only legacy importer-generated brand IDs", () => {
  const directory = createTestDirectory();
  const accounts = new AccountDatabase(join(directory, "metadata.sqlite"));
  try {
    const store = new AutomationStore(accounts);
    store.upsertMerchants(seedMerchants);
    store.upsertMerchants(seedMerchants);
    expect(store.loadMerchants()).toHaveLength(seedMerchants.length);
    expect(store.getMerchant("at-bipa")).toMatchObject({
      wikidataId: "Q864933",
    });
    expect(store.getMerchant("amazon")).toMatchObject({
      requiresCategoryEvidence: true,
    });
    accounts.transaction((db) => {
      const insert = db.prepare(`INSERT INTO merchants
        (id, canonical_name, aliases_json, regex_json, region, source, updated_at)
        VALUES (?, 'BIPA', '[]', '[]', 'AT', ?, 1)`);
      insert.run("osm-brand-Q864933-0123456789abcdef", "osm");
      insert.run("osm-brand-Q864933-not-an-importer-hash", "osm");
      insert.run("osm-brand-Q864933-ffffffffffffffff", "local");
    });
    expect(
      store.getMerchant("osm-brand-Q864933-0123456789abcdef")?.wikidataId,
    ).toBe("Q864933");
    expect(
      store.getMerchant("osm-brand-Q864933-not-an-importer-hash")?.wikidataId,
    ).toBeNull();
    expect(
      store.getMerchant("osm-brand-Q864933-ffffffffffffffff")?.wikidataId,
    ).toBeNull();
    expect(accounts.read(readMerchantDefinitions)).toEqual(
      store.loadMerchants(),
    );
  } finally {
    accounts.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
