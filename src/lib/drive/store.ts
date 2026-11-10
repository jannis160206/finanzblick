import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { deleteUserSecret, readUserSecret, writeUserSecret } from "@/lib/server/user-secrets";
import { DriveAuthError, refreshAccessToken, revokeToken, type DriveOAuthConfig, type DriveTokens, type Fetcher } from "./oauth";

type Host = { path: string };

export const driveFolderKinds = ["amex", "payslips"] as const;
export type DriveFolderKind = (typeof driveFolderKinds)[number];

const folderChoiceSchema = z.object({ id: z.string().max(200), name: z.string().max(200), modified: z.string().max(40).optional() });
const folderSchema = z.object({
  id: z.string().max(200),
  name: z.string().max(200),
  lastCount: z.number().int().nonnegative().optional(),
  /** Chosen by the user among several folders with the same name. */
  pinned: z.boolean().optional(),
  choices: z.array(folderChoiceSchema).max(10).optional(),
});
export type DriveFolderChoice = z.infer<typeof folderChoiceSchema>;
const processedSchema = z.object({
  id: z.string().max(200),
  kind: z.enum(driveFolderKinds),
  name: z.string().max(300),
  md5: z.string().max(64).optional(),
  modified: z.string().max(40).optional(),
  at: z.number().int().nonnegative(),
  outcome: z.enum(["queued", "inbox", "imported", "skipped", "failed"]),
  note: z.string().max(300).optional(),
  attempts: z.number().int().nonnegative().max(100).optional(),
});
export type DriveProcessed = z.infer<typeof processedSchema>;

const linkSchema = z.object({
  version: z.literal(1),
  connectedAt: z.number().int().nonnegative(),
  account: z.object({ email: z.string().max(320).optional(), name: z.string().max(200).optional() }).optional(),
  expired: z.boolean().optional(),
  lastSync: z.number().int().nonnegative().optional(),
  lastError: z.string().max(500).optional(),
  backlog: z.boolean().optional(),
  notes: z.array(z.string().max(300)).max(10).optional(),
  folders: z.object({ amex: folderSchema.optional(), payslips: folderSchema.optional() }).optional(),
  processed: z.array(processedSchema).max(5000).optional(),
});
export type DriveLink = z.infer<typeof linkSchema>;

const tokenSchema = z.object({
  refreshToken: z.string().min(1).max(4096),
  accessToken: z.string().max(4096).optional(),
  accessExpiresAt: z.number().int().nonnegative().optional(),
});

const locks = new Map<string, Promise<unknown>>();
export async function withDriveLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(userId, next);
  try { return await next; } finally { if (locks.get(userId) === next) locks.delete(userId); }
}

function linkPath(host: Host, userId: string) {
  z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(userId);
  return join(dirname(host.path), "drive-links", `${userId}.json`);
}

