import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AccountDatabase } from "@/lib/server/database";
import { AccountError } from "@/lib/server/errors";
import { AutomationStore } from "@/lib/automation/store";
import { MAX_UPLOAD_BYTES } from "@/lib/automation/schema";
import { bankAccountTarget, BANK_SYNC_FORMAT, coveredUntilByAccount, accountIdentity, type BankSyncFile } from "@/lib/import/bank-sync";
import { readXs2aConfig, Xs2aClient, Xs2aError, type Xs2aConnection } from "./xs2a";

const DAY = 86_400_000;
const FIRST_SYNC_DAYS = 90;
const OVERLAP_DAYS = 7;
const TOKEN_DAYS = 180;
export const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

const linkSchema = z.object({
  version: z.literal(1),
  bankUserId: z.string().min(1),
  token: z.object({ id: z.string(), token: z.string(), validUntil: z.number() }).nullable(),
  connections: z.array(z.object({
    id: z.string(),
    bankName: z.string().nullable(),
    bic: z.string().nullable(),
    syncActive: z.boolean().nullable(),
    message: z.string().nullable(),
    consentValidUntil: z.string().nullable(),
    lastSynced: z.string().nullable(),
    testmode: z.boolean().nullable(),
  })).default([]),
  accounts: z.array(z.object({
    id: z.string(),
    connectionId: z.string().nullable(),
    bank: z.string(),
    pocket: z.string().nullable(),
    label: z.string(),
    iban: z.string().nullable(),
    balance: z.number().nullable(),
    available: z.number().nullable(),
    balanceDate: z.string().nullable(),
  })).default([]),
  lastSync: z.number().nullable().default(null),
  lastSyncRows: z.number().nullable().default(null),
  lastError: z.string().nullable().default(null),
});
type BankLink = z.infer<typeof linkSchema>;

export type BankStatus = {
  available: boolean;
  configured: boolean;
  connections: BankLink["connections"];
  accounts: BankLink["accounts"];
  lastSync: number | null;
  lastSyncRows: number | null;
  lastError: string | null;
};

const locks = new Map<string, Promise<unknown>>();
async function withUserLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(userId, next);
  try {
    return await next;
  } finally {
    if (locks.get(userId) === next) locks.delete(userId);
  }
}

function linkDirectory(database: AccountDatabase): string {
  return join(dirname(database.path), "bank-links");
}

function linkPath(database: AccountDatabase, userId: string): string {
  z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(userId);
  return join(linkDirectory(database), `${userId}.json`);
}

