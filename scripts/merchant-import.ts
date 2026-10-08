import { parseArgs } from "node:util";
import { readAccountConfig } from "../src/lib/server/config";
import { AccountDatabase } from "../src/lib/server/database";
import { AutomationStore } from "../src/lib/automation/store";
import { MAX_MERCHANT_ALIASES, normalizeMerchantText, seedMerchants } from "../src/lib/automation/merchants";
import {
  importOsmMerchants,
  MAX_IMPORTED_MERCHANTS,
  parseMerchantBbox,
} from "../src/lib/automation/merchant-import";

const { values } = parseArgs({
  options: {
    bbox: { type: "string" },
    logos: { type: "boolean", default: false },
  },
});
if (!values.bbox)
  throw new Error(
    "Required: --bbox south,west,north,east (Austria, bounded tile)",
  );
const bbox = parseMerchantBbox(values.bbox);
const config = readAccountConfig();
const accounts = new AccountDatabase(config.databasePath);
try {
  const store = new AutomationStore(accounts);
  store.upsertMerchants(seedMerchants);
  const existing = store.loadMerchants();
  if (existing.length > MAX_IMPORTED_MERCHANTS)
    throw new Error("Merchant index limit reached; no network import started");
  const result = await importOsmMerchants({
    bbox,
    databasePath: accounts.path,
    logos: values.logos,
  });
  const ids = new Set(existing.map((merchant) => merchant.id));
  for (const merchant of result.merchants) ids.add(merchant.id);
  if (ids.size > MAX_IMPORTED_MERCHANTS)
    throw new Error(
      "Import would exceed the 10,000 merchant index limit; use a smaller tile",
    );
  // Keep explicitly licensed cached logos when geography alone is refreshed.
  const previous = new Map(existing.map((merchant) => [merchant.id, merchant]));
  if (!values.logos)
    for (const merchant of result.merchants) {
      merchant.logo ??= previous.get(merchant.id)?.logo ?? null;
    }
  for (const merchant of result.merchants) {
    const old = previous.get(merchant.id);
    if (!old) continue;
    if (old.defaultCategory !== merchant.defaultCategory) merchant.defaultCategory = null;
    if (old.city !== merchant.city) merchant.city = null;
    merchant.aliases = [...new Set([...old.aliases, ...merchant.aliases])].slice(0, 32);
  }
  const reference = new Map(existing.map(merchant => [merchant.id, merchant]));
  for (const merchant of result.merchants) reference.set(merchant.id, merchant);
  if (new Set([...reference.values()].flatMap(merchant => [merchant.canonicalName, ...merchant.aliases])
    .map(normalizeMerchantText)).size > MAX_MERCHANT_ALIASES)
    throw new Error("Import would exceed the 40,000 alias index limit");
  store.upsertMerchants(result.merchants);
  console.info(JSON.stringify(result.report, null, 2));
} finally {
  accounts.close();
}
