import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AccountError, isAccountError } from "@/lib/server/errors";
import type { AccountDatabase } from "@/lib/server/database";
import { readAccountConfig } from "@/lib/server/config";
import { downloadFile, findFolders, listFolderFiles, type DriveFile } from "./client";
import { addInboxItem, listInbox } from "./inbox";
import { DriveAuthError, driveOAuthConfig, type DriveOAuthConfig, type Fetcher } from "./oauth";
import { DRIVE_FOLDER_NAMES } from "./folders";
import { enqueueStatement } from "./statements";
import { driveAccessToken, driveFolderKinds, driveStatus, forgetAccessToken, markDriveLink, readDriveLink, type DriveFolderKind, type DriveLink, type DriveProcessed, type DriveStatus } from "./store";

const ACCEPTED: Record<DriveFolderKind, RegExp> = { amex: /\.(pdf|csv|xlsx)$/i, payslips: /\.pdf$/i };
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAYSLIPS_PER_RUN = 48;
const MAX_STATEMENTS_PER_RUN = 4;
const AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;
/** Download or queue errors are retried on later checks; outcomes reported by the browser are final until "retry". */
const MAX_ATTEMPTS = 3;

export type DriveFolderResult = { name: string; found: boolean; total: number; added: number; failed: number };
export type DriveSyncResult = { folders: Record<DriveFolderKind, DriveFolderResult>; backlog: boolean; notes: string[] };
type Dependencies = { fetcher?: Fetcher; enqueue?: typeof enqueueStatement; now?: number };

