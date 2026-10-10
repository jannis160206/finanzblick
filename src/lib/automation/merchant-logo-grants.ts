import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AccountDatabase } from "@/lib/server/database";
import {
  authorizedLogoVersion,
  legacyAuthorizedLogoVersion,
  authorizedMerchantLogoSchema,
  logoAccountIdSchema,
  logoMerchantIdSchema,
  type AuthorizedLogoGrant,
  type AuthorizedMerchantLogo,
} from "./merchant-logo-grant-metadata";
import { readStoredLogoPng } from "./merchant-logo-raster";

export const MAX_ACCOUNT_LOGO_VERSIONS = 2000;
export const MAX_ACCOUNT_LOGO_FILES = 1024;
export const MAX_TOTAL_LOGO_VERSIONS = 10_000;
export const MAX_TOTAL_PRIVATE_LOGO_FILES = 10_000;

function accountAssetKey(userId: string): string {
  return createHash("sha256")
    .update(logoAccountIdSchema.parse(userId))
    .digest("hex");
}

export function authorizedLogoDirectory(
  databasePath: string,
  userId: string,
): string {
  const accountKey = accountAssetKey(userId);
  return join(dirname(databasePath), "merchant-authorized-logos", accountKey);
}

export function reserveAuthorizedLogoAsset(
  accounts: AccountDatabase,
  userId: string,
  input: string,
): void {
  requireLogoAccount(accounts, userId);
  const file = authorizedMerchantLogoSchema.shape.file.parse(input);
  const accountKey = accountAssetKey(userId);
  accounts.transaction((db) => {
    if (
      db
        .prepare(
          `SELECT 1 FROM merchant_authorized_logo_assets
      WHERE account_key = ? AND file = ?`,
        )
        .get(accountKey, file)
    )
      return;
    const account = Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM merchant_authorized_logo_assets WHERE account_key = ?",
        )
        .get(accountKey)?.n,
    );
    const total = Number(
      db
        .prepare("SELECT count(*) AS n FROM merchant_authorized_logo_assets")
        .get()?.n,
    );
    if (
      account >= MAX_ACCOUNT_LOGO_FILES ||
      total >= MAX_TOTAL_PRIVATE_LOGO_FILES
    )
      throw new RangeError("Private logo persistent asset quota reached");
    // Keep this reservation even after account deletion or a partial write:
    // unreferenced private disk bytes must still count against the finite quota.
    db.prepare("INSERT INTO merchant_authorized_logo_assets VALUES (?, ?)").run(
      accountKey,
      file,
    );
  });
}

export async function readAuthorizedMerchantLogo(
  databasePath: string,
  userId: string,
  input: unknown,
): Promise<Buffer | null> {
  logoAccountIdSchema.parse(userId);
  const parsed = authorizedMerchantLogoSchema.safeParse(input);
  return parsed.success
    ? readStoredLogoPng(
        authorizedLogoDirectory(databasePath, userId),
        parsed.data.file,
      )
    : null;
}

export function requireLogoAccount(
  accounts: AccountDatabase,
  input: string,
): string {
  const userId = logoAccountIdSchema.parse(input);
  if (
    !accounts.read((db) =>
      db.prepare("SELECT id FROM users WHERE id = ?").get(userId),
    )
  )
    throw new Error("Explicit existing account required for private logos");
  return userId;
}

export function readAuthorizedLogoGrant(
  accounts: AccountDatabase,
  userId: string,
  merchantId: string,
  version?: string,
): AuthorizedLogoGrant | null {
  logoAccountIdSchema.parse(userId);
  logoMerchantIdSchema.parse(merchantId);
  if (version !== undefined && !/^[a-f0-9]{64}$/.test(version)) return null;
  return accounts.read((db) => {
    const row = db
      .prepare(
        `SELECT merchant_id, canonical_name, version, logo_json
      FROM merchant_authorized_logos WHERE user_id = ? AND merchant_id = ? AND
      ${version === undefined ? "is_current = 1" : "version = ?"}`,
      )
      .get(userId, merchantId, ...(version === undefined ? [] : [version]));
    if (!row) return null;
    return grantFromRow(userId, row);
  });
}

function grantFromRow(
  userId: string,
  row: Record<string, unknown>,
): AuthorizedLogoGrant {
  const logo = authorizedMerchantLogoSchema.parse(
    JSON.parse(String(row.logo_json)),
  );
  const identity = {
    merchantId: String(row.merchant_id),
    canonicalName: String(row.canonical_name),
  };
  if (
    authorizedLogoVersion(userId, identity, logo) !== row.version &&
    legacyAuthorizedLogoVersion(userId, logo) !== row.version
  )
    throw new Error("Private logo metadata version mismatch");
  return {
    ...identity,
    version: String(row.version),
    logo,
  };
}