export async function readDriveLink(host: Host, userId: string): Promise<DriveLink | null> {
  try {
    const parsed = linkSchema.safeParse(JSON.parse(await readFile(linkPath(host, userId), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeDriveLink(host: Host, userId: string, link: DriveLink): Promise<void> {
  const path = linkPath(host, userId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("Drive link directory must not be a symlink");
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

async function readTokens(host: Host, userId: string) {
  const raw = await readUserSecret(host, userId, "google-drive");
  if (!raw) return null;
  const parsed = tokenSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

const writeTokens = (host: Host, userId: string, tokens: z.infer<typeof tokenSchema>) =>
  writeUserSecret(host, userId, "google-drive", JSON.stringify(tokenSchema.parse(tokens)));

export async function saveDriveConnection(host: Host, userId: string, tokens: DriveTokens, account: { email?: string; name?: string }, now = Date.now()) {
  await withDriveLock(userId, async () => {
    const previous = await readDriveLink(host, userId);
    await writeTokens(host, userId, tokens);
    await writeDriveLink(host, userId, {
      version: 1, connectedAt: now, account,
      ...(previous?.folders ? { folders: previous.folders } : {}),
      ...(previous?.processed ? { processed: previous.processed } : {}),
      ...(previous?.lastSync ? { lastSync: previous.lastSync } : {}),
    });
  });
}

export async function disconnectDrive(host: Host, userId: string, fetcher: Fetcher = fetch): Promise<void> {
  await withDriveLock(userId, async () => {
    const tokens = await readTokens(host, userId).catch(() => null);
    if (tokens) await revokeToken(tokens.refreshToken, fetcher);
    await deleteUserSecret(host, userId, "google-drive");
    await rm(linkPath(host, userId), { force: true });
  });
}

export async function markDriveLink(host: Host, userId: string, change: (link: DriveLink) => DriveLink): Promise<DriveLink | null> {
  return withDriveLock(userId, async () => {
    const link = await readDriveLink(host, userId);
    if (!link) return null;
    const next = change(link);
    await writeDriveLink(host, userId, next);
    return next;
  });
}

/** Drops an access token that Google rejected, so the next request refreshes it. */
export async function forgetAccessToken(host: Host, userId: string): Promise<void> {
  await withDriveLock(userId, async () => {
    const tokens = await readTokens(host, userId);
    if (tokens) await writeTokens(host, userId, { refreshToken: tokens.refreshToken });
  });
}

/** A valid access token, refreshed shortly before expiry; an expired refresh token marks the connection as expired. */
export async function driveAccessToken(host: Host, userId: string, config: DriveOAuthConfig, fetcher: Fetcher = fetch, now = Date.now()): Promise<string> {
  const tokens = await readTokens(host, userId);
  if (!tokens) throw new DriveAuthError("Google Drive ist nicht verbunden.", "expired");
  if (tokens.accessToken && tokens.accessExpiresAt && tokens.accessExpiresAt - 60_000 > now) return tokens.accessToken;
  try {
    const fresh = await refreshAccessToken(config, tokens.refreshToken, fetcher, now);
    await writeTokens(host, userId, { ...tokens, ...fresh });
    return fresh.accessToken;
  } catch (error) {
    if (error instanceof DriveAuthError && error.kind === "expired")
      await markDriveLink(host, userId, (link) => ({ ...link, expired: true, lastError: error.message }));
    throw error;
  }
}

export type DriveStatus = {
  configured: boolean;
  redirectUri?: string;
  connected: boolean;
  expired?: boolean;
  email?: string;
  name?: string;
  connectedAt?: number;
  lastSync?: number;
  lastError?: string;
  folders?: Partial<Record<DriveFolderKind, z.infer<typeof folderSchema>>>;
  notes?: string[];
  recent?: Omit<DriveProcessed, "id" | "md5" | "modified">[];
  backlog?: boolean;
  /** Payslips waiting for the browser to read them. */
  inbox?: number;
  /** Files that were skipped or failed and can be fetched again. */
  retryable?: number;
};

export async function driveStatus(host: Host, userId: string, config: DriveOAuthConfig | null): Promise<DriveStatus> {
  const link = await readDriveLink(host, userId);
  const base = { configured: !!config, ...(config ? { redirectUri: config.redirectUri } : {}) };
  if (!link) return { ...base, connected: false };
  return {
    ...base,
    connected: true,
    ...(link.expired ? { expired: true } : {}),
    ...link.account,
    connectedAt: link.connectedAt,
    ...(link.lastSync ? { lastSync: link.lastSync } : {}),
    ...(link.lastError ? { lastError: link.lastError } : {}),
    ...(link.backlog ? { backlog: true } : {}),
    retryable: (link.processed ?? []).filter((entry) => entry.outcome === "skipped" || entry.outcome === "failed").length,
    ...(link.folders ? { folders: link.folders } : {}),
    ...(link.notes?.length ? { notes: link.notes } : {}),
    recent: (link.processed ?? []).slice(-8).reverse().map(({ kind, name, at, outcome, note }) => ({ kind, name, at, outcome, ...(note ? { note } : {}) })),
  };
}