const fingerprint = (file: Pick<DriveFile, "md5Checksum" | "modifiedTime">) => file.md5Checksum ?? file.modifiedTime ?? "";
const known = (entry: DriveProcessed | undefined, file: DriveFile) =>
  !!entry && (entry.md5 ?? entry.modified ?? "") === fingerprint(file) && (entry.outcome !== "failed" || (entry.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS);

/** Statement worker hint: files from the AMEX folder are named so the queue recognizes them as Amex. */
const statementName = (name: string) => (/amex|american express/i.test(name) ? name : `AMEX ${name}`).slice(0, 200).replace(/[\x00-\x1f]/g, " ");

/**
 * Looks for new files in "AMEX Abrechnungen" (bookings, server statement queue) and "Abrechnungen" (payslips, browser inbox).
 * Already handled files (same Drive id and checksum) are skipped; changed files run again and rely on the regular duplicate checks.
 */
export async function syncDrive(database: AccountDatabase, userId: string, oauth: DriveOAuthConfig, dependencies: Dependencies = {}): Promise<DriveSyncResult> {
  try {
    return await syncOnce(database, userId, oauth, dependencies);
  } catch (error) {
    if (!(error instanceof DriveAuthError && error.kind === "expired")) throw error;
    const link = await readDriveLink(database, userId);
    if (!link || link.expired) throw error;
    await forgetAccessToken(database, userId);
    try {
      return await syncOnce(database, userId, oauth, dependencies);
    } catch (retry) {
      if (retry instanceof DriveAuthError && retry.kind === "expired")
        await markDriveLink(database, userId, (link) => ({ ...link, expired: true, lastError: retry.message })).catch(() => null);
      throw retry;
    }
  }
}

async function syncOnce(database: AccountDatabase, userId: string, oauth: DriveOAuthConfig, dependencies: Dependencies): Promise<DriveSyncResult> {
  const { fetcher = fetch, enqueue = enqueueStatement, now = Date.now() } = dependencies;
  const link = await readDriveLink(database, userId);
  if (!link) throw new DriveAuthError("Google Drive ist nicht verbunden.", "expired");
  try {
    const token = await driveAccessToken(database, userId, oauth, fetcher, now);
    const processed = new Map((link.processed ?? []).map((entry) => [entry.id, entry]));
    const result: DriveSyncResult = {
      folders: Object.fromEntries(driveFolderKinds.map((kind) => [kind, { name: DRIVE_FOLDER_NAMES[kind], found: false, total: 0, added: 0, failed: 0 }])) as DriveSyncResult["folders"],
      backlog: false,
      notes: [],
    };
    const folders: NonNullable<DriveLink["folders"]> = {};
    for (const kind of driveFolderKinds) {
      const summary = result.folders[kind];
      const candidates = await findFolders(token, DRIVE_FOLDER_NAMES[kind], fetcher);
      if (!candidates.length) { result.notes.push(`Ordner „${summary.name}“ nicht gefunden.`); continue; }
      const previous = link.folders?.[kind];
      const pinned = previous?.pinned ? candidates.find((candidate) => candidate.id === previous.id) : undefined;
      if (candidates.length > 1 && !pinned) result.notes.push(`Mehrere Ordner „${summary.name}“ – bitte einen wählen. Bis dahin wird der zuletzt geänderte gelesen.`);
      const folder = pinned ?? candidates[0];
      summary.found = true;
      const files = (await listFolderFiles(token, folder.id, fetcher)).filter((file) => ACCEPTED[kind].test(file.name));
      summary.total = files.length;
      folders[kind] = {
        id: folder.id, name: folder.name.slice(0, 200), lastCount: files.length,
        ...(pinned ? { pinned: true } : {}),
        ...(candidates.length > 1 ? { choices: candidates.slice(0, 10).map(({ id, name, modifiedTime }) => ({ id, name: name.slice(0, 200), ...(modifiedTime ? { modified: modifiedTime } : {}) })) } : {}),
      };
      let handled = 0;
      for (const file of files) {
        if (known(processed.get(file.id), file)) continue;
        const earlier = processed.get(file.id);
        const record = (outcome: DriveProcessed["outcome"], note?: string, final = false) => processed.set(file.id, {
          id: file.id, kind, name: file.name.slice(0, 300), at: now, outcome,
          ...(file.md5Checksum ? { md5: file.md5Checksum } : {}), ...(file.modifiedTime ? { modified: file.modifiedTime } : {}),
          ...(note ? { note: note.slice(0, 300) } : {}),
          ...(outcome === "failed" ? { attempts: final ? MAX_ATTEMPTS : earlier?.outcome === "failed" && fingerprint(file) === (earlier.md5 ?? earlier.modified ?? "") ? Math.min((earlier.attempts ?? 0) + 1, 100) : 1 } : {}),
        });
        if ((file.size ?? 0) > MAX_BYTES) { record("failed", "Größer als 20 MB.", true); summary.failed++; continue; }
        if (handled >= (kind === "amex" ? MAX_STATEMENTS_PER_RUN : MAX_PAYSLIPS_PER_RUN)) { result.backlog = true; break; }
        try {
          const bytes = await downloadFile(token, file.id, MAX_BYTES, fetcher);
          if (kind === "amex") {
            await enqueue(database, userId, statementName(file.name), bytes, now);
            record("queued");
          } else {
            await addInboxItem(database, userId, { id: file.id, name: file.name.slice(0, 300), size: bytes.byteLength }, bytes, now);
            record("inbox");
          }
          handled++;
          summary.added++;
        } catch (error) {
          if (error instanceof DriveAuthError) throw error;
          if (isAccountError(error) && (error.status === 429 || error.status === 503)) { result.backlog = true; break; }
          record("failed", error instanceof Error ? error.message : "Unbekannter Fehler.");
          summary.failed++;
        }
      }
    }
    await markDriveLink(database, userId, (current) => ({
      ...current, lastError: undefined, expired: undefined, lastSync: now, backlog: result.backlog, folders,
      notes: result.notes.slice(0, 10).map((note) => note.slice(0, 300)),
      processed: [...processed.values()].sort((a, b) => a.at - b.at).slice(-5000),
    }));
    return result;
  } catch (error) {
    if (!(error instanceof DriveAuthError && error.kind === "expired"))
      await markDriveLink(database, userId, (current) => ({ ...current, lastSync: now, lastError: error instanceof Error ? error.message.slice(0, 500) : "Unbekannter Fehler." })).catch(() => null);
    throw error;
  }
}

export async function driveOverview(database: AccountDatabase, userId: string, oauth: DriveOAuthConfig | null): Promise<DriveStatus> {
  const status = await driveStatus(database, userId, oauth);
  if (!status.connected) return status;
  return { ...status, inbox: (await listInbox(database, userId)).length };
}

/** Remembers which of several same-named folders to read. */
export async function chooseDriveFolder(database: AccountDatabase, userId: string, kind: DriveFolderKind, folderId: string) {
  const link = await markDriveLink(database, userId, (current) => {
    const folder = current.folders?.[kind];
    const choice = folder?.choices?.find((entry) => entry.id === folderId);
    if (!folder || !choice) throw new AccountError(400, "Dieser Ordner steht nicht zur Auswahl.");
    return { ...current, folders: { ...current.folders, [kind]: { ...folder, id: choice.id, name: choice.name, pinned: true } } };
  });
  if (!link) throw new AccountError(409, "Google Drive ist nicht verbunden.");
}

/** Lets skipped or failed files be fetched again on the next check (e.g. after storing the PDF password). */
export async function retryDriveFiles(database: AccountDatabase, userId: string) {
  return markDriveLink(database, userId, (link) => ({
    ...link,
    processed: (link.processed ?? []).filter((entry) => entry.outcome !== "skipped" && entry.outcome !== "failed"),
  }));
}

/** The browser reports what became of an inbox payslip. */
export async function recordInboxOutcome(database: AccountDatabase, userId: string, id: string, outcome: "imported" | "skipped" | "failed", note?: string) {
  return markDriveLink(database, userId, (link) => ({
    ...link,
    processed: (link.processed ?? []).map((entry) => entry.id === id ? { ...entry, outcome, ...(note ? { note: note.slice(0, 300) } : {}) } : entry),
  }));
}

export async function linkedDriveUsers(database: AccountDatabase): Promise<string[]> {
  try {
    return (await readdir(join(dirname(database.path), "drive-links")))
      .filter((name) => /^[A-Za-z0-9_-]{1,100}\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function driveSyncDue(link: DriveLink | null, now = Date.now()) {
  return !!link && !link.expired && (!!link.backlog || !link.lastSync || now - link.lastSync >= AUTO_SYNC_INTERVAL_MS);
}

const CHECK_MS = 15 * 60 * 1000;

/** Checks the Drive folders in the background (hourly per user, sooner while a backlog remains) while the statement worker runs. */
export function startDriveAutoSync(database: AccountDatabase, signal: AbortSignal): void {
  let origin: string;
  try {
    origin = readAccountConfig().origin ?? "http://localhost";
  } catch {
    return;
  }
  const oauth = driveOAuthConfig(origin);
  if (!oauth) return;
  let running = false;
  const tick = async () => {
    if (running || signal.aborted) return;
    running = true;
    try {
      for (const userId of await linkedDriveUsers(database)) {
        if (signal.aborted) break;
        if (!driveSyncDue(await readDriveLink(database, userId))) continue;
        try {
          const result = await syncDrive(database, userId, oauth);
          const added = driveFolderKinds.reduce((sum, kind) => sum + result.folders[kind].added, 0);
          console.info(`Google Drive: ${added} neue Datei(en) übernommen${result.backlog ? ", weitere folgen" : ""}.`);
        } catch (error) {
          console.warn("Google Drive: Abruf fehlgeschlagen:", error instanceof Error ? error.message : "unbekannt");
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), CHECK_MS);
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  setTimeout(() => void tick(), 45_000).unref();
}
