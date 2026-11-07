import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AccountDatabase } from "@/lib/server/database";
import { AccountError } from "@/lib/server/errors";
import { AutomationStore } from "@/lib/automation/store";
import { MAX_UPLOAD_BYTES } from "@/lib/automation/schema";
import { bankAccountTarget, BANK_SYNC_FORMAT, coveredUntilByAccount, accountIdentity, type BankSyncFile } from "@/lib/import/bank-sync";
import { readXs2aConfig, Xs2aClient, Xs2aError, type Xs2aConnection } from "./xs2a";
import { EnableBankingClient, EnableBankingError, pickBalances, readEnableBankingConfig, toTurnover, type EbAccount } from "./enable-banking";

const DAY = 86_400_000;
const FIRST_SYNC_DAYS = 90;
const OVERLAP_DAYS = 7;
const TOKEN_DAYS = 180;
const CONSENT_DAYS = 180;
const PENDING_MS = 30 * 60 * 1000;
export const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type BankProvider = "xs2a" | "enablebanking";

const connectionSchema = z.object({
  id: z.string(),
  bankName: z.string().nullable(),
  bic: z.string().nullable(),
  syncActive: z.boolean().nullable(),
  message: z.string().nullable(),
  consentValidUntil: z.string().nullable(),
  lastSynced: z.string().nullable(),
  testmode: z.boolean().nullable(),
  country: z.string().nullable().default(null),
});

const linkSchema = z.object({
  version: z.literal(1),
  provider: z.enum(["xs2a", "enablebanking"]).default("xs2a"),
  bankUserId: z.string().min(1).nullable().default(null),
  token: z.object({ id: z.string(), token: z.string(), validUntil: z.number() }).nullable().default(null),
  connections: z.array(connectionSchema).default([]),
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
  /** Account details as delivered once at session creation (Enable Banking only). */
  providerAccounts: z.array(z.object({
    id: z.string(),
    connectionId: z.string(),
    bankName: z.string().nullable(),
    bic: z.string().nullable(),
    iban: z.string().nullable(),
    description: z.string().nullable(),
    type: z.string().nullable(),
  })).default([]),
  /** Open bank authorisations waiting for the redirect back (Enable Banking only). */
  pending: z.array(z.object({
    state: z.string(),
    aspspName: z.string(),
    country: z.string(),
    renewConnectionId: z.string().nullable(),
    expiresAt: z.number(),
  })).default([]),
  lastSync: z.number().nullable().default(null),
  lastSyncRows: z.number().nullable().default(null),
  lastError: z.string().nullable().default(null),
});
type BankLink = z.infer<typeof linkSchema>;

export type BankStatus = {
  available: boolean;
  configured: boolean;
  provider: BankProvider | null;
  connections: BankLink["connections"];
  accounts: BankLink["accounts"];
  lastSync: number | null;
  lastSyncRows: number | null;
  lastError: string | null;
};

export type BankConnectStart = { wizardSessionKey: string } | { redirectUrl: string };

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

const emptyLink = (provider: BankProvider): BankLink => linkSchema.parse({ version: 1, provider });

/** Enable Banking wins when both are configured, because it is usable by private persons. */
export function configuredBankProvider(): BankProvider | null {
  if (readEnableBankingConfig()) return "enablebanking";
  if (readXs2aConfig()) return "xs2a";
  return null;
}

const NOT_CONFIGURED = "Die Bankverbindung ist nicht eingerichtet. Bitte ENABLEBANKING_APP_ID und den privaten Schlüssel (oder XS2A_API_KEY) in .env.local hinterlegen.";

function xs2aClient(): Xs2aClient {
  const config = readXs2aConfig();
  if (!config) throw new AccountError(503, NOT_CONFIGURED);
  return new Xs2aClient(config);
}

function enableBankingClient(): EnableBankingClient {
  const config = readEnableBankingConfig();
  if (!config) throw new AccountError(503, NOT_CONFIGURED);
  return new EnableBankingClient(config);
}

function bankError(error: unknown): never {
  if (error instanceof Xs2aError) {
    if (error.status === 401 || error.status === 403)
      throw new AccountError(502, "Der XS2A-Zugang wurde abgelehnt. Bitte API-Schlüssel prüfen.");
    throw new AccountError(502, `Bankschnittstelle: ${error.message}`);
  }
  if (error instanceof EnableBankingError) {
    if (error.status === 401)
      throw new AccountError(502, "Enable Banking hat den Zugang abgelehnt. Bitte App-ID und privaten Schlüssel prüfen.");
    throw new AccountError(502, `Enable Banking: ${error.message}`);
  }
  throw error;
}