async function readLink(database: AccountDatabase, userId: string): Promise<BankLink | null> {
  try {
    const parsed = linkSchema.safeParse(JSON.parse(await readFile(linkPath(database, userId), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeLink(database: AccountDatabase, userId: string, link: BankLink): Promise<void> {
  const path = linkPath(database, userId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("Bank link directory must not be a symlink");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(linkSchema.parse(link)));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function client(): Xs2aClient {
  const config = readXs2aConfig();
  if (!config) throw new AccountError(503, "Die Bankverbindung ist nicht eingerichtet. Bitte XS2A_API_KEY in .env.local hinterlegen.");
  return new Xs2aClient(config);
}

function bankError(error: unknown): never {
  if (error instanceof Xs2aError) {
    if (error.status === 401 || error.status === 403)
      throw new AccountError(502, "Der XS2A-Zugang wurde abgelehnt. Bitte API-Schlüssel prüfen.");
    throw new AccountError(502, `Bankschnittstelle: ${error.message}`);
  }
  throw error;
}

async function ensureToken(api: Xs2aClient, database: AccountDatabase, user: { id: string; username: string }, link: BankLink | null, now: number): Promise<BankLink> {
  let next = link;
  if (!next) {
    const bankUser = await api.createUser(user.username.slice(0, 100), `${user.id}@finanzblick.invalid`);
    next = linkSchema.parse({ version: 1, bankUserId: bankUser.id, token: null });
  }
  if (!next.token || next.token.validUntil - now < 7 * DAY) {
    const validUntil = new Date(now + TOKEN_DAYS * DAY);
    const token = await api.createAccessToken(next.bankUserId, validUntil);
    next = { ...next, token: { id: token.id, token: token.token, validUntil: validUntil.getTime() } };
  }
  await writeLink(database, user.id, next);
  return next;
}

function mapConnection(connection: Xs2aConnection): BankLink["connections"][number] {
  return {
    id: connection.id,
    bankName: connection.bank_name ?? null,
    bic: connection.bic ?? null,
    syncActive: connection.sync_active ?? null,
    message: connection.sync_message ?? null,
    consentValidUntil: connection.consent_valid_until ?? null,
    lastSynced: connection.last_synced ?? null,
    testmode: connection.testmode ?? null,
  };
}

const maskIban = (iban: string | null | undefined) => {
  const compact = (iban ?? "").replace(/\s/g, "");
  return compact.length > 8 ? `${compact.slice(0, 4)} •••• ${compact.slice(-4)}` : compact || null;
};

export async function bankStatus(database: AccountDatabase, userId: string): Promise<BankStatus> {
  const configured = readXs2aConfig() !== null;
  const link = await readLink(database, userId);
  return {
    available: true,
    configured,
    connections: link?.connections ?? [],
    accounts: link?.accounts ?? [],
    lastSync: link?.lastSync ?? null,
    lastSyncRows: link?.lastSyncRows ?? null,
    lastError: link?.lastError ?? null,
  };
}

export async function startBankConnection(
  database: AccountDatabase,
  user: { id: string; username: string },
  request: { country: string; bic?: string },
): Promise<{ wizardSessionKey: string }> {
  const api = client();
  return withUserLock(user.id, async () => {
    try {
      const link = await ensureToken(api, database, user, await readLink(database, user.id), Date.now());
      const session = await api.createConnection(link.token!.token, { country: request.country, bic: request.bic, days: FIRST_SYNC_DAYS });
      return { wizardSessionKey: session.wizard_session_key };
    } catch (error) {
      return bankError(error);
    }
  });
}

export async function renewBankConnection(database: AccountDatabase, user: { id: string; username: string }, connectionId: string): Promise<{ wizardSessionKey: string }> {
  const api = client();
  return withUserLock(user.id, async () => {
    try {
      const link = await ensureToken(api, database, user, await readLink(database, user.id), Date.now());
      if (!link.connections.some((connection) => connection.id === connectionId)) throw new AccountError(404, "Bankverbindung nicht gefunden.");
      const session = await api.resetConnection(link.token!.token, connectionId);
      return { wizardSessionKey: session.wizard_session_key };
    } catch (error) {
      return bankError(error);
    }
  });
}

export async function removeBankConnection(database: AccountDatabase, user: { id: string; username: string }, connectionId: string): Promise<BankStatus> {
  const api = client();
  return withUserLock(user.id, async () => {
    const link = await readLink(database, user.id);
    if (!link?.token || !link.connections.some((connection) => connection.id === connectionId))
      throw new AccountError(404, "Bankverbindung nicht gefunden.");
    try {
      await api.deleteConnection(link.token.token, connectionId);
    } catch (error) {
      if (!(error instanceof Xs2aError && error.status === 404)) bankError(error);
    }
    await writeLink(database, user.id, {
      ...link,
      connections: link.connections.filter((connection) => connection.id !== connectionId),
      accounts: link.accounts.filter((account) => account.connectionId !== connectionId),
    });
    return bankStatus(database, user.id);
  });
}

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * Fetches all connected accounts and queues their new bookings as a regular statement
 * import, so categorisation, duplicate checks and review run exactly as for CSV uploads.
 */
export async function syncBank(
  database: AccountDatabase,
  user: { id: string; username: string },
  options: { refresh?: boolean; now?: number; api?: Xs2aClient } = {},
): Promise<BankStatus & { queued: boolean; rows: number }> {
  const api = options.api ?? client();
  const now = options.now ?? Date.now();
  return withUserLock(user.id, async () => {
    const stored = await readLink(database, user.id);
    if (!stored) throw new AccountError(409, "Noch keine Bank verbunden.");
    let link = stored;
    try {
      link = await ensureToken(api, database, user, stored, now);
      const token = link.token!.token;
      let connections = await api.listConnections(token);
      let needsConsent = false;
      if (options.refresh) {
        const results = await Promise.allSettled(connections.filter((connection) => connection.sync_active !== false)
          .map((connection) => api.syncConnection(token, connection.id)));
        needsConsent = results.some((result) => result.status === "fulfilled" && result.value !== null);
        connections = await api.listConnections(token);
      }
      const accounts = await api.listAccounts(token);
      const from = isoDay(link.lastSync ? link.lastSync - OVERLAP_DAYS * DAY : now - FIRST_SYNC_DAYS * DAY);
      const to = isoDay(now);
      const existing = database.getFinance(user.id).state?.transactions ?? [];
      const covered = coveredUntilByAccount(existing);
      const file: BankSyncFile = { format: BANK_SYNC_FORMAT, version: 1, provider: "xs2a", fetchedAt: new Date(now).toISOString(), accounts: [] };
      const summaries: BankLink["accounts"] = [];
      for (const account of accounts) {
        const target = bankAccountTarget({ bankName: account.bank_name, bic: account.bic, description: account.description, iban: account.iban });
        const [turnovers, balance] = await Promise.all([
          api.turnovers(token, account.id, from, to),
          api.balance(token, account.id).catch(() => null),
        ]);
        file.accounts.push({
          id: account.id,
          bankName: account.bank_name ?? null,
          bic: account.bic ?? null,
          iban: account.iban ?? null,
          description: account.description ?? null,
          type: account.type ?? null,
          coveredUntil: covered.get(accountIdentity(target)) ?? null,
          turnovers,
        });
        summaries.push({
          id: account.id,
          connectionId: account.bank_connection_id ?? null,
          bank: target.bank,
          pocket: target.pocket,
          label: account.description || target.pocket || target.bank,
          iban: maskIban(account.iban),
          balance: balance?.balance ?? null,
          available: balance?.available ?? null,
          balanceDate: balance?.date ?? null,
        });
      }
      const count = file.accounts.reduce((sum, account) => sum + account.turnovers.length, 0);
      const queued = count > 0 && await enqueue(database, user.id, file, now);
      link = { ...link, connections: connections.map(mapConnection), accounts: summaries, lastSync: now, lastSyncRows: count,
        lastError: needsConsent ? "Die Bank verlangt eine erneute Bestätigung. Bitte bei der Verbindung „Freigabe erneuern“ wählen." : null };
      await writeLink(database, user.id, link);
      return { ...(await bankStatus(database, user.id)), queued, rows: count };
    } catch (error) {
      const message = error instanceof Xs2aError || error instanceof AccountError ? error.message : "Bankabruf fehlgeschlagen.";
      await writeLink(database, user.id, { ...link, lastError: message.slice(0, 300) }).catch(() => undefined);
      return bankError(error);
    }
  });
}

async function enqueue(database: AccountDatabase, userId: string, file: BankSyncFile, now: number): Promise<boolean> {
  const bytes = Buffer.from(JSON.stringify(file));
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new AccountError(413, "Der Bankabruf ist zu groß.");
  const store = new AutomationStore(database);
  const id = randomUUID();
  store.reserveUpload(userId, id, `Bankabruf-${isoDay(now)}.bank.json`, bytes.byteLength, now);
  const path = store.filePath(id);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    store.readyUpload(userId, id);
    return true;
  } catch (error) {
    if (store.failUpload(userId, id)) {
      await unlink(path).catch(() => undefined);
      store.cleaned(id);
    }
    throw error;
  }
}

/** Users with a stored bank link (used by the background worker for automatic syncs). */
export async function linkedBankUsers(database: AccountDatabase): Promise<string[]> {
  try {
    return (await readdir(linkDirectory(database)))
      .filter((name) => /^[A-Za-z0-9_-]{1,100}\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function autoSyncDue(database: AccountDatabase, userId: string, now = Date.now()): Promise<boolean> {
  const link = await readLink(database, userId);
  return !!link?.token && (!link.lastSync || now - link.lastSync >= AUTO_SYNC_INTERVAL_MS);
}
