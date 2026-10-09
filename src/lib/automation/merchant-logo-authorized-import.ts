import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import { MAX_IMPORTED_MERCHANTS } from "./merchant-import";
import {
  readPrivateMerchantLogo,
  retrieveAuthorizedCommonsRaster,
  commonsLogoFilenameSchema,
} from "./merchant-logo";
import {
  authorizedMerchantLogoSchema,
  logoMerchantIdSchema,
  logoRightsReferenceSchema,
  authorizedLogoVersion,
  type AuthorizedMerchantLogo,
} from "./merchant-logo-grant-metadata";
import {
  acquireAuthorizedLogoImport,
  authorizedLogoDirectory,
  checkAuthorizedLogoQuota,
  MAX_ACCOUNT_LOGO_FILES,
  readAuthorizedMerchantLogo,
  reserveAuthorizedLogoAsset,
  requireLogoAccount,
} from "./merchant-logo-grants";
import {
  assertNoSymlinkPath,
  logoContentFile,
  MAX_LOGO_INPUT,
  normalizeLogoRaster,
  readBoundedLogoFile,
  writeStoredLogoPng,
} from "./merchant-logo-raster";
import { AutomationStore } from "./store";

export const MAX_AUTHORIZED_LOGO_ENTITIES = 200;
export const authorizedLogoChoicesSchema = z
  .array(
    z
      .object({
        wikidataId: z.string().regex(/^Q[1-9]\d{0,11}$/),
        filename: commonsLogoFilenameSchema,
      })
      .strict(),
  )
  .max(MAX_AUTHORIZED_LOGO_ENTITIES);
const manifestSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            merchantId: logoMerchantIdSchema,
            file: z.string().min(1).max(240),
            attribution: logoRightsReferenceSchema,
            rightsReference: logoRightsReferenceSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_AUTHORIZED_LOGO_ENTITIES),
  })
  .strict();

function deadline(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(600_000)])
    : AbortSignal.timeout(600_000);
}

async function persistRasterGrant(
  store: AutomationStore,
  userId: string,
  merchantId: string,
  png: Buffer,
  metadata: Omit<AuthorizedMerchantLogo, "file">,
) {
  // Prevent quota failures from leaving additional unreferenced files.
  const complete = authorizedMerchantLogoSchema.parse({
    ...metadata,
    file: logoContentFile(png),
  });
  const merchant = store.getMerchant(merchantId);
  if (!merchant) throw new Error("Unknown public merchant ID");
  const version = authorizedLogoVersion(
    userId,
    {
      merchantId,
      canonicalName: merchant.canonicalName,
    },
    complete,
  );
  if (!store.authorizedLogo(userId, merchantId, version))
    store.accounts.read((db) => checkAuthorizedLogoQuota(db, userId));
  reserveAuthorizedLogoAsset(store.accounts, userId, complete.file);
  const file = await writeStoredLogoPng(
    authorizedLogoDirectory(store.accounts.path, userId),
    png,
    MAX_ACCOUNT_LOGO_FILES,
  );
  return store.saveAuthorizedLogo(
    userId,
    merchantId,
    authorizedMerchantLogoSchema.parse({ ...metadata, file }),
  );
}

