import { parseArgs } from "node:util";
import { readAccountConfig } from "../src/lib/server/config";
import { AccountDatabase } from "../src/lib/server/database";
import { AutomationStore } from "../src/lib/automation/store";
import { MERCHANT_BACKFILL_VERSION } from "../src/lib/automation/schema";

const { values } = parseArgs({
  options: {
    rerun: { type: "boolean", default: false },
    "merchant-upgrade": { type: "boolean", default: false },
    "once-version": { type: "string" },
  },
});
if (values["once-version"] && values["merchant-upgrade"])
  throw new Error("Use either --once-version or --merchant-upgrade.");
if (
  values["once-version"] !== undefined &&
  !/^[a-z0-9-]{1,80}$/.test(values["once-version"])
)
  throw new Error(
    "--once-version must be a nonempty lowercase version identifier (max 80 characters).",
  );
if (values.rerun && (values["once-version"] || values["merchant-upgrade"]))
  throw new Error("A once-only pass cannot be combined with --rerun.");
const config = readAccountConfig();
const accounts = new AccountDatabase(config.databasePath);
try {
  const count = new AutomationStore(accounts).enqueueAllBackfills({
    rerun: values.rerun,
    onceVersion: values["merchant-upgrade"]
      ? MERCHANT_BACKFILL_VERSION
      : values["once-version"],
  });
  console.info(
    `Backfill requested for ${count} account(s); ${
      values["merchant-upgrade"] || values["once-version"]
        ? "versioned backfill is queued once per account; existing pass is never reset."
        : values.rerun
          ? "terminal jobs are restarted; active jobs are resumed."
          : "existing jobs are reused."
    }`,
  );
} finally {
  accounts.close();
}
