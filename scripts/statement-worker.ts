import { randomUUID } from "node:crypto";
import { readAccountConfig } from "../src/lib/server/config";
import { AccountDatabase } from "../src/lib/server/database";
import { AutomationStore } from "../src/lib/automation/store";
import { MerchantIndex, seedMerchants } from "../src/lib/automation/merchants";
import { AutomationWorker } from "../src/lib/automation/worker";
import { PublicMerchantCatalogue } from "../src/lib/automation/catalogue-refresh";
import { assertParserRuntimeAvailable } from "../src/lib/automation/parser-runtime";
import { startBankAutoSync } from "../src/lib/banking/auto-sync";
import { startMailAutoSync } from "../src/lib/mail/sync";

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
  await assertParserRuntimeAvailable();
  store.upsertMerchants(seedMerchants);
  const index = new MerchantIndex(store.loadMerchants());
  const catalogue = new PublicMerchantCatalogue(store);
  startBankAutoSync(accounts, stop.signal);
  startMailAutoSync(accounts, stop.signal);
  console.info("Statement worker ready (concurrency=1, isolated local parser, budget=120s).");
  await new AutomationWorker(store, randomUUID(), index, {}, (signal, owner) => catalogue.maintain(signal, owner)).run(stop.signal);
} finally {
  accounts.close();
}
