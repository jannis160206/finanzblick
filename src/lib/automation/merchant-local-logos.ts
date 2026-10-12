import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { AutomationStore } from "./store";
import {
  authorizedLogoVersion,
  authorizedMerchantLogoSchema,
  logoAccountIdSchema,
  logoRightsReferenceSchema,
  type AuthorizedLogoGrant,
} from "./merchant-logo-grant-metadata";
import {
  acquireAuthorizedLogoImport,
  authorizedLogoDirectory,
  checkAuthorizedLogoQuota,
  MAX_ACCOUNT_LOGO_FILES,
  readAuthorizedMerchantLogo,
  requireLogoAccount,
  reserveAuthorizedLogoAsset,
} from "./merchant-logo-grants";
import {
  assertNoSymlinkPath,
  logoContentFile,
  MAX_LOGO_INPUT,
  normalizeLogoRaster,
  readBoundedLogoFile,
  writeStoredLogoPng,
} from "./merchant-logo-raster";
import { merchantLogoNameSchema } from "./merchant-presentation-schema";

const MAX_FILES = 200;
const MAX_NAMES = 4200;
export const localLogoAliasesSchema = z.record(
  z.string().min(1).max(240),
  z.array(merchantLogoNameSchema).max(20),
);

export function normalizeLocalLogoName(name: string) {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("de-AT")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function localLogoGrants(store: AutomationStore, userId: string) {
  logoAccountIdSchema.parse(userId);
  const rows = store.accounts.read((db) =>
    db
      .prepare(
        `SELECT name, merchant_id FROM merchant_authorized_logo_names
        WHERE user_id = ? LIMIT ${MAX_NAMES + 1}`,
      )
      .all(userId),
  );
  if (rows.length > MAX_NAMES)
    throw new RangeError("Private logo name quota reached");
  const grants = new Map<string, AuthorizedLogoGrant | null>();
  const names = new Map<string, AuthorizedLogoGrant>();
  for (const row of rows) {
    const id = String(row.merchant_id);
    if (!grants.has(id)) grants.set(id, store.authorizedLogo(userId, id));
    const grant = grants.get(id);
    if (grant) names.set(String(row.name), grant);
  }
  return names;
}

export async function availableLocalLogoGrants(
  store: AutomationStore,
  userId: string,
) {
  const available = new Map<string, AuthorizedLogoGrant>();
  const files = new Map<string, boolean>();
  for (const [name, grant] of localLogoGrants(store, userId)) {
    if (!files.has(grant.logo.file))
      files.set(
        grant.logo.file,
        !!(await readAuthorizedMerchantLogo(
          store.accounts.path,
          userId,
          grant.logo,
        )),
      );
    if (files.get(grant.logo.file)) available.set(name, grant);
  }
  return available;
}

function localLogoId(name: string) {
  return `private-${createHash("sha256").update(name).digest("hex")}`;
}

function checkNameBindings(
  db: DatabaseSync,
  userId: string,
  entries: { names: string[] }[],
) {
  let newNames = 0;
  for (const entry of entries) {
    const merchantId = localLogoId(entry.names[0]);
    for (const name of entry.names) {
      const existing = db
        .prepare(
          "SELECT merchant_id FROM merchant_authorized_logo_names WHERE user_id = ? AND name = ?",
        )
        .get(userId, name);
      if (existing && existing.merchant_id !== merchantId)
        throw new Error(
          "Supplied name already belongs to another private logo",
        );
      if (!existing) newNames++;
    }
  }
  const count = Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM merchant_authorized_logo_names WHERE user_id = ?",
      )
      .get(userId)?.n,
  );
  if (count + newNames > MAX_NAMES)
    throw new RangeError("Private logo name quota reached");
}

