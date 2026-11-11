import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { appendPayslipLog, readPayslipLog, type PayslipLogEntry } from "@/lib/payslip-log";

type Host = { path: string };

const locks = new Map<string, Promise<unknown>>();
async function withLogLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  locks.set(userId, next);
  try { return await next; } finally { if (locks.get(userId) === next) locks.delete(userId); }
}

function logPath(host: Host, userId: string) {
  z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(userId);
  return join(dirname(host.path), "payslip-logs", `${userId}.json`);
}

/** The import log of one user, oldest first; a missing or damaged file is an empty log. */
export async function readPayslipLogFile(host: Host, userId: string): Promise<PayslipLogEntry[]> {
  try {
    return readPayslipLog(JSON.parse(await readFile(logPath(host, userId), "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeLog(host: Host, userId: string, log: PayslipLogEntry[]) {
  const path = logPath(host, userId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("Payslip log directory must not be a symlink");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(log));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function appendPayslipLogFile(host: Host, userId: string, entry: PayslipLogEntry): Promise<void> {
  await withLogLock(userId, async () => writeLog(host, userId, appendPayslipLog(await readPayslipLogFile(host, userId), entry)));
}

export async function clearPayslipLogFile(host: Host, userId: string): Promise<void> {
  await withLogLock(userId, () => rm(logPath(host, userId), { force: true }));
}