/** Returns the stored link for the active provider, refusing to mix providers while banks are still connected. */
function linkFor(provider: BankProvider, link: BankLink | null): BankLink {
  if (!link) return emptyLink(provider);
  if (link.provider === provider) return link;
  if (link.connections.length)
    throw new AccountError(409, "Es ist noch eine Bank über den anderen Anbieter verbunden. Bitte diese Verbindung zuerst entfernen.");
  return { ...emptyLink(provider), lastSync: link.lastSync };
}

async function ensureToken(api: Xs2aClient, database: AccountDatabase, user: { id: string; username: string }, link: BankLink, now: number): Promise<BankLink> {
  let next = link;
  if (!next.bankUserId) {
    const bankUser = await api.createUser(user.username.slice(0, 100), `${user.id}@finanzblick.invalid`);
    next = { ...next, bankUserId: bankUser.id, token: null };
  }
  if (!next.token || next.token.validUntil - now < 7 * DAY) {
    const validUntil = new Date(now + TOKEN_DAYS * DAY);
    const token = await api.createAccessToken(next.bankUserId!, validUntil);
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
    country: null,
  };
}

const maskIban = (iban: string | null | undefined) => {
  const compact = (iban ?? "").replace(/\s/g, "");
  return compact.length > 8 ? `${compact.slice(0, 4)} •••• ${compact.slice(-4)}` : compact || null;
};

export async function bankStatus(database: AccountDatabase, userId: string): Promise<BankStatus> {
  const provider = configuredBankProvider();
  const link = await readLink(database, userId);
  return {
    available: true,
    configured: provider !== null,
    provider,
    connections: link?.connections ?? [],
    accounts: link?.accounts ?? [],
    lastSync: link?.lastSync ?? null,
    lastSyncRows: link?.lastSyncRows ?? null,
    lastError: link?.lastError ?? null,
  };
}

export type BankChoice = { name: string; country: string; logo: string | null };

