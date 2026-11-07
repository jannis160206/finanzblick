import type { AccountDatabase } from "@/lib/server/database";
import { autoSyncDue, configuredBankProvider, linkedBankUsers, syncBank } from "./sync";

const CHECK_MS = 15 * 60 * 1000;

/** Fetches new bank bookings in the background (every 6 h per user) while the statement worker runs. */
export function startBankAutoSync(database: AccountDatabase, signal: AbortSignal): void {
  if (!configuredBankProvider()) return;
  let running = false;
  const tick = async () => {
    if (running || signal.aborted) return;
    running = true;
    try {
      for (const userId of await linkedBankUsers(database)) {
        if (signal.aborted) break;
        if (!(await autoSyncDue(database, userId))) continue;
        try {
          const result = await syncBank(database, { id: userId, username: "" });
          console.info(`Bankabruf: ${result.rows} Umsätze geladen${result.queued ? " und eingereiht" : ""}.`);
        } catch (error) {
          console.warn("Bankabruf fehlgeschlagen:", error instanceof Error ? error.message : "unbekannt");
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), CHECK_MS);
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  setTimeout(() => void tick(), 30_000).unref();
}
