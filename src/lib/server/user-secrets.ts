import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { masterKey, openSecret, sealSecret } from "./secrets";

export type SecretName = "payslip-password" | "google-drive";
type SecretHost = { path: string };

const storeSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.object({ value: z.string().max(20_000), updatedAt: z.number().int().nonnegative() })),
});
type SecretStore = z.infer<typeof storeSchema>;

const locks = new Map<string, Promise<unknown>>();
async function withUserLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(userId, next);
  try { return await next; } finally { if (locks.get(userId) === next) locks.delete(userId); }
}

const dataDirectory = (host: SecretHost) => dirname(host.path);
function storePath(host: SecretHost, userId: string) {
  z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(userId);
  return join(dataDirectory(host), "secrets", `${userId}.json`);
}
const context = (userId: string, name: SecretName) => `finanzblick:${userId}:${name}`;

async function readStore(host: SecretHost, userId: string): Promise<SecretStore> {
  try {
    const parsed = storeSchema.safeParse(JSON.parse(await readFile(storePath(host, userId), "utf8")));
    return parsed.success ? parsed.data : { version: 1, entries: {} };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, entries: {} };
    throw error;
  }
}

async function writeStore(host: SecretHost, userId: string, store: SecretStore): Promise<void> {
  const path = storePath(host, userId);
  if (!Object.keys(store.entries).length) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("Secret directory must not be a symlink");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(storeSchema.parse(store)));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function userSecretInfo(host: SecretHost, userId: string, name: SecretName): Promise<{ updatedAt: number } | null> {
  const entry = (await readStore(host, userId)).entries[name];
  return entry ? { updatedAt: entry.updatedAt } : null;
}

export async function readUserSecret(host: SecretHost, userId: string, name: SecretName): Promise<string | null> {
  const entry = (await readStore(host, userId)).entries[name];
  if (!entry) return null;
  return openSecret(entry.value, await masterKey(dataDirectory(host)), context(userId, name));
}

export async function writeUserSecret(host: SecretHost, userId: string, name: SecretName, value: string, now = Date.now()): Promise<{ updatedAt: number }> {
  const key = await masterKey(dataDirectory(host));
  return withUserLock(userId, async () => {
    const store = await readStore(host, userId);
    store.entries[name] = { value: sealSecret(value, key, context(userId, name)), updatedAt: now };
    await writeStore(host, userId, store);
    return { updatedAt: now };
  });
}

export async function deleteUserSecret(host: SecretHost, userId: string, name: SecretName): Promise<void> {
  await withUserLock(userId, async () => {
    const store = await readStore(host, userId);
    if (!(name in store.entries)) return;
    delete store.entries[name];
    await writeStore(host, userId, store);
  });
}
