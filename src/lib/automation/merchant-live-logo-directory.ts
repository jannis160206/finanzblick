import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AutomationStore } from "./store";
import {
  logoAccountIdSchema,
  logoRightsReferenceSchema,
} from "./merchant-logo-grant-metadata";
import { importSuppliedLocalLogos } from "./merchant-local-logos";
import { readBoundedLogoFile } from "./merchant-logo-raster";

export const LIVE_LOGO_USAGE_FILE = ".private-usage.json";
const IMAGE_FILE = /\.(?:png|jpe?g|webp|avif)$/i;
const CHECK_INTERVAL_MS = 2_000;
const MAX_USAGE_FILE_BYTES = 64 * 1024;
const MAX_SIGNATURE_FILES = 200;

const usageSchema = z.object({
  accounts: z
    .array(
      z.object({
        userId: logoAccountIdSchema,
        rightsReference: logoRightsReferenceSchema,
      }),
    )
    .max(100),
});

type AccountState = {
  signature?: string;
  checkedAt: number;
  running?: Promise<void>;
};
const states = new WeakMap<object, Map<string, AccountState>>();

export function liveLogoDirectory() {
  return resolve(process.env.FINANZBLICK_LOGO_DIR || join(process.cwd(), "Logo"));
}

function isMissing(error: unknown) {
  return (
    error instanceof Error && "code" in error && error.code === "ENOENT"
  );
}

async function rightsReferenceFor(directory: string, userId: string) {
  let bytes: Buffer;
  try {
    bytes = await readBoundedLogoFile(
      join(directory, LIVE_LOGO_USAGE_FILE),
      MAX_USAGE_FILE_BYTES,
    );
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const usage = usageSchema.parse(JSON.parse(bytes.toString("utf8")));
  return usage.accounts.find((account) => account.userId === userId)
    ?.rightsReference;
}

async function directorySignature(directory: string) {
  const files: { name: string; signature: string }[] = [];
  let handle;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  for await (const entry of handle) {
    if (!IMAGE_FILE.test(entry.name) || !entry.isFile()) continue;
    if (files.length >= MAX_SIGNATURE_FILES) break;
    const stats = await lstat(join(directory, entry.name));
    files.push({
      name: entry.name,
      signature: `${entry.name}|${stats.size}|${Math.trunc(stats.mtimeMs)}`,
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    names: files.map((file) => file.name),
    hash: createHash("sha256")
      .update(files.map((file) => file.signature).join("\n"))
      .digest("hex"),
  };
}

async function importChanged(
  store: AutomationStore,
  userId: string,
  directory: string,
  rightsReference: string,
  names: string[],
) {
  try {
    await importSuppliedLocalLogos(store, {
      userId,
      directory,
      rightsReference,
      signal: AbortSignal.timeout(120_000),
    });
    return;
  } catch (error) {
    console.error(
      "Live logo folder import failed, retrying file by file:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
  // One unreadable or conflicting file must not hide every other logo.
  for (const name of names) {
    try {
      await importSuppliedLocalLogos(store, {
        userId,
        directory,
        rightsReference,
        files: new Set([name]),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      console.error(
        `Live logo skipped (${name}):`,
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }
}

async function synchronize(
  store: AutomationStore,
  userId: string,
  state: AccountState,
) {
  const directory = liveLogoDirectory();
  const rightsReference = await rightsReferenceFor(directory, userId);
  if (!rightsReference) return;
  const current = await directorySignature(directory);
  if (!current || current.hash === state.signature) return;
  if (current.names.length)
    await importChanged(store, userId, directory, rightsReference, current.names);
  state.signature = current.hash;
}

/**
 * Keeps the account's private logo grants in step with the local logo folder.
 * Cheap enough to call per request: a throttled directory listing decides
 * whether anything changed. Failures are logged and never block the caller.
 */
export async function syncLiveLogoDirectory(
  store: AutomationStore,
  userId: string,
  now = Date.now(),
) {
  logoAccountIdSchema.parse(userId);
  const accounts = states.get(store.accounts) ?? new Map<string, AccountState>();
  states.set(store.accounts, accounts);
  const state = accounts.get(userId) ?? { checkedAt: 0 };
  accounts.set(userId, state);
  if (state.running) return state.running;
  if (now - state.checkedAt < CHECK_INTERVAL_MS) return;
  state.checkedAt = now;
  state.running = synchronize(store, userId, state)
    .catch((error: unknown) => {
      console.error(
        "Live logo folder check failed:",
        error instanceof Error ? error.message : "unknown error",
      );
    })
    .finally(() => {
      state.running = undefined;
    });
  return state.running;
}
