import { hashToken, AccountDatabase } from "./database";
import { readAccountConfig, type AccountConfig } from "./config";

interface RuntimeEntry {
  database: AccountDatabase;
  passwordFingerprint: string;
  ready: Promise<void>;
}

const runtimeGlobal = globalThis as typeof globalThis & {
  finanzblickDatabases?: Map<string, RuntimeEntry>;
};

function cache(): Map<string, RuntimeEntry> {
  return (runtimeGlobal.finanzblickDatabases ??= new Map());
}

export async function getAccountRuntime(): Promise<{
  config: AccountConfig;
  database: AccountDatabase;
}> {
  const config = readAccountConfig();
  const fingerprint = hashToken(config.adminPassword);
  let entry = cache().get(config.databasePath);
  if (!entry) {
    const database = new AccountDatabase(config.databasePath);
    entry = {
      database,
      passwordFingerprint: fingerprint,
      ready: database.synchronizeAdmin(config.adminPassword, Date.now(), config.adminPasswordMinimum),
    };
    cache().set(config.databasePath, entry);
  } else if (entry.passwordFingerprint !== fingerprint) {
    entry.ready = entry.ready.then(() =>
      entry!.database.synchronizeAdmin(config.adminPassword, Date.now(), config.adminPasswordMinimum),
    );
    entry.passwordFingerprint = fingerprint;
  }
  entry.database.configureLimits({
    maxAccounts: config.maxAccounts,
    maxStorageBytes: config.maxStorageBytes,
  });
  try {
    await entry.ready;
  } catch (error) {
    if (cache().get(config.databasePath) === entry) {
      cache().delete(config.databasePath);
      entry.database.close();
    }
    throw error;
  }
  return { config, database: entry.database };
}

export function closeAccountDatabases(): void {
  for (const entry of cache().values()) entry.database.close();
  cache().clear();
}
