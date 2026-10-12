import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

it("keeps every active account job in the bounded snapshot ahead of newer terminal jobs", async () => {
  const directory = createTestDirectory();
  const accounts = new AccountDatabase(join(directory, "status.sqlite"));
  try {
    const store = new AutomationStore(accounts);
    const alice = (await accounts.register("alice", "test-only-password-123")).user.id;
    const bob = (await accounts.register("bob", "test-only-password-123")).user.id;
    const active = randomUUID();
    const otherAccount = randomUUID();
    store.reserveUpload(alice, active, "old-active.pdf", 1, 1);
    store.reserveUpload(bob, otherAccount, "private-bob.pdf", 1, 1);
    const recent: string[] = [];
    for (let index = 0; index < 25; index++) {
      const id = randomUUID();
      recent.push(id);
      store.reserveUpload(alice, id, `recent-${index}.pdf`, 1, index + 2);
      store.failUpload(alice, id);
    }
    const jobs = store.snapshot(alice).jobs;
    expect(jobs).toHaveLength(20);
    expect(jobs[0]).toMatchObject({ id: active, status: "UPLOADING" });
    expect(jobs.slice(1).map((job) => job.id)).toEqual(recent.slice(-19).reverse());
    expect(jobs.some((job) => job.id === otherAccount)).toBe(false);
    expect(store.snapshot(bob).jobs.map((job) => job.id)).toEqual([otherAccount]);
  } finally {
    accounts.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