export async function importAuthorizedLocalLogos(
  store: AutomationStore,
  options: {
    userId: string;
    rightsReference: string;
    manifestPath: string;
    signal?: AbortSignal;
  },
) {
  const userId = requireLogoAccount(store.accounts, options.userId);
  const rightsReference = logoRightsReferenceSchema.parse(
    options.rightsReference,
  );
  const signal = deadline(options.signal);
  signal.throwIfAborted();
  const manifestPath = resolve(options.manifestPath);
  const root = dirname(manifestPath);
  const bytes = await readBoundedLogoFile(manifestPath, 128 * 1024);
  const manifest = manifestSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  const ids = new Set<string>();
  const entries = [];
  for (const entry of manifest.entries) {
    signal.throwIfAborted();
    if (ids.has(entry.merchantId))
      throw new Error("Duplicate merchant ID in logo manifest");
    ids.add(entry.merchantId);
    if (!store.getMerchant(entry.merchantId))
      throw new Error(`Unknown public merchant ID: ${entry.merchantId}`);
    if (
      isAbsolute(entry.file) ||
      /[:\x00-\x1f]/.test(entry.file) ||
      entry.file
        .split(/[/\\]/)
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[. ]$/.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ) ||
      !/\.(?:png|jpe?g|webp)$/i.test(entry.file)
    )
      throw new Error(
        "Local logo must be a relative PNG/JPEG/WebP file inside the manifest directory",
      );
    const path = resolve(root, entry.file);
    const contained = relative(root, path);
    if (
      !contained ||
      contained === ".." ||
      contained.startsWith(`..${sep}`) ||
      isAbsolute(contained)
    )
      throw new Error("Local logo escapes manifest directory");
    await assertNoSymlinkPath(path);
    entries.push({ ...entry, path });
  }
  const release = acquireAuthorizedLogoImport(store.accounts, userId);
  try {
    const report = { imported: 0, cached: 0, merchantIds: [] as string[] };
    for (const entry of entries) {
      signal.throwIfAborted();
      const bytes = await readBoundedLogoFile(entry.path, MAX_LOGO_INPUT);
      const extension = entry.file.split(".").at(-1)?.toLowerCase();
      const mime =
        extension === "png"
          ? "image/png"
          : extension === "webp"
            ? "image/webp"
            : "image/jpeg";
      const png = await normalizeLogoRaster(bytes, { mime });
      if (!png)
        throw new Error(
          `Invalid or unsafe raster for public merchant ID: ${entry.merchantId}`,
        );
      signal.throwIfAborted();
      const previous = store.authorizedLogo(userId, entry.merchantId);
      const metadata = {
        permission: "operator-declared-private-usage-rights" as const,
        rightsReference: entry.rightsReference ?? rightsReference,
        attribution: `${entry.attribution}; resized to PNG`,
        provenance: {
          kind: "local-file" as const,
          sourceLabel: basename(entry.path),
        },
        publicRights: null,
      };
      const grant = await persistRasterGrant(
        store,
        userId,
        entry.merchantId,
        png,
        metadata,
      );
      if (previous?.version === grant.version) report.cached++;
      else report.imported++;
      report.merchantIds.push(entry.merchantId);
    }
    return report;
  } finally {
    release();
  }
}

