import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AccountDatabase } from "../src/lib/server/database";
import { AutomationStore } from "../src/lib/automation/store";
import {
  importAuthorizedCommonsLogos,
  importAuthorizedLocalLogos,
  importReviewedCommonsLogos,
  importReviewedWikimediaLogos,
  authorizedLogoChoicesSchema,
} from "../src/lib/automation/merchant-logo-authorized-import";
import { logoRightsReferenceSchema } from "../src/lib/automation/merchant-logo-grant-metadata";
import {
  importSuppliedLocalLogos,
  localLogoAliasesSchema,
} from "../src/lib/automation/merchant-local-logos";
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
      directory: { type: "string" },
      "name-aliases": { type: "string" },
      "commons-manifest": { type: "string" },
      "wikimedia-manifest": { type: "string" },
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
        "or --manifest <bounded local JSON manifest>, --commons-manifest <reviewed Commons JSON>, " +
        "or --wikimedia-manifest <reviewed commons/de Wikimedia JSON>, " +
        "or --directory <private PNG/JPEG/WebP/AVIF folder> [--name-aliases <filename-to-names JSON>].\n" +
        "No merchant, alias, finance, session or shared-logo changes; at most 200 public entities/run.",
    );
    return;
  }
  if (!values.database || !values.account || !values["rights-reference"])
    throw new Error(
      "Explicit --database, --account and --rights-reference are required",
    );
  if (
    [
      values.commons,
      values.manifest,
      values.directory,
      values["commons-manifest"],
      values["wikimedia-manifest"],
    ].filter(Boolean).length !== 1
  )
    throw new Error(
      "Choose exactly one logo source: --commons, --manifest, --directory, --commons-manifest or --wikimedia-manifest",
    );
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
  if (values["name-aliases"] && !values.directory)
    throw new Error("--name-aliases requires --directory");
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
    const report = values.directory
      ? await importSuppliedLocalLogos(store, {
          userId: row.id,
          directory: values.directory,
          rightsReference,
          signal,
          aliases: values["name-aliases"]
            ? localLogoAliasesSchema.parse(
                JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    await readBoundedLogoFile(
                      resolve(values["name-aliases"]),
                      128 * 1024,
                    ),
                  ),
                ),
              )
            : undefined,
        })
      : values.commons
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
        : values["commons-manifest"]
          ? await importReviewedCommonsLogos(store, {
              userId: row.id,
              rightsReference,
              manifestPath: values["commons-manifest"],
              signal,
            })
          : values["wikimedia-manifest"]
            ? await importReviewedWikimediaLogos(store, {
                userId: row.id,
                rightsReference,
                manifestPath: values["wikimedia-manifest"],
                signal,
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
