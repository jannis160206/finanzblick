"use client";

import { useState, useSyncExternalStore } from "react";
import { Download, LoaderCircle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccountWorkspace } from "@/components/account-context";
import { useFinance } from "@/components/finance-provider";
import { accountStorageKey } from "@/lib/account-finance-storage";
import { FINANCE_STORAGE_KEY, FINANCE_BACKUP_KEY, FinanceStorage, FinanceStorageError, financeStorageMessage } from "@/lib/finance-storage";
import { createEmptyAccountState } from "@/lib/account-state";
import { appStateSchema } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AccountLogout({ compact = false }: { compact?: boolean }) {
  const workspace = useAccountWorkspace();
  const { saved } = useFinance();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!workspace) return null;
  async function logout() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new FinanceStorageError("Abmelden ist derzeit nicht möglich. Bitte erneut versuchen.");
      const key = accountStorageKey(workspace!.user.id);
      let destination = "/login";
      try {
        localStorage.removeItem(key);
        localStorage.removeItem(`${key}.conflict-backup`);
      } catch (error) {
        if (!(error instanceof DOMException)) throw error;
        destination = "/login?cache=unavailable";
      }
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Clear the signed-out account's in-memory ledger.
      window.location.assign(destination);
    } catch (error) {
      if (error instanceof TypeError) setError("Der Server ist nicht erreichbar. Du wurdest nicht abgemeldet.");
      else setError(financeStorageMessage(error));
      setBusy(false);
    }
  }
  return <div className={compact ? "contents" : "space-y-2"}>
    <Button variant="ghost" size={compact ? "icon" : "sm"} disabled={busy || !saved} onClick={() => void logout()}
      className={cn("text-muted-foreground hover:bg-destructive/10 hover:text-destructive", compact ? "size-11" : "w-full justify-start")}
      aria-busy={busy}
      aria-label="Abmelden" title={!saved ? "Bitte zuerst Änderungen synchronisieren." : "Abmelden"}>
      {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <LogOut aria-hidden="true" className="size-4" />}
      {!compact && (busy ? "Meldet ab …" : "Abmelden")}
    </Button>
    {error && <p role="alert" className={cn("text-xs leading-relaxed text-destructive", compact && "col-span-2 px-2 pb-1")}>{error}</p>}
  </div>;
}

function subscribeLegacy(listener: () => void) {
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
function legacySnapshot() {
  try {
    return localStorage.getItem(FINANCE_STORAGE_KEY) !== null || localStorage.getItem(FINANCE_BACKUP_KEY) !== null ? "available" : "missing";
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    return "unavailable";
  }
}

export function AccountSyncTools() {
  const workspace = useAccountWorkspace();
  const { state, storageError, replace } = useFinance();
  const [imported, setImported] = useState(false);
  const legacyStatus = useSyncExternalStore(subscribeLegacy,
    workspace?.user.role === "admin" ? legacySnapshot : () => "missing",
    () => "missing");
  const legacy = legacyStatus === "available" && !imported;
  const [confirm, setConfirm] = useState<"legacy" | "server" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!workspace) return null;
  function download() {
    const parsed = appStateSchema.parse(state);
    const url = URL.createObjectURL(new Blob([JSON.stringify(parsed, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `Finanzblick_${workspace!.user.username}_${state.settings.asOf}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function apply() {
    setBusy(true);
    setError("");
    try {
      if (confirm === "legacy") {
        const old = new FinanceStorage().load(createEmptyAccountState());
        replace(old.data);
        setImported(true);
      } else await workspace!.loadServer();
      setConfirm(null);
    } catch (error) {
      if (error instanceof FinanceStorageError || error instanceof DOMException) setError(financeStorageMessage(error));
      else throw error;
    } finally {
      setBusy(false);
    }
  }
  if (!legacy && !storageError && !error && legacyStatus !== "unavailable") return null;
  return <section aria-label="Kontodaten übertragen" className="mb-5 rounded-xl border bg-card p-4 text-sm">
    {storageError ? <p>Dieser Gerätestand bleibt erhalten. Vor dem Laden neuerer Serverdaten bitte eine Sicherung herunterladen.</p>
      : <p>In diesem Browser liegen noch Daten von vor der Konto-Anmeldung. Nur nach deiner Bestätigung werden sie in dein Admin-Konto übertragen. Daten von localhost zuerst dort als Excel exportieren.</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={download}><Download className="size-4" />Gerätestand sichern</Button>
      {storageError && <Button variant="outline" size="sm" onClick={() => setConfirm("server")}>Serverstand laden</Button>}
      {legacy && <Button size="sm" onClick={() => setConfirm("legacy")}>Bisherige Browserdaten übernehmen</Button>}
    </div>
    {confirm && <div className="mt-4 border-t pt-3">
      <p>{confirm === "legacy" ? "Den Kontostand durch die bisherigen Browserdaten ersetzen? Die Originaldaten im Browser bleiben erhalten."
        : "Den Gerätestand durch die Serverdaten ersetzen? Ungesicherte Änderungen werden zusätzlich lokal als Konfliktsicherung aufbewahrt."}</p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void apply()}>Übernahme bestätigen</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(null)}>Abbrechen</Button>
      </div>
    </div>}
    {error && <p role="alert" className="mt-3 text-destructive">{error}</p>}
    {legacyStatus === "unavailable" && <p role="alert" className="mt-3 text-destructive">Bisherige Browserdaten sind nicht erreichbar. Bitte die Browserspeicher-Einstellungen prüfen.</p>}
  </section>;
}