export async function importAuthorizedCommonsLogos(
  store: AutomationStore,
  options: {
    userId: string;
    rightsReference: string;
    batchSize?: number;
    after?: string;
    refresh?: boolean;
    logoChoices?: z.infer<typeof authorizedLogoChoicesSchema>;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    onBatch?: (progress: {
      processed: number;
      cursor: string;
      remaining: number;
    }) => void;
  },
) {
  const userId = requireLogoAccount(store.accounts, options.userId);
  const rightsReference = logoRightsReferenceSchema.parse(
    options.rightsReference,
  );
  const size = z
    .number()
    .int()
    .min(1)
    .max(20)
    .parse(options.batchSize ?? 20);
  const after = z
    .string()
    .regex(/^Q[1-9]\d{0,11}$/)
    .optional()
    .parse(options.after);
  const signal = deadline(options.signal);
  signal.throwIfAborted();
  const merchants = store.loadMerchants();
  if (merchants.length > MAX_IMPORTED_MERCHANTS)
    throw new RangeError(
      "Public merchant index limit reached; no network import started",
    );
  const groups = new Map<string, typeof merchants>();
  for (const merchant of merchants) {
    if (!merchant.wikidataId) continue;
    const group = groups.get(merchant.wikidataId) ?? [];
    group.push(merchant);
    groups.set(merchant.wikidataId, group);
  }
  const choices = new Map<string, string>();
  for (const choice of authorizedLogoChoicesSchema.parse(
    options.logoChoices ?? [],
  )) {
    if (!groups.has(choice.wikidataId))
      throw new Error(
        "Logo selection requires an existing public merchant identity",
      );
    if (choices.has(choice.wikidataId))
      throw new Error("Duplicate Wikidata identity in logo selections");
    choices.set(choice.wikidataId, choice.filename);
  }
  const ids = [...groups.keys()].sort().filter((id) => !after || id > after);
  const selected = ids.slice(0, MAX_AUTHORIZED_LOGO_ENTITIES);
  const report = {
    imported: 0,
    cached: 0,
    publicCached: 0,
    skipped: 0,
    processed: 0,
    remaining: ids.length - selected.length,
    nextAfter: null as string | null,
    entities: [] as {
      wikidataId: string;
      merchantId: string;
      status: string;
      reason?: string;
    }[],
  };
  const release = acquireAuthorizedLogoImport(store.accounts, userId);
  try {
    for (let start = 0; start < selected.length; start += size) {
      for (const wikidataId of selected.slice(start, start + size)) {
        signal.throwIfAborted();
        const references = groups.get(wikidataId)!;
        const reference =
          references.find(
            (merchant) =>
              store.authorizedLogo(userId, merchant.id)?.logo.provenance
                .kind !== "local-file",
          ) ?? references[0];
        let cachedGrant = null;
        if (!options.refresh && !choices.has(wikidataId)) {
          for (const merchant of references) {
            const candidate = store.authorizedLogo(userId, merchant.id);
            if (
              candidate &&
              candidate.logo.provenance.kind === "commons" &&
              candidate.logo.provenance.wikidataId === wikidataId &&
              (await readAuthorizedMerchantLogo(
                store.accounts.path,
                userId,
                candidate.logo,
              ))
            ) {
              cachedGrant = candidate;
              break;
            }
          }
          if (!cachedGrant) {
            let supplied = 0;
            for (const merchant of references) {
              const candidate = store.authorizedLogo(userId, merchant.id);
              if (
                candidate?.logo.provenance.kind !== "local-file" ||
                !(await readAuthorizedMerchantLogo(
                  store.accounts.path,
                  userId,
                  candidate.logo,
                ))
              )
                break;
              supplied++;
              if (supplied === references.length) cachedGrant = candidate;
            }
          }
        }
        if (cachedGrant) {
          if (
            cachedGrant.logo.provenance.kind === "commons" &&
            (cachedGrant.logo.rightsReference !== rightsReference ||
              cachedGrant.canonicalName !==
                store.getMerchant(cachedGrant.merchantId)?.canonicalName)
          )
            store.saveAuthorizedLogo(userId, cachedGrant.merchantId, {
              ...cachedGrant.logo,
              rightsReference,
            });
          report.cached++;
          report.entities.push({
            wikidataId,
            merchantId: cachedGrant.merchantId,
            status: "cached",
          });
        } else {
          let publicCached = false;
          if (!options.refresh && !choices.has(wikidataId))
            for (const merchant of references)
              if (
                merchant.logo &&
                (await readPrivateMerchantLogo(
                  store.accounts.path,
                  merchant.logo,
                ))
              ) {
                publicCached = true;
                break;
              }
          if (publicCached) {
            report.publicCached++;
            report.entities.push({
              wikidataId,
              merchantId: reference.id,
              status: "public-cached",
            });
          } else {
            const result = await retrieveAuthorizedCommonsRaster(wikidataId, {
              fetch: options.fetch,
              signal,
              retries: 2,
              filename: choices.get(wikidataId),
            });
            signal.throwIfAborted();
            if (result.status === "skipped") {
              report.skipped++;
              report.entities.push({
                wikidataId,
                merchantId: reference.id,
                status: "skipped",
                reason: result.reason,
              });
            } else {
              await persistRasterGrant(
                store,
                userId,
                reference.id,
                result.png,
                {
                  permission: "operator-declared-private-usage-rights",
                  rightsReference,
                  attribution: result.attribution,
                  provenance: {
                    kind: "commons",
                    wikidataId,
                    sourceUrl: result.sourceUrl,
                  },
                  publicRights: result.publicRights,
                },
              );
              report.imported++;
              report.entities.push({
                wikidataId,
                merchantId: reference.id,
                status: "imported",
              });
            }
          }
        }
        report.processed++;
      }
      const cursor = selected[Math.min(start + size, selected.length) - 1];
      report.nextAfter = report.remaining ? cursor : null;
      options.onBatch?.({
        processed: report.processed,
        cursor,
        remaining: ids.length - report.processed,
      });
    }
    return report;
  } finally {
    release();
  }
}
