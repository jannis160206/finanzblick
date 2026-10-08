import { randomUUID } from "node:crypto";
import { readAccountConfig } from "../src/lib/server/config";
import { AccountDatabase } from "../src/lib/server/database";
import { AutomationStore } from "../src/lib/automation/store";
import { MerchantIndex, seedMerchants } from "../src/lib/automation/merchants";
import { AutomationWorker } from "../src/lib/automation/worker";

const config = readAccountConfig();
const accounts = new AccountDatabase(config.databasePath);
accounts.configureLimits({
  maxAccounts: config.maxAccounts,
  maxStorageBytes: config.maxStorageBytes,
});
const store = new AutomationStore(accounts);
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
try {
  store.upsertMerchants(seedMerchants);
  const index = new MerchantIndex(store.loadMerchants());
  console.info("Statement worker ready (concurrency=1, local processing).");
  await new AutomationWorker(store, randomUUID(), index).run(stop.signal);
} finally {
  accounts.close();
}
