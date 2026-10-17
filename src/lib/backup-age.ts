// Nur das Datum der letzten Excel-Sicherung, ausschließlich lokal im Browser. Keine Serverübertragung.
export const BACKUP_STALE_AFTER_DAYS = 30;
const KEY_PREFIX = "finanzdashboard.last-excel-backup.v1";
const CHANGE_EVENT = "finanzblick:backup-recorded";
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export type BackupStatus =
  | { kind: "none" }
  | { kind: "recent"; days: number }
  | { kind: "stale"; days: number };

const storageKey = (scope: string) => `${KEY_PREFIX}:${scope}`;

export function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayNumber(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function backupStatus(lastBackup: string | null, today: string, staleAfterDays = BACKUP_STALE_AFTER_DAYS): BackupStatus {
  if (!lastBackup || !datePattern.test(lastBackup) || !datePattern.test(today)) return { kind: "none" };
  const days = Math.max(0, dayNumber(today) - dayNumber(lastBackup));
  return days >= staleAfterDays ? { kind: "stale", days } : { kind: "recent", days };
}

export function readLastBackup(scope: string, storage: Pick<Storage, "getItem"> = localStorage): string | null {
  try {
    const value = storage.getItem(storageKey(scope));
    return value && datePattern.test(value) ? value : null;
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

/** Gibt false zurück, wenn der Browser das Speichern verweigert; der Export selbst bleibt davon unberührt. */
export function recordBackup(scope: string, date = localDateKey(), storage: Pick<Storage, "setItem"> = localStorage): boolean {
  try {
    storage.setItem(storageKey(scope), date);
  } catch (error) {
    if (error instanceof DOMException) return false;
    throw error;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return true;
}

export function subscribeBackup(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function backupAgeText(days: number): string {
  if (days === 0) return "heute";
  if (days === 1) return "gestern";
  return `vor ${days} Tagen`;
}
