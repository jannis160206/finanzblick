import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { withDriveLock } from "./store";

type Host = { path: string };

const fileId = z.string().regex(/^[A-Za-z0-9_-]{6,200}$/);
const itemSchema = z.object({ id: fileId, name: z.string().max(300), size: z.number().int().nonnegative(), addedAt: z.number().int().nonnegative() });
const indexSchema = z.object({ version: z.literal(1), items: z.array(itemSchema).max(500) });
export type DriveInboxItem = z.infer<typeof itemSchema>;

function directory(host: Host, userId: string) {
  z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(userId);
  return join(dirname(host.path), "drive-inbox", userId);
}

async function writePrivate(path: string, bytes: Buffer | string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("Drive inbox must not be a symlink");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function readIndex(host: Host, userId: string): Promise<DriveInboxItem[]> {
  try {
    const parsed = indexSchema.safeParse(JSON.parse(await readFile(join(directory(host, userId), "index.json"), "utf8")));
    return parsed.success ? parsed.data.items : [];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

const writeIndex = (host: Host, userId: string, items: DriveInboxItem[]) =>
  writePrivate(join(directory(host, userId), "index.json"), JSON.stringify(indexSchema.parse({ version: 1, items })));

/** Payslips downloaded from Drive wait here until the browser reads them with the regular payslip import. */
export async function addInboxItem(host: Host, userId: string, item: Omit<DriveInboxItem, "addedAt">, bytes: Buffer, now = Date.now()) {
  fileId.parse(item.id);
  await withDriveLock(`inbox:${userId}`, async () => {
    await writePrivate(join(directory(host, userId), `${item.id}.pdf`), bytes);
    const items = (await readIndex(host, userId)).filter((entry) => entry.id !== item.id);
    await writeIndex(host, userId, [...items, { ...item, addedAt: now }].slice(-500));
  });
}

export const listInbox = (host: Host, userId: string) => readIndex(host, userId);

export async function readInboxFile(host: Host, userId: string, id: string): Promise<{ item: DriveInboxItem; bytes: Buffer } | null> {
  fileId.parse(id);
  const item = (await readIndex(host, userId)).find((entry) => entry.id === id);
  if (!item) return null;
  try {
    return { item, bytes: await readFile(join(directory(host, userId), `${id}.pdf`)) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function removeInboxItem(host: Host, userId: string, id: string): Promise<boolean> {
  fileId.parse(id);
  return withDriveLock(`inbox:${userId}`, async () => {
    const items = await readIndex(host, userId);
    const next = items.filter((entry) => entry.id !== id);
    await rm(join(directory(host, userId), `${id}.pdf`), { force: true });
    if (next.length === items.length) return false;
    await writeIndex(host, userId, next);
    return true;
  });
}

export async function clearInbox(host: Host, userId: string) {
  await withDriveLock(`inbox:${userId}`, () => rm(directory(host, userId), { recursive: true, force: true }));
}
