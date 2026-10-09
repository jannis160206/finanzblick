import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AccountDatabase } from "../src/lib/server/database";
import { AutomationStore } from "../src/lib/automation/store";
import {
  importAuthorizedCommonsLogos,
  importAuthorizedLocalLogos,
  authorizedLogoChoicesSchema,
} from "../src/lib/automation/merchant-logo-authorized-import";
import { logoRightsReferenceSchema } from "../src/lib/automation/merchant-logo-grant-metadata";
import {
  assertNoSymlinkPath,
  readBoundedLogoFile,
} from "../src/lib/automation/merchant-logo-raster";

async function main() {
  const { values } = parseArgs({
    options: {
      database: { type: "string" },
      account: { type: "string" },
      "rights-reference": { type: "string" },
      commons: { type: "boolean", default: false },
      manifest: { type: "string" },
      "logo-choices": { type: "string" },
      "batch-size": { type: "string", default: "20" },
      after: { type: "string" },
      refresh: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.info(
      "Private account-scoped logo import (no .env loading).\n" +
        "Required: --database <existing.sqlite> --account <existing username> " +
        "--rights-reference <operator/user declaration or actual document reference>\n" +
        "Choose --commons [--batch-size 1..20] [--after QID] [--refresh] [--logo-choices <JSON>], " +
        "or --manifest <bounded local JSON manifest>.\n" +
        "No merchant, alias, finance, session or shared-logo changes; at most 200 public entities/run.",
    );
    return;
  }
  if (!values.database || !values.account || !values["rights-reference"])
    throw new Error(
      "Explicit --database, --account and --rights-reference are required",
    );
  if (values.commons === Boolean(values.manifest))
    throw new Error("Choose exactly one of --commons or --manifest");
  if (
    !values.commons &&
    (values.after ||
      values.refresh ||
      values["logo-choices"] ||
      values["batch-size"] !== "20")
  )
    throw new Error(
      "--after, --refresh, --logo-choices and --batch-size require --commons",
    );
  const rightsReference = logoRightsReferenceSchema.parse(
    values["rights-reference"],
  );
  const username = z.string().trim().min(1).max(100).parse(values.account);
  const batchSize = z
    .number()
    .int()
    .min(1)
    .max(20)
    .parse(Number(values["batch-size"]));
  const databasePath = resolve(values.database);
  const logoChoices = values["logo-choices"]
    ? authorizedLogoChoicesSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readBoundedLogoFile(
              resolve(values["logo-choices"]),
              128 * 1024,
            ),
          ),
        ),
      )
    : undefined;
  await assertNoSymlinkPath(databasePath);
  if (!(await lstat(databasePath)).isFile())
    throw new Error(
      "--database must identify an existing regular account database",
    );
  const accounts = new AccountDatabase(databasePath);
  try {
    const row = accounts.read((db) =>
      db.prepare("SELECT id FROM users WHERE username = ?").get(username),
    );
    if (!row || typeof row.id !== "string")
      throw new Error("Selected account does not exist");
    const store = new AutomationStore(accounts);
    const signal = AbortSignal.timeout(600_000);
    const report = values.commons
      ? await importAuthorizedCommonsLogos(store, {
          userId: row.id,
          rightsReference,
          batchSize,
          after: values.after,
          refresh: values.refresh,
          logoChoices,
          signal,
          onBatch: (progress) =>
            console.info(
              JSON.stringify({ phase: "authorized-logos", ...progress }),
            ),
        })
      : await importAuthorizedLocalLogos(store, {
          userId: row.id,
          rightsReference,
          manifestPath: values.manifest!,
          signal,
        });
    console.info(JSON.stringify(report, null, 2));
  } finally {
    accounts.close();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Authorized logo import failed",
  );
  process.exitCode = 1;
});
