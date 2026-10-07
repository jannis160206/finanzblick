"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Download, LoaderCircle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccountWorkspace } from "@/components/account-context";
import { useFinance } from "@/components/finance-provider";
import { accountStorageKey } from "@/lib/account-finance-storage";
import { FinanceStorage, FinanceStorageError, financeStorageMessage } from "@/lib/finance-storage";
import { LegacyAccountNotice, subscribeLegacyNotice, type LegacyNoticeStatus } from "@/lib/legacy-account-notice";
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

const missingLegacySnapshot = (): LegacyNoticeStatus => "missing";

export function AccountSyncTools({ manual = false, visible = true }: { manual?: boolean; visible?: boolean } = {}) {
  const workspace = useAccountWorkspace();
  const { state, storageError: syncError, replace } = useFinance();
  const storageError = manual ? null : syncError;
  const adminId = workspace?.user.role === "admin" ? workspace.user.id : null;
  const notice = useMemo(() => new LegacyAccountNotice(adminId, manual), [adminId, manual]);
  const [importedFor, setImportedFor] = useState<string | null>(null);
  const imported = adminId !== null && importedFor === adminId;
  const legacyStatus = useSyncExternalStore(subscribeLegacyNotice, notice.getSnapshot, missingLegacySnapshot);
  const legacy = (legacyStatus === "available" || legacyStatus === "unsaved") && !imported;
  useEffect(() => {
    if (visible && !storageError && legacyStatus === "available") notice.markShown();
  }, [visible, storageError, legacyStatus, notice]);
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
        if (!adminId) throw new FinanceStorageError("Browserdaten dürfen nur ausdrücklich in ein Admin-Konto übernommen werden.");
        const fallback = createEmptyAccountState();
        const old = new FinanceStorage().load(fallback);
        if (old.data === fallback) throw new FinanceStorageError("Bisherige Browserdaten sind nicht mehr vorhanden. Dein Kontostand bleibt unverändert.");
        replace(old.data);
        notice.markHandled();
        setImportedFor(adminId);
      } else await workspace!.loadServer();
      setConfirm(null);
    } catch (error) {
      if (error instanceof FinanceStorageError || error instanceof DOMException) setError(financeStorageMessage(error));
      else throw error;
    } finally {
      setBusy(false);
    }
  }
  function dismiss() {
    try {
      notice.markHandled();
      setError("");
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      setError(financeStorageMessage(error));
    }
  }
  if (!legacy && !storageError && !error && legacyStatus !== "unavailable" && legacyStatus !== "unsaved") return null;
  const content = <section aria-label="Kontodaten übertragen" className="mb-5 rounded-xl border bg-card p-4 text-sm">
    {storageError ? <p>Dieser Gerätestand bleibt erhalten. Vor dem Laden neuerer Serverdaten bitte eine Sicherung herunterladen.</p>
      : legacy && <p>In diesem Browser liegen noch Daten von vor der Konto-Anmeldung. Nur nach deiner Bestätigung werden sie in dein Admin-Konto übertragen. Daten von localhost zuerst dort als Excel exportieren.</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={download}><Download className="size-4" />Gerätestand sichern</Button>
      {storageError && <Button variant="outline" size="sm" onClick={() => setConfirm("server")}>Serverstand laden</Button>}
      {legacy && <Button size="sm" onClick={() => setConfirm("legacy")}>Bisherige Browserdaten übernehmen</Button>}
      {legacy && !manual && <Button variant="ghost" size="sm" disabled={busy} onClick={dismiss}>Hinweis ausblenden</Button>}
    </div>
    {confirm && (confirm === "server" || legacy) && <div className="mt-4 border-t pt-3">
      <p>{confirm === "legacy" ? "Den Kontostand durch die bisherigen Browserdaten ersetzen? Die Originaldaten im Browser bleiben erhalten."
        : "Den Gerätestand durch die Serverdaten ersetzen? Ungesicherte Änderungen werden zusätzlich lokal als Konfliktsicherung aufbewahrt."}</p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void apply()}>Übernahme bestätigen</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(null)}>Abbrechen</Button>
      </div>
    </div>}
    {error && <p role="alert" className="mt-3 text-destructive">{error}</p>}
    {legacyStatus === "unavailable" && <p role="alert" className="mt-3 text-destructive">Bisherige Browserdaten sind nicht erreichbar. Bitte die Browserspeicher-Einstellungen prüfen.</p>}
    {legacyStatus === "unsaved" && <p role="alert" className="mt-3 text-destructive">Dieser Hinweis konnte nicht dauerhaft gespeichert werden. Bitte die Browserspeicher-Einstellungen prüfen.</p>}
  </section>;
  return manual ? <details className="mt-4">
    <summary className="cursor-pointer text-xs font-medium">Bisherige Browserdaten</summary>
    <div className="mt-3">{content}</div>
  </details> : content;
}