export function readAuthorizedLogoCandidates(
  accounts: AccountDatabase,
  userId: string,
  ids: string[],
  entities: string[],
): AuthorizedLogoGrant[] {
  logoAccountIdSchema.parse(userId);
  if (!ids.length) return [];
  return accounts.read((db) => {
    const rows = db
      .prepare(
        `SELECT merchant_id, canonical_name, version, logo_json
      FROM merchant_authorized_logos WHERE user_id = ? AND is_current = 1 AND
      (merchant_id IN (${ids.map(() => "?").join(",")})
      ${
        entities.length
          ? `OR json_extract(logo_json, '$.provenance.wikidataId')
        IN (${entities.map(() => "?").join(",")})`
          : ""
      }) LIMIT 1001`,
      )
      .all(userId, ...ids, ...entities);
    if (rows.length > 1000)
      throw new RangeError("Private logo candidate limit reached");
    return rows.map((row) => grantFromRow(userId, row));
  });
}

export function checkAuthorizedLogoQuota(
  db: DatabaseSync,
  userId: string,
): void {
  const account = Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM merchant_authorized_logos WHERE user_id = ?",
      )
      .get(userId)?.n,
  );
  const total = Number(
    db.prepare("SELECT count(*) AS n FROM merchant_authorized_logos").get()?.n,
  );
  if (account >= MAX_ACCOUNT_LOGO_VERSIONS || total >= MAX_TOTAL_LOGO_VERSIONS)
    throw new RangeError("Private logo metadata/archive quota reached");
}

export function saveAuthorizedLogoGrant(
  accounts: AccountDatabase,
  userId: string,
  merchantId: string,
  canonicalName: string,
  input: AuthorizedMerchantLogo,
): AuthorizedLogoGrant {
  requireLogoAccount(accounts, userId);
  logoMerchantIdSchema.parse(merchantId);
  const logo = authorizedMerchantLogoSchema.parse(input);
  const version = authorizedLogoVersion(
    userId,
    { merchantId, canonicalName },
    logo,
  );
  const json = JSON.stringify(logo);
  if (Buffer.byteLength(json) > 16 * 1024)
    throw new RangeError("Private logo metadata exceeds limit");
  accounts.transaction((db) => {
    const known = db
      .prepare(
        "SELECT id, canonical_name, wikidata_id, source FROM merchants WHERE id = ?",
      )
      .get(merchantId);
    if (!known)
      throw new Error("Private logo requires an existing public merchant ID");
    const entity =
      known.wikidata_id ??
      (known.source === "osm"
        ? /^osm-brand-(Q[1-9]\d{0,13})-[a-f0-9]{16}$/.exec(merchantId)?.[1]
        : null);
    if (
      known.canonical_name !== canonicalName ||
      (logo.provenance.kind !== "local-file" &&
        entity !== logo.provenance.wikidataId)
    )
      throw new Error(
        "Public merchant identity changed during authorized logo import",
      );
    const existing = db
      .prepare(
        `SELECT 1 FROM merchant_authorized_logos
      WHERE user_id = ? AND merchant_id = ? AND version = ?`,
      )
      .get(userId, merchantId, version);
    if (!existing) checkAuthorizedLogoQuota(db, userId);
    db.prepare(
      `UPDATE merchant_authorized_logos SET is_current = 0
      WHERE user_id = ? AND merchant_id = ? AND is_current = 1`,
    ).run(userId, merchantId);
    db.prepare(
      `INSERT INTO merchant_authorized_logos
      (user_id, merchant_id, version, canonical_name, logo_json, is_current, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(user_id, merchant_id, version) DO UPDATE SET is_current = 1`,
    ).run(userId, merchantId, version, canonicalName, json, Date.now());
  });
  return { merchantId, canonicalName, version, logo };
}

export function acquireAuthorizedLogoImport(
  accounts: AccountDatabase,
  input: string,
): () => void {
  const userId = requireLogoAccount(accounts, input);
  const owner = randomUUID();
  const now = Date.now();
  accounts.transaction((db) => {
    db.prepare(
      "DELETE FROM merchant_authorized_logo_imports WHERE expires_at <= ?",
    ).run(now);
    if (
      db
        .prepare(
          "SELECT 1 FROM merchant_authorized_logo_imports WHERE user_id = ?",
        )
        .get(userId)
    )
      throw new Error(
        "An authorized logo import is already running for this account",
      );
    db.prepare(
      "INSERT INTO merchant_authorized_logo_imports VALUES (?, ?, ?)",
    ).run(userId, owner, now + 660_000);
  });
  return () =>
    accounts.transaction((db) => {
      db.prepare(
        "DELETE FROM merchant_authorized_logo_imports WHERE user_id = ? AND owner = ?",
      ).run(userId, owner);
    });
}
