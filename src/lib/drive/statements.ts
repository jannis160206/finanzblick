import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { AutomationStore } from "@/lib/automation/store";
import type { AccountDatabase } from "@/lib/server/database";

/** Hands a downloaded statement to the same queue as a manual upload; the worker parses, categorizes and deduplicates it. */
export async function enqueueStatement(database: AccountDatabase, userId: string, name: string, bytes: Buffer, now = Date.now()): Promise<string> {
  const store = new AutomationStore(database);
  const id = randomUUID();
  store.reserveUpload(userId, id, name, bytes.byteLength, now);
  const path = store.filePath(id);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("Upload directory must not be a symlink");
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    store.readyUpload(userId, id);
    return id;
  } catch (error) {
    if (store.failUpload(userId, id)) {
      await unlink(path).catch(() => undefined);
      store.cleaned(id);
    }
    throw error;
  }
}