/** Banks reachable through Enable Banking for one country (used by the bank picker). */
export async function bankChoices(country: string, api: EnableBankingClient = enableBankingClient()): Promise<BankChoice[]> {
  try {
    const aspsps = await api.aspsps(country);
    return aspsps
      .filter((aspsp) => !aspsp.psu_types || aspsp.psu_types.includes("personal"))
      .map((aspsp) => ({ name: aspsp.name, country: aspsp.country, logo: aspsp.logo ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  } catch (error) {
    return bankError(error);
  }
}

async function startEnableBanking(
  database: AccountDatabase,
  userId: string,
  request: { country: string; aspsp: string; origin: string; renewConnectionId: string | null },
  api: EnableBankingClient,
  now: number,
): Promise<{ redirectUrl: string }> {
  const link = linkFor("enablebanking", await readLink(database, userId));
  const aspsp = (await api.aspsps(request.country)).find((entry) => entry.name === request.aspsp);
  if (!aspsp) throw new AccountError(404, "Diese Bank ist bei Enable Banking nicht verfügbar.");
  const maxSeconds = aspsp.maximum_consent_validity && aspsp.maximum_consent_validity > 0 ? aspsp.maximum_consent_validity : CONSENT_DAYS * 86_400;
  const validUntil = new Date(now + Math.min(CONSENT_DAYS * DAY, maxSeconds * 1000) - 60_000);
  const state = randomBytes(24).toString("base64url");
  const redirectUrl = api.redirectUrl ?? `${request.origin}/api/bank/callback`;
  const auth = await api.startAuthorization({ aspsp: { name: aspsp.name, country: aspsp.country }, validUntil, state, redirectUrl });
  const pending = [
    ...link.pending.filter((entry) => entry.expiresAt > now).slice(-4),
    { state, aspspName: aspsp.name, country: aspsp.country, renewConnectionId: request.renewConnectionId, expiresAt: now + PENDING_MS },
  ];
  await writeLink(database, userId, { ...link, pending });
  return { redirectUrl: auth.url };
}

export async function startBankConnection(
  database: AccountDatabase,
  user: { id: string; username: string },
  request: { country: string; bic?: string; aspsp?: string; origin: string },
  options: { enableBanking?: EnableBankingClient; now?: number } = {},
): Promise<BankConnectStart> {
  const provider = options.enableBanking ? "enablebanking" : configuredBankProvider();
  if (!provider) throw new AccountError(503, NOT_CONFIGURED);
  const now = options.now ?? Date.now();
  return withUserLock(user.id, async () => {
    try {
      if (provider === "enablebanking") {
        if (!request.aspsp) throw new AccountError(400, "Bitte eine Bank auswählen.");
        return await startEnableBanking(database, user.id, { country: request.country, aspsp: request.aspsp, origin: request.origin, renewConnectionId: null },
          options.enableBanking ?? enableBankingClient(), now);
      }
      const api = xs2aClient();
      const link = await ensureToken(api, database, user, linkFor("xs2a", await readLink(database, user.id)), now);
      const session = await api.createConnection(link.token!.token, { country: request.country, bic: request.bic, days: FIRST_SYNC_DAYS });
      return { wizardSessionKey: session.wizard_session_key };
    } catch (error) {
      return bankError(error);
    }
  });
}

export async function renewBankConnection(
  database: AccountDatabase,
  user: { id: string; username: string },
  connectionId: string,
  origin: string,
  options: { enableBanking?: EnableBankingClient; now?: number } = {},
): Promise<BankConnectStart> {
  const now = options.now ?? Date.now();
  return withUserLock(user.id, async () => {
    try {
      const stored = await readLink(database, user.id);
      const connection = stored?.connections.find((entry) => entry.id === connectionId);
      if (!stored || !connection) throw new AccountError(404, "Bankverbindung nicht gefunden.");
      if (stored.provider === "enablebanking") {
        if (!connection.bankName || !connection.country) throw new AccountError(409, "Bitte die Bank entfernen und neu verbinden.");
        return await startEnableBanking(database, user.id, { country: connection.country, aspsp: connection.bankName, origin, renewConnectionId: connectionId },
          options.enableBanking ?? enableBankingClient(), now);
      }
      const api = xs2aClient();
      const link = await ensureToken(api, database, user, stored, now);
      const session = await api.resetConnection(link.token!.token, connectionId);
      return { wizardSessionKey: session.wizard_session_key };
    } catch (error) {
      return bankError(error);
    }
  });
}

function providerAccount(account: EbAccount, connectionId: string, bankName: string) {
  if (!account.uid) return null;
  return {
    id: account.uid,
    connectionId,
    bankName: account.account_servicer?.name || bankName,
    bic: account.account_servicer?.bic_fi ?? null,
    iban: account.account_id?.iban ?? null,
    description: (account.name || account.product || account.details || null)?.slice(0, 200) ?? null,
    type: account.cash_account_type ?? null,
  };
}

/** Finishes an Enable Banking authorisation after the bank redirected back with ?code&state. */
export async function completeBankAuthorization(
  database: AccountDatabase,
  userId: string,
  callback: { state: string; code: string },
  options: { enableBanking?: EnableBankingClient; now?: number } = {},
): Promise<BankStatus> {
  const now = options.now ?? Date.now();
  return withUserLock(userId, async () => {
    const link = await readLink(database, userId);
    const pending = link?.pending.find((entry) => entry.state === callback.state && entry.expiresAt > now);
    if (!link || link.provider !== "enablebanking" || !pending)
      throw new AccountError(400, "Die Bankfreigabe ist abgelaufen oder ungültig. Bitte erneut verbinden.");
    const api = options.enableBanking ?? enableBankingClient();
    const remaining = link.pending.filter((entry) => entry.state !== callback.state && entry.expiresAt > now);
    try {
      const session = await api.createSession(callback.code);
      const accounts = session.accounts.map((account) => providerAccount(account, session.session_id, session.aspsp.name))
        .filter((account) => account !== null);
      const replaced = pending.renewConnectionId;
      if (replaced && replaced !== session.session_id) await api.deleteSession(replaced).catch(() => undefined);
      const keep = (id: string | null) => id !== replaced && id !== session.session_id;
      const connection: BankLink["connections"][number] = {
        id: session.session_id,
        bankName: session.aspsp.name,
        bic: accounts.find((account) => account.bic)?.bic ?? null,
        syncActive: true,
        message: null,
        consentValidUntil: session.access?.valid_until ?? null,
        lastSynced: null,
        testmode: null,
        country: session.aspsp.country,
      };
      await writeLink(database, userId, {
        ...link,
        pending: remaining,
        connections: [...link.connections.filter((entry) => keep(entry.id)), connection],
        providerAccounts: [...link.providerAccounts.filter((entry) => keep(entry.connectionId)), ...accounts],
        accounts: link.accounts.filter((entry) => keep(entry.connectionId)),
        lastError: accounts.length ? null : "Die Bank hat keine Konten freigegeben.",
      });
      return bankStatus(database, userId);
    } catch (error) {
      await writeLink(database, userId, { ...link, pending: remaining }).catch(() => undefined);
      return bankError(error);
    }
  });
}

/** Forgets a pending authorisation after the bank reported an error or cancellation. */
export async function cancelBankAuthorization(database: AccountDatabase, userId: string, state: string, message: string): Promise<void> {
  await withUserLock(userId, async () => {
    const link = await readLink(database, userId);
    if (!link?.pending.some((entry) => entry.state === state)) return;
    await writeLink(database, userId, { ...link, pending: link.pending.filter((entry) => entry.state !== state), lastError: message.slice(0, 300) });
  });
}

export async function removeBankConnection(
  database: AccountDatabase,
  user: { id: string; username: string },
  connectionId: string,
  options: { enableBanking?: EnableBankingClient } = {},
): Promise<BankStatus> {
  return withUserLock(user.id, async () => {
    const link = await readLink(database, user.id);
    if (!link || !link.connections.some((connection) => connection.id === connectionId))
      throw new AccountError(404, "Bankverbindung nicht gefunden.");
    try {
      if (link.provider === "enablebanking") await (options.enableBanking ?? enableBankingClient()).deleteSession(connectionId);
      else if (link.token) await xs2aClient().deleteConnection(link.token.token, connectionId);
    } catch (error) {
      const gone = (error instanceof Xs2aError || error instanceof EnableBankingError) && (error.status === 404 || error.status === 422);
      if (!gone) bankError(error);
    }
    await writeLink(database, user.id, {
      ...link,
      connections: link.connections.filter((connection) => connection.id !== connectionId),
      accounts: link.accounts.filter((account) => account.connectionId !== connectionId),
      providerAccounts: link.providerAccounts.filter((account) => account.connectionId !== connectionId),
    });
    return bankStatus(database, user.id);
  });
}

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const CONSENT_MESSAGE = "Die Bank verlangt eine erneute Bestätigung. Bitte bei der Verbindung „Freigabe erneuern“ wählen.";

type SyncResult = { file: BankSyncFile; summaries: BankLink["accounts"]; connections: BankLink["connections"]; needsConsent: boolean };

async function collectXs2a(api: Xs2aClient, link: BankLink, range: { from: string; to: string }, covered: Map<string, string>, refresh: boolean, now: number): Promise<SyncResult> {
  const token = link.token!.token;
  let connections = await api.listConnections(token);
  let needsConsent = false;
  if (refresh) {
    const results = await Promise.allSettled(connections.filter((connection) => connection.sync_active !== false)
      .map((connection) => api.syncConnection(token, connection.id)));
    needsConsent = results.some((result) => result.status === "fulfilled" && result.value !== null);
    connections = await api.listConnections(token);
  }
  const accounts = await api.listAccounts(token);
  const file: BankSyncFile = { format: BANK_SYNC_FORMAT, version: 1, provider: "xs2a", fetchedAt: new Date(now).toISOString(), accounts: [] };
  const summaries: BankLink["accounts"] = [];
  for (const account of accounts) {
    const target = bankAccountTarget({ bankName: account.bank_name, bic: account.bic, description: account.description, iban: account.iban });
    const [turnovers, balance] = await Promise.all([
      api.turnovers(token, account.id, range.from, range.to),
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
  return { file, summaries, connections: connections.map(mapConnection), needsConsent };
}

const consentLost = (error: unknown) =>
  error instanceof EnableBankingError && (error.status === 401 || error.status === 403 || /expired|revoked|consent|session/i.test(`${error.code} ${error.message}`));

async function collectEnableBanking(api: EnableBankingClient, link: BankLink, range: { from: string; to: string }, covered: Map<string, string>, now: number): Promise<SyncResult> {
  const file: BankSyncFile = { format: BANK_SYNC_FORMAT, version: 1, provider: "enablebanking", fetchedAt: new Date(now).toISOString(), accounts: [] };
  const summaries: BankLink["accounts"] = [];
  const connections: BankLink["connections"] = [];
  let needsConsent = false;
  for (const connection of link.connections) {
    let active = true;
    let message: string | null = null;
    let validUntil = connection.consentValidUntil;
    try {
      const session = await api.session(connection.id);
      validUntil = session.access?.valid_until ?? validUntil;
      active = session.status === "AUTHORIZED" && (!validUntil || Date.parse(validUntil) > now);
      if (!active) message = session.status === "AUTHORIZED" ? "Freigabe abgelaufen" : `Status: ${session.status}`;
    } catch (error) {
      if (!consentLost(error) && !(error instanceof EnableBankingError && error.status === 404)) throw error;
      active = false;
      message = "Freigabe abgelaufen";
    }
    const accounts = link.providerAccounts.filter((account) => account.connectionId === connection.id);
    if (active) {
      for (const account of accounts) {
        const target = bankAccountTarget(account);
        let transactions;
        try {
          transactions = await api.transactions(account.id, range.from, range.to);
        } catch (error) {
          if (!consentLost(error)) throw error;
          active = false;
          message = "Freigabe abgelaufen";
          break;
        }
        const balance = pickBalances(await api.balances(account.id).catch(() => []));
        file.accounts.push({ ...account, coveredUntil: covered.get(accountIdentity(target)) ?? null, turnovers: transactions.map(toTurnover) });
        summaries.push({
          id: account.id,
          connectionId: connection.id,
          bank: target.bank,
          pocket: target.pocket,
          label: account.description || target.pocket || target.bank,
          iban: maskIban(account.iban),
          balance: balance.balance,
          available: balance.available,
          balanceDate: balance.date,
        });
      }
    }
    if (!active) {
      needsConsent = true;
      summaries.push(...link.accounts.filter((account) => account.connectionId === connection.id && !summaries.some((entry) => entry.id === account.id)));
    }
    connections.push({ ...connection, syncActive: active, message, consentValidUntil: validUntil, lastSynced: active ? new Date(now).toISOString() : connection.lastSynced });
  }
  return { file, summaries, connections, needsConsent };
}

/**
 * Fetches all connected accounts and queues their new bookings as a regular statement
 * import, so categorisation, duplicate checks and review run exactly as for CSV uploads.
 */
export async function syncBank(
  database: AccountDatabase,
  user: { id: string; username: string },
  options: { refresh?: boolean; now?: number; api?: Xs2aClient; enableBanking?: EnableBankingClient } = {},
): Promise<BankStatus & { queued: boolean; rows: number }> {
  const now = options.now ?? Date.now();
  return withUserLock(user.id, async () => {
    const stored = await readLink(database, user.id);
    const linked = stored && (stored.provider === "enablebanking" ? stored.connections.length > 0 : !!stored.bankUserId);
    if (!stored || !linked) throw new AccountError(409, "Noch keine Bank verbunden.");
    let link = stored;
    try {
      const range = { from: isoDay(link.lastSync ? link.lastSync - OVERLAP_DAYS * DAY : now - FIRST_SYNC_DAYS * DAY), to: isoDay(now) };
      const covered = coveredUntilByAccount(database.getFinance(user.id).state?.transactions ?? []);
      let result: SyncResult;
      if (link.provider === "enablebanking") {
        result = await collectEnableBanking(options.enableBanking ?? enableBankingClient(), link, range, covered, now);
      } else {
        const api = options.api ?? xs2aClient();
        link = await ensureToken(api, database, user, stored, now);
        result = await collectXs2a(api, link, range, covered, !!options.refresh, now);
      }
      const count = result.file.accounts.reduce((sum, account) => sum + account.turnovers.length, 0);
      const queued = count > 0 && await enqueue(database, user.id, result.file, now);
      link = { ...link, connections: result.connections, accounts: result.summaries, lastSync: now, lastSyncRows: count,
        lastError: result.needsConsent ? CONSENT_MESSAGE : null };
      await writeLink(database, user.id, link);
      return { ...(await bankStatus(database, user.id)), queued, rows: count };
    } catch (error) {
      const message = error instanceof Xs2aError || error instanceof EnableBankingError || error instanceof AccountError ? error.message : "Bankabruf fehlgeschlagen.";
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
  if (!link?.connections.length) return false;
  if (link.provider === "enablebanking" && !link.connections.some((connection) => connection.syncActive !== false)) return false;
  return !link.lastSync || now - link.lastSync >= AUTO_SYNC_INTERVAL_MS;
}
