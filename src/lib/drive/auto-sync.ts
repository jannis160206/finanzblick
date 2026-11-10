import type { AccountDatabase } from "@/lib/server/database";
import { readAccountConfig } from "@/lib/server/config";
import { DriveAuthError, driveOAuthConfig } from "./oauth";
import { processDriveInbox } from "./payslips";
import { driveFolderKinds, readDriveLink } from "./store";
import { driveSyncDue, linkedDriveUsers, syncDrive } from "./sync";

// Statement worker only: spawns the payslip parser process, so it must never be imported by a route.

async function importWaitingPayslips(database: AccountDatabase, userId: string, signal: AbortSignal) {
  try {
    const run = await processDriveInbox(database, userId, { signal });
    if (run.imported || run.failed || run.skipped)
      console.info(`Google Drive: ${run.imported} Lohnzettel im Hintergrund übernommen${run.failed ? `, ${run.failed} fehlgeschlagen` : ""}${run.waiting ? `, ${run.waiting} warten auf Passwort oder Bestätigung` : ""}.`);
  } catch (error) {
    console.warn("Google Drive: Lohnzettel konnten nicht eingelesen werden:", error instanceof Error ? error.message : "unbekannt");
  }
}

const CHECK_MS = 5 * 60 * 1000;

/**
 * Checks the Drive folders in the background (hourly per user, sooner while a backlog remains) and imports waiting
 * payslips every few minutes while the statement worker runs.
 */
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
        await importWaitingPayslips(database, userId, signal);
        if (!driveSyncDue(await readDriveLink(database, userId))) continue;
        try {
          const result = await syncDrive(database, userId, oauth);
          const added = driveFolderKinds.reduce((sum, kind) => sum + result.folders[kind].added, 0);
          const failed = driveFolderKinds.reduce((sum, kind) => sum + result.folders[kind].failed, 0);
          if (added || failed || result.backlog)
            console.info(`Google Drive: ${added} neue Datei(en) übernommen${failed ? `, ${failed} fehlgeschlagen` : ""}${result.backlog ? ", weitere folgen" : ""}.`);
          if (result.folders.payslips.added) await importWaitingPayslips(database, userId, signal);
        } catch (error) {
          // Messages only, never file names or tokens.
          if (error instanceof DriveAuthError && error.kind === "expired")
            console.warn("Google Drive: Freigabe abgelaufen – in den Einstellungen erneut verbinden.");
          else console.warn("Google Drive: Abruf fehlgeschlagen:", error instanceof Error ? error.message : "unbekannt");
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
