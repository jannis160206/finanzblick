import { isAbsolute, resolve, relative, sep } from "node:path";
import { AccountConfigError } from "./errors";

export interface AccountConfig {
  databasePath: string;
  adminPassword: string;
  adminPasswordMinimum: 4 | 12;
  origin: string | null;
  secureCookies: boolean;
  trustProxy: boolean;
  registrationEnabled: boolean;
  maxAccounts: number;
  maxStorageBytes: number;
}

export function isAccountMode(): boolean {
  const value = process.env.FINANZBLICK_AUTH;
  if (value !== undefined && value !== "true" && value !== "false") {
    throw new AccountConfigError("FINANZBLICK_AUTH must be true or false.");
  }
  if (value === "false") {
    if (
      process.env.NODE_ENV !== "development" &&
      process.env.NODE_ENV !== "test"
    ) {
      throw new AccountConfigError(
        "Account authentication cannot be disabled outside development/test.",
      );
    }
    return false;
  }
  return value === "true" || process.env.NODE_ENV === "production";
}

export function registrationEnabled(): boolean {
  if (!isAccountMode()) return false;
  return readAccountConfig().registrationEnabled;
}

export function readAccountConfig(): AccountConfig {
  if (!isAccountMode())
    throw new AccountConfigError("Account mode is disabled.");
  const production = process.env.NODE_ENV === "production";
  const configuredPath = process.env.FINANZBLICK_DATABASE_PATH;
  if (production && (!configuredPath || !isAbsolute(configuredPath))) {
    throw new AccountConfigError(
      "Production requires an absolute FINANZBLICK_DATABASE_PATH.",
    );
  }
  if (configuredPath && !isAbsolute(configuredPath)) {
    throw new AccountConfigError("FINANZBLICK_DATABASE_PATH must be absolute.");
  }
  const databasePath =
    configuredPath ?? resolve(".local-data", "finanzblick.sqlite");
  const publicRelative = relative(resolve("public"), resolve(/* turbopackIgnore: true */ databasePath));
  if (
    !publicRelative.startsWith(`..${sep}`) &&
    publicRelative !== ".." &&
    !isAbsolute(publicRelative)
  ) {
    throw new AccountConfigError(
      "The account database must not be inside public.",
    );
  }
  let origin: string | null = null;
  if (process.env.FINANZBLICK_ORIGIN) {
    try {
      const url = new URL(process.env.FINANZBLICK_ORIGIN);
      if (
        url.origin !== process.env.FINANZBLICK_ORIGIN ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        (production && url.protocol !== "https:")
      )
        throw new Error("Invalid origin");
      origin = url.origin;
    } catch {
      throw new AccountConfigError(
        "FINANZBLICK_ORIGIN must be an exact origin (HTTPS in production).",
      );
    }
  }
  if (production && !origin) {
    throw new AccountConfigError("Production requires FINANZBLICK_ORIGIN.");
  }
  const localDevelopment =
    ["development", "test"].includes(process.env.NODE_ENV ?? "") &&
    origin !== null &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  const adminPasswordMinimum = localDevelopment ? 4 : 12;
  const adminPassword = process.env.FINANZBLICK_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < adminPasswordMinimum || adminPassword.length > 128) {
    throw new AccountConfigError(
      `FINANZBLICK_ADMIN_PASSWORD must contain ${adminPasswordMinimum}–128 characters.`,
    );
  }
  const proxy = process.env.FINANZBLICK_TRUST_PROXY;
  if (proxy !== undefined && proxy !== "true" && proxy !== "false") {
    throw new AccountConfigError(
      "FINANZBLICK_TRUST_PROXY must be true or false.",
    );
  }
  const registration = process.env.FINANZBLICK_REGISTRATION_ENABLED;
  if (
    registration !== undefined &&
    registration !== "true" &&
    registration !== "false"
  ) {
    throw new AccountConfigError(
      "FINANZBLICK_REGISTRATION_ENABLED must be true or false.",
    );
  }
  const maxAccounts = positiveIntegerSetting(
    "FINANZBLICK_MAX_ACCOUNTS",
    100,
    1000,
  );
  const maxStorageMb = positiveIntegerSetting(
    "FINANZBLICK_MAX_STORAGE_MB",
    256,
    4096,
  );
  return {
    databasePath,
    adminPassword,
    adminPasswordMinimum,
    origin,
    secureCookies: production,
    trustProxy: proxy === "true",
    registrationEnabled: registration !== "false",
    maxAccounts,
    maxStorageBytes: maxStorageMb * 1024 * 1024,
  };
}

function positiveIntegerSetting(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > maximum) {
    throw new AccountConfigError(
      `${name} must be an integer between 1 and ${maximum}.`,
    );
  }
  return Number(raw);
}
