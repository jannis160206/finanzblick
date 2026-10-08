import { parseArgs } from "node:util";
import { readAccountConfig } from "../src/lib/server/config";
import { AccountDatabase } from "../src/lib/server/database";
import { AutomationStore } from "../src/lib/automation/store";
import { MERCHANT_BACKFILL_VERSION } from "../src/lib/automation/schema";

const { values } = parseArgs({
  options: {
    rerun: { type: "boolean", default: false },
    "merchant-upgrade": { type: "boolean", default: false },
  },
});
const config = readAccountConfig();
const accounts = new AccountDatabase(config.databasePath);
try {
  const count = new AutomationStore(accounts).enqueueAllBackfills({
    rerun: values.rerun,
    onceVersion: values["merchant-upgrade"]
      ? MERCHANT_BACKFILL_VERSION
      : undefined,
  });
  console.info(
    `Backfill requested for ${count} account(s); ${
      values["merchant-upgrade"]
        ? "merchant upgrade is queued once per account; existing pass is never reset."
        : values.rerun
          ? "terminal jobs are restarted; active jobs are resumed."
          : "existing jobs are reused."
    }`,
  );
} finally {
  accounts.close();
}
