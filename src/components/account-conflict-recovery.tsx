"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useAccountWorkspace } from "@/components/account-context";
import { useFinance, useFinanceRestoration } from "@/components/finance-provider";
import {
  ACCOUNT_CONFLICT_EVENT, accountConflictKey, accountStorageKey, assertAccountConflictUnchanged,
  discardAccountConflictBackup, parseAccountCacheState, parseAccountConflictBackup,
} from "@/lib/account-finance-storage";
import { downloadFinanceBackup } from "@/lib/finance-backup";
import { FinanceStorageError, financeStorageMessage } from "@/lib/finance-storage";
import type { AppState } from "@/lib/types";

const unavailable = Symbol("unavailable");
const serverSnapshot = () => null;

function useAccountBackupSnapshot(accountId: string | null, source: "conflict" | "cache") {
  const key = accountId ? (source === "conflict" ? accountConflictKey(accountId) : accountStorageKey(accountId)) : null;
  const subscribe = useCallback((notify: () => void) => {
    if (!key) return () => {};
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) notify();
    };
    window.addEventListener("storage", storage);
    window.addEventListener(ACCOUNT_CONFLICT_EVENT, notify);
    return () => {
      window.removeEventListener("storage", storage);
      window.removeEventListener(ACCOUNT_CONFLICT_EVENT, notify);
    };
  }, [key]);
  const snapshot = useCallback(() => {
    if (!key) return null;
    try { return localStorage.getItem(key); }
    catch (error) {
      if (!(error instanceof DOMException)) throw error;
      return unavailable;
    }
  }, [key]);
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return useMemo(() => {
    if (raw === unavailable) return { raw: null, state: null, error: source === "conflict"
      ? "Die Konfliktsicherung ist nicht erreichbar. Bitte die Browserspeicher-Einstellungen prüfen."
      : "Die lokale Kontosicherung ist nicht erreichbar. Das Geräte-Original kann nicht heruntergeladen werden.", unavailable: true };
    if (raw === null || !accountId) return { raw: null, state: null, error: "", unavailable: false };
    try { return { raw, state: source === "conflict" ? parseAccountConflictBackup(raw, accountId) : parseAccountCacheState(raw), error: "", unavailable: false }; }
    catch (error) {
      if (!(error instanceof FinanceStorageError)) throw error;
      return { raw, state: null, error: error.message, unavailable: false };
    }
  }, [raw, accountId, source]);
}

export function useAccountConflictSnapshot(accountId: string | null) {
  return useAccountBackupSnapshot(accountId, "conflict");
}

export function useAccountCacheSnapshot(accountId: string | null) {
  return useAccountBackupSnapshot(accountId, "cache");
}

export function downloadAccountRawSource(raw: string, filename: string) {
  const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadAccountConflict(raw: string, accountId: string) {
  let state: AppState;
  try { state = parseAccountConflictBackup(raw, accountId); }
  catch (error) {
    if (!(error instanceof FinanceStorageError)) throw error;
    downloadAccountRawSource(raw, "Finanzblick_Konflikt_Original_ungeprueft.json");
    return;
  }
  downloadFinanceBackup(state, `Finanzblick_Konflikt_${state.settings.asOf}.json`, accountId);
}

export function downloadAccountCache(raw: string, accountId: string) {
  let state: AppState;
  try { state = parseAccountCacheState(raw); }
  catch (error) {
    if (!(error instanceof FinanceStorageError)) throw error;
    downloadAccountRawSource(raw, "Finanzblick_Cache_Original_ungeprueft.json");
    return;
  }
  downloadFinanceBackup(state, `Finanzblick_Cache_${state.settings.asOf}.json`, accountId);
}

export function AccountBackupScope({ state }: { state: AppState }) {
  return <p className="text-xs leading-relaxed">
    {state.settings.asOf} · {state.transactions.length} Buchungen · vollständiger Kontostand
  </p>;
}

export function AccountConflictRecovery() {
  const workspace = useAccountWorkspace();
  const identity = useRef(workspace?.user.id);
  useLayoutEffect(() => { identity.current = workspace?.user.id; }, [workspace?.user.id]);
  if (!workspace) return null;
  return <ConflictRecovery key={workspace.user.id} accountId={workspace.user.id}
    username={workspace.user.username} isCurrent={() => identity.current === workspace.user.id} />;
}

function ConflictRecovery({ accountId, username, isCurrent }: { accountId: string; username: string; isCurrent: () => boolean }) {
  const backup = useAccountConflictSnapshot(accountId);
  const { state } = useFinance();
  const restore = useFinanceRestoration();
  const [review, setReview] = useState<{ raw: string; state: AppState | null; expected: AppState; action: "restore" | "discard" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (backup.raw === null && !backup.error && !error) return null;

  async function apply() {
    if (!review || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!isCurrent()) throw new FinanceStorageError("Das Konto wurde gewechselt. Bitte erneut prüfen.");
      assertAccountConflictUnchanged(accountId, review.raw);
      if (review.action === "restore" && review.state) {
        await restore(review.state, review.expected);
        if (!isCurrent()) throw new FinanceStorageError("Das Konto wurde gewechselt. Die Konfliktsicherung bleibt erhalten.");
      }
      discardAccountConflictBackup(accountId, review.raw);
      setReview(null);
    } catch (error) { setError(financeStorageMessage(error)); }
    finally { setBusy(false); }
  }

  return <details className="mb-5 rounded-xl border bg-card p-4 text-sm">
    <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Lokale Konfliktsicherung</summary>
    <div className="mt-3 space-y-3">
      <p className="text-muted-foreground">Zusätzliche Sicherung für {username}. Wird nicht automatisch gelöscht.</p>
      {backup.state && <AccountBackupScope state={backup.state} />}
      {backup.error && <p role="alert" className="text-destructive">{backup.error}</p>}
      {backup.raw !== null && <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => {
          try {
            assertAccountConflictUnchanged(accountId, backup.raw);
            downloadAccountConflict(backup.raw!, accountId);
            setError("");
          } catch (error) { setError(financeStorageMessage(error)); }
        }}>{backup.state ? "Konfliktsicherung herunterladen" : "Ungeprüftes Original herunterladen"}</Button>
        {backup.state && <Button size="sm" disabled={busy} onClick={() => setReview({ raw: backup.raw!, state: backup.state, expected: state, action: "restore" })}>Konfliktsicherung wiederherstellen</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReview({ raw: backup.raw!, state: backup.state, expected: state, action: "discard" })}>Konfliktsicherung verwerfen</Button>
      </div>}
      {review && <div className="space-y-3 border-t pt-3" onKeyDown={(event) => { if (event.key === "Escape" && !busy) setReview(null); }}>
        <p>{review.action === "restore" ? "Aktuellen Stand ersetzen? Die Sicherung bleibt bis zur erfolgreichen Speicherung erhalten."
          : "Sicherung endgültig löschen? Der aktuelle Kontostand bleibt unverändert."}</p>
        <Button size="sm" disabled={busy} onClick={() => {
          try { downloadFinanceBackup(state, `Finanzblick_${username}_${state.settings.asOf}.json`, accountId); }
          catch (error) { setError(financeStorageMessage(error)); }
        }}>Aktuellen Kontostand sichern</Button>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => void apply()}>{review.action === "restore" ? "Wiederherstellung bestätigen" : "Verwerfen bestätigen"}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReview(null)}>Abbrechen</Button>
        </div>
      </div>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  </details>;
}
