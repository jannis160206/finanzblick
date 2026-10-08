import { parseArgs } from "node:util";
import { readAccountConfig } from "../src/lib/server/config";
import { AccountDatabase } from "../src/lib/server/database";
import { AutomationStore } from "../src/lib/automation/store";

const { values } = parseArgs({
  options: { rerun: { type: "boolean", default: false } },
});
const config = readAccountConfig();
const accounts = new AccountDatabase(config.databasePath);
try {
  const count = new AutomationStore(accounts).enqueueAllBackfills({
    rerun: values.rerun,
  });
  console.info(
    `Backfill requested for ${count} account(s); ${
      values.rerun
        ? "terminal jobs are restarted; active jobs are resumed."
        : "existing jobs are reused."
    }`,
  );
} finally {
  accounts.close();
}