export async function importSuppliedLocalLogos(
  store: AutomationStore,
  options: {
    userId: string;
    directory: string;
    rightsReference: string;
    aliases?: Record<string, string[]>;
    signal?: AbortSignal;
  },
) {
  const userId = requireLogoAccount(store.accounts, options.userId);
  const rightsReference = logoRightsReferenceSchema.parse(
    options.rightsReference,
  );
  const aliases = localLogoAliasesSchema.parse(options.aliases ?? {});
  const root = resolve(options.directory);
  await assertNoSymlinkPath(root);
  const entries: {
    file: string;
    name: string;
    names: string[];
    png: Buffer;
  }[] = [];
  const seen = new Set<string>();
  const release = acquireAuthorizedLogoImport(store.accounts, userId);
  try {
    const directory = await opendir(root);
    for await (const entry of directory) {
      options.signal?.throwIfAborted();
      if (!/\.(?:png|jpe?g|webp|avif)$/i.test(entry.name)) continue;
      if (entries.length >= MAX_FILES)
        throw new RangeError("Too many supplied logos");
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("Supplied logos must be regular raster files");
      const extension = extname(entry.name);
      const name = merchantLogoNameSchema.parse(
        entry.name.slice(0, -extension.length),
      );
      const names = [
        ...new Set(
          [name, ...(aliases[entry.name] ?? [])].map(normalizeLocalLogoName),
        ),
      ];
      for (const key of names) {
        merchantLogoNameSchema.parse(key);
        if (seen.has(key)) throw new Error("Conflicting supplied logo names");
        seen.add(key);
      }
      const bytes = await readBoundedLogoFile(
        resolve(root, entry.name),
        MAX_LOGO_INPUT,
      );
      const mime = /\.png$/i.test(extension)
        ? "image/png"
        : /\.avif$/i.test(extension)
          ? "image/avif"
          : /\.webp$/i.test(extension)
            ? "image/webp"
            : "image/jpeg";
      const png = await normalizeLogoRaster(bytes, {
        mime,
        suppliedLocalFile: true,
      });
      if (!png)
        throw new Error(`Invalid or unsafe supplied raster: ${entry.name}`);
      entries.push({ file: entry.name, name, names, png });
    }
    if (!entries.length) throw new Error("No supplied raster logos found");
    if (
      Object.keys(aliases).some(
        (file) => !entries.some((entry) => entry.file === file),
      )
    )
      throw new Error("Logo aliases refer to an unknown supplied file");
    entries.sort((a, b) => a.file.localeCompare(b.file));
    store.accounts.read((db) => checkNameBindings(db, userId, entries));
    const report = { imported: 0, cached: 0, files: [] as string[] };
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const merchantId = localLogoId(entry.names[0]);
      const logo = authorizedMerchantLogoSchema.parse({
        file: logoContentFile(entry.png),
        permission: "operator-declared-private-usage-rights",
        rightsReference,
        attribution:
          "User-supplied booking logo; edge padding trimmed and resized to PNG",
        provenance: { kind: "local-file", sourceLabel: entry.file },
        publicRights: null,
      });
      const version = authorizedLogoVersion(
        userId,
        {
          merchantId,
          canonicalName: entry.name,
        },
        logo,
      );
      const previous = store.authorizedLogo(userId, merchantId);
      store.accounts.read((db) => {
        checkNameBindings(db, userId, [entry]);
        if (!store.authorizedLogo(userId, merchantId, version))
          checkAuthorizedLogoQuota(db, userId);
      });
      reserveAuthorizedLogoAsset(store.accounts, userId, logo.file);
      await writeStoredLogoPng(
        authorizedLogoDirectory(store.accounts.path, userId),
        entry.png,
        MAX_ACCOUNT_LOGO_FILES,
      );
      store.accounts.transaction((db) => {
        checkNameBindings(db, userId, [entry]);
        if (!store.authorizedLogo(userId, merchantId, version))
          checkAuthorizedLogoQuota(db, userId);
        for (const name of entry.names) {
          db.prepare(
            "INSERT OR IGNORE INTO merchant_authorized_logo_names VALUES (?, ?, ?)",
          ).run(userId, name, merchantId);
        }
        db.prepare(
          "UPDATE merchant_authorized_logos SET is_current = 0 WHERE user_id = ? AND merchant_id = ?",
        ).run(userId, merchantId);
        db.prepare(
          `INSERT INTO merchant_authorized_logos
          (user_id, merchant_id, version, canonical_name, logo_json, is_current, created_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(user_id, merchant_id, version) DO UPDATE SET is_current = 1`,
        ).run(
          userId,
          merchantId,
          version,
          entry.name,
          JSON.stringify(logo),
          Date.now(),
        );
      });
      if (previous?.version === version) report.cached++;
      else report.imported++;
      report.files.push(entry.file);
    }
    return report;
  } finally {
    release();
  }
}
