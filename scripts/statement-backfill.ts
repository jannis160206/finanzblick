import { readAccountConfig } from "../src/lib/server/config";
import { AccountDatabase } from "../src/lib/server/database";
import { AutomationStore } from "../src/lib/automation/store";

const config = readAccountConfig();
const accounts = new AccountDatabase(config.databasePath);
try {
  const count = new AutomationStore(accounts).enqueueAllBackfills();
  console.info(
    `Backfill queued for ${count} account(s); existing jobs are reused.`,
  );
} finally {
  accounts.close();
}
