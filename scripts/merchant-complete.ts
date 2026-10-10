import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AccountDatabase } from "../src/lib/server/database";
import { AutomationStore } from "../src/lib/automation/store";
import {
  completeMerchantCatalogue,
  merchantCatalogueReferences,
} from "../src/lib/automation/merchant-catalogue-completion";
import {
  authorizedLogoChoicesSchema,
  importReviewedCommonsLogos,
  importReviewedWikimediaLogos,
  reviewedCommonsManifestSchema,
  reviewedWikimediaManifestSchema,
} from "../src/lib/automation/merchant-logo-authorized-import";
import { logoRightsReferenceSchema } from "../src/lib/automation/merchant-logo-grant-metadata";
import {
  assertNoSymlinkPath,
  readBoundedLogoFile,
} from "../src/lib/automation/merchant-logo-raster";

async function readManifest(path: string) {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await readBoundedLogoFile(resolve(path), 128 * 1024),
    ),
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      database: { type: "string" },
      account: { type: "string" },
      "rights-reference": { type: "string" },
      "logo-choices": {
        type: "string",
      },
      "commons-manifest": {
        type: "string",
        default: join("scripts", "data", "merchant-logo-reviewed-files.json"),
      },
      "wikimedia-manifest": {
        type: "string",
        default: join(
          "scripts",
          "data",
          "merchant-logo-reviewed-wikimedia.json",
        ),
      },
      after: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.info(
      "Complete known merchant references and private logos (no .env loading).\n" +
        "Required: --database <existing.sqlite> --account <existing username> " +
        "--rights-reference <operator/user rights declaration>\n" +
        "Seeds the existing table, drains sequential 200-entity Commons scans and imports reviewed Wikimedia artwork.\n" +
        "Optional: --after QID and explicit --logo-choices / --commons-manifest / --wikimedia-manifest paths.\n" +
        "Seeds reviewed reference categories. One 10-minute deadline; no finance, manual locks or backfill changes.",
    );
    return;
  }
  if (!values.database || !values.account || !values["rights-reference"])
    throw new Error(
      "Explicit --database, --account and --rights-reference are required",
    );
  const username = z.string().trim().min(1).max(100).parse(values.account);
  const rightsReference = logoRightsReferenceSchema.parse(
    values["rights-reference"],
  );
  const logoChoices = authorizedLogoChoicesSchema.parse(
    await readManifest(
      values["logo-choices"] ??
        join("scripts", "data", "merchant-logo-choices.json"),
    ),
  );
  const commonsManifest = reviewedCommonsManifestSchema.parse(
    await readManifest(values["commons-manifest"]),
  );
  const wikimediaManifest = reviewedWikimediaManifestSchema.parse(
    await readManifest(values["wikimedia-manifest"]),
  );
  const path = resolve(values.database);
  await assertNoSymlinkPath(path);
  if (!(await lstat(path)).isFile())
    throw new Error(
      "--database must identify an existing regular account database",
    );
  const accounts = new AccountDatabase(path);
  try {
    const user = accounts.read((db) =>
      db.prepare("SELECT id FROM users WHERE username = ?").get(username),
    );
    if (!user || typeof user.id !== "string")
      throw new Error("Selected account does not exist");
    const store = new AutomationStore(accounts);
    const references = merchantCatalogueReferences(store);
    const knownEntities = new Set(
      [...references.values()].map((merchant) => merchant.wikidataId),
    );
    const missingChoices = logoChoices.filter(
      (choice) => !knownEntities.has(choice.wikidataId),
    );
    if (values["logo-choices"] && missingChoices.length)
      throw new Error(
        "Explicit logo choices require existing public merchant identities",
      );
    if (missingChoices.length)
      console.info(
        JSON.stringify({
          phase: "catalogue",
          unavailableDefaultChoices: missingChoices.map(
            (choice) => choice.wikidataId,
          ),
        }),
      );
    const reviewed = new Set<string>();
    for (const entry of [
      ...commonsManifest.entries,
      ...wikimediaManifest.entries,
    ]) {
      if (
        reviewed.has(entry.merchantId) ||
        references.get(entry.merchantId)?.wikidataId !== entry.wikidataId
      )
        throw new Error(
          "Reviewed manifests require unique known merchant identities with their exact current QID",
        );
      reviewed.add(entry.merchantId);
    }
    const signal = AbortSignal.timeout(600_000);
    const options = { userId: user.id, rightsReference, signal };
    const scan = await completeMerchantCatalogue(store, {
      ...options,
      logoChoices: logoChoices.filter((choice) =>
        knownEntities.has(choice.wikidataId),
      ),
      after: values.after,
      onBatch: (progress) =>
        console.info(JSON.stringify({ phase: "known-logos", ...progress })),
    });
    const commons = await importReviewedCommonsLogos(store, {
      ...options,
      manifestPath: values["commons-manifest"],
    });
    const wikimedia = await importReviewedWikimediaLogos(store, {
      ...options,
      manifestPath: values["wikimedia-manifest"],
    });
    console.info(JSON.stringify({ scan, commons, wikimedia }, null, 2));
  } finally {
    accounts.close();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Merchant completion failed",
  );
  process.exitCode = 1;
});
