"use client";

import { useSyncExternalStore } from "react";
import { useAccountWorkspace } from "@/components/account-context";
import { backupAgeText, backupStatus, localDateKey, readLastBackup, subscribeBackup } from "@/lib/backup-age";

const serverSnapshot = () => undefined;

export function BackupAge() {
  const scope = useAccountWorkspace()?.user.id ?? "local";
  const last = useSyncExternalStore(
    subscribeBackup,
    () => readLastBackup(scope),
    serverSnapshot,
  );
  if (last === undefined) return null;
  const status = backupStatus(last, localDateKey());
  if (status.kind === "none") {
    return <p className="mt-2 text-xs text-muted-foreground">Noch keine Excel-Sicherung auf diesem Gerät vermerkt. Du kannst jederzeit eine herunterladen.</p>;
  }
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Letztes Excel-Backup {backupAgeText(status.days)}</span>
      {status.kind === "stale" && " · Zeit für eine frische Sicherung."}
    </p>
  );
}
