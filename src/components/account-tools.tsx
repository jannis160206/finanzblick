"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Download, LoaderCircle, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccountWorkspace } from "@/components/account-context";
import { useFinance } from "@/components/finance-provider";
import { accountConflictKey, accountStorageKey, assertAccountConflictUnchanged, discardAccountConflictBackup, parseAccountCache, parseAccountCacheState } from "@/lib/account-finance-storage";
import { AccountBackupScope, AccountConflictRecovery, downloadAccountCache, downloadAccountConflict, downloadAccountRawSource, useAccountCacheSnapshot } from "@/components/account-conflict-recovery";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadFinanceBackup } from "@/lib/finance-backup";
import { FinanceStorage, FinanceStorageError, financeStorageMessage } from "@/lib/finance-storage";
import { LegacyAccountNotice, subscribeLegacyNotice, type LegacyNoticeStatus } from "@/lib/legacy-account-notice";
import { createEmptyAccountState } from "@/lib/account-state";
import { appStateSchema, type AppState } from "@/lib/types";
import { cn } from "@/lib/utils";

const unavailableLogoutBackupsMessage = "Lokale Sicherungen sind nicht erreichbar. Sie können vor dem Abmelden nicht geprüft oder heruntergeladen werden. Beim Abmelden bleiben diese ungeprüften lokalen Daten auf diesem Gerät erhalten.";

export function AccountLogout({ compact = false }: { compact?: boolean }) {
  const workspace = useAccountWorkspace();
  const { state, saved } = useFinance();
  const latest = useRef({ id: workspace?.user.id, state, saved });
  useLayoutEffect(() => { latest.current = { id: workspace?.user.id, state, saved }; }, [workspace?.user.id, state, saved]);
  const [review, setReview] = useState<{ id: string; state: AppState; cache: string | null; conflict: string | null; unavailable: boolean; cacheNeedsDownload: boolean; cacheMalformed: boolean } | null>(null);
  const [downloads, setDownloads] = useState({ memory: false, cache: false, conflict: false });
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!workspace) return null;
  const downloaded = review !== null && !review.unavailable && downloads.memory &&
    (!review.cacheNeedsDownload || downloads.cache) && (review.conflict === null || downloads.conflict);
  function preview() {
    if (!saved || busy) return;
    setError("");
    setDownloads({ memory: false, cache: false, conflict: false });
    setDiscard(false);
    try {
      const cache = localStorage.getItem(accountStorageKey(workspace!.user.id));
      const conflict = localStorage.getItem(accountConflictKey(workspace!.user.id));
      let cacheNeedsDownload = false;
      let cacheMalformed = false;
      if (cache !== null) {
        try {
          const parsed = parseAccountCache(cache);
          const memory = appStateSchema.safeParse(state);
          cacheNeedsDownload = parsed.pending || !memory.success ||
            JSON.stringify(parsed.state) !== JSON.stringify(memory.data);
        } catch (error) {
          if (!(error instanceof FinanceStorageError)) throw error;
          cacheNeedsDownload = true;
          cacheMalformed = true;
        }
      }
      setReview({ id: workspace!.user.id, state, cache, conflict, unavailable: false, cacheNeedsDownload, cacheMalformed });
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      setReview({ id: workspace!.user.id, state, cache: null, conflict: null, unavailable: true, cacheNeedsDownload: true, cacheMalformed: false });
      setError(unavailableLogoutBackupsMessage);
    }
  }
  function assertReview() {
    if (!review || latest.current.id !== review.id || latest.current.state !== review.state || !latest.current.saved)
      throw new FinanceStorageError("Der Kontostand wurde zwischenzeitlich geändert. Bitte abbrechen und erneut prüfen.");
    if (!review.unavailable) {
      assertAccountConflictUnchanged(review.id, review.conflict);
      if (localStorage.getItem(accountStorageKey(review.id)) !== review.cache)
        throw new FinanceStorageError("Die lokale Kontosicherung wurde zwischenzeitlich geändert. Bitte abbrechen und erneut prüfen.");
    }
  }
  function backup(source: "memory" | "cache" | "conflict") {
    try {
      assertReview();
      if (source === "memory") downloadFinanceBackup(review!.state, `Finanzblick_${workspace!.user.username}_${review!.state.settings.asOf}.json`, review!.id);
      else if (source === "cache" && review!.cache !== null) downloadAccountCache(review!.cache, review!.id);
      else if (source === "conflict" && review!.conflict !== null) downloadAccountConflict(review!.conflict, review!.id);
      else throw new FinanceStorageError("Die ausgewählte lokale Sicherung ist nicht mehr vorhanden. Bitte erneut prüfen.");
      assertReview();
      setDownloads((previous) => ({ ...previous, [source]: true }));
      setError(review!.unavailable ? unavailableLogoutBackupsMessage : "");
    } catch (error) { setError(financeStorageMessage(error)); }
  }
  async function logout() {
    if (busy || !saved || !review || (!downloaded && !discard)) return;
    setBusy(true);
    setError("");
    try {
      assertReview();
      let response: Response;
      try {
        response = await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new FinanceStorageError("Der Server ist nicht erreichbar. Du wurdest nicht abgemeldet.");
      }
      if (!response.ok) throw new FinanceStorageError("Abmelden ist derzeit nicht möglich. Bitte erneut versuchen.");
      const key = accountStorageKey(review.id);
      let destination = "/login";
      try {
        assertReview();
        if (review.unavailable) throw new DOMException("Storage unreviewed", "SecurityError");
        localStorage.removeItem(key);
        discardAccountConflictBackup(review.id, review.conflict);
      } catch (error) {
        if (!(error instanceof DOMException) && !(error instanceof FinanceStorageError)) throw error;
        destination = "/login?cache=unavailable";
      }
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Clear the signed-out account's in-memory ledger.
      window.location.assign(destination);
    } catch (error) {
      setError(financeStorageMessage(error));
      setBusy(false);
    }
  }
  return <div className={compact ? "contents" : "space-y-2"}>
    <Button variant="ghost" size={compact ? "icon" : "sm"} disabled={busy || !saved} onClick={preview}
      className={cn("text-muted-foreground hover:bg-destructive/10 hover:text-destructive", compact ? "size-11" : "w-full justify-start")}
      aria-busy={busy}
      aria-label="Abmelden" title={!saved ? "Bitte zuerst Änderungen synchronisieren." : "Abmelden"}>
      {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <LogOut aria-hidden="true" className="size-4" />}
      {!compact && (busy ? "Meldet ab …" : "Abmelden")}
    </Button>
    {error && !review && <p role="alert" className={cn("text-xs leading-relaxed text-destructive", compact && "col-span-2 px-2 pb-1")}>{error}</p>}
    <Dialog open={review !== null && review.id === workspace.user.id} onOpenChange={(open) => { if (!open && !busy) { setReview(null); setError(""); } }}>
      <DialogContent variant="confirmation" showCloseButton={!busy} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Vor dem Abmelden sichern</DialogTitle>
          <DialogDescription className="overflow-visible whitespace-normal text-clip">Beim Abmelden werden der lokale Kontocache und die Konfliktsicherung dieses Kontos gelöscht. Serverdaten und Daten anderer Konten bleiben unverändert.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3 text-sm">
          {review && <AccountBackupScope state={review.state} />}
          {review?.cacheNeedsDownload && !review.unavailable && <p>Der lokale Kontocache enthält ungesicherte Änderungen, weicht vom angezeigten Kontostand ab oder ist ungültig. Bitte ihn separat herunterladen; die Sicherung des angezeigten Kontostands enthält diesen Cache nicht.</p>}
          {review?.cacheMalformed && <p>Der Cache-Download enthält den ungeprüften Originaltext, keinen wiederherstellbaren JSON-Kontostand. Bitte das Original vor dem Löschen sicher aufbewahren.</p>}
          {review?.conflict !== null && review?.conflict !== undefined && <p>Es gibt zusätzlich eine lokale Konfliktsicherung. Sie muss separat heruntergeladen werden. Ein ungültiges Original bleibt ungeprüft und ist möglicherweise nicht wiederherstellbar.</p>}
          <Button variant="outline" disabled={busy} onClick={() => backup("memory")}>Aktuellen Kontostand herunterladen</Button>
          {review?.cache !== null && review?.cache !== undefined && <Button variant="outline" disabled={busy} onClick={() => backup("cache")}>{review.cacheMalformed ? "Ungeprüftes Cache-Original herunterladen" : "Lokalen Kontocache herunterladen"}</Button>}
          {review?.conflict !== null && review?.conflict !== undefined && <Button variant="outline" disabled={busy} onClick={() => backup("conflict")}>Konfliktsicherung herunterladen</Button>}
          <p>Jede Aktion lädt genau eine Datei herunter. Bitte alle erforderlichen Downloads einzeln ausführen und die Dateien prüfen.</p>
          {downloaded && <p>Bitte die heruntergeladenen Dateien prüfen und sicher aufbewahren, bevor du die lokalen Kopien löschst.</p>}
          <label className="flex items-start gap-2"><input type="checkbox" checked={discard} disabled={busy} onChange={(event) => setDiscard(event.target.checked)} />
            Lokale Kontodaten und Konfliktsicherung bewusst ohne Sicherung verwerfen.</label>
          {error && <p role="alert" className="text-destructive">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => { setReview(null); setError(""); }}>Abbrechen</Button>
          <Button disabled={busy || !saved || (!downloaded && !discard)} onClick={() => void logout()}>{discard ? "Ohne Sicherung abmelden" : "Gesichert abmelden"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

const missingLegacySnapshot = (): LegacyNoticeStatus => "missing";

export function AccountSyncTools({ manual = false, visible = true }: { manual?: boolean; visible?: boolean } = {}) {
  const workspace = useAccountWorkspace();
  const { state, storageError: syncError, replace } = useFinance();
  const storageError = manual ? null : syncError;
  const source = useAccountCacheSnapshot(storageError ? workspace?.user.id ?? null : null);
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
  const [serverReview, setServerReview] = useState<{ state: AppState; accountId: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!workspace) return null;
  function download() {
    try {
      const raw = localStorage.getItem(accountStorageKey(workspace!.user.id));
      if (source.raw !== null && source.error && raw !== source.raw)
        throw new FinanceStorageError("Das Geräte-Original wurde zwischenzeitlich geändert. Bitte erneut prüfen; es wurde keine Ersatzsicherung erstellt.");
      if (raw !== null) {
        try { parseAccountCacheState(raw); }
        catch (error) {
          if (!(error instanceof FinanceStorageError)) throw error;
          downloadAccountRawSource(raw, "Finanzblick_Geraet_Original_ungeprueft.json");
          setError("Das ungeprüfte Geräte-Original wurde heruntergeladen. Es ist kein wiederherstellbarer JSON-Kontostand; bestehende Daten bleiben unverändert.");
          return;
        }
      }
      downloadFinanceBackup(state, `Finanzblick_${workspace!.user.username}_${state.settings.asOf}.json`, workspace!.user.id);
      setError("");
    }
    catch (error) { setError(financeStorageMessage(error)); }
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
      } else {
        if (!serverReview || serverReview.state !== state || serverReview.accountId !== workspace!.user.id)
          throw new FinanceStorageError("Der Kontostand wurde zwischenzeitlich geändert. Bitte abbrechen und den Serverstand erneut prüfen.");
        await workspace!.loadServer();
      }
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
  const showTools = legacy || storageError || error || legacyStatus === "unavailable" || legacyStatus === "unsaved";
  if (!showTools) return <AccountConflictRecovery />;
  const content = <section aria-label="Kontodaten übertragen" className="mb-5 rounded-xl border bg-card p-4 text-sm">
    {storageError ? <p>Dieser Gerätestand bleibt erhalten. Vor dem Laden neuerer Serverdaten bitte eine Sicherung herunterladen.</p>
      : legacy && <p>In diesem Browser liegen noch Daten von vor der Konto-Anmeldung. Nur nach deiner Bestätigung werden sie in dein Admin-Konto übertragen. Daten von localhost zuerst dort als Excel exportieren.</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={download}><Download className="size-4" />{source.raw !== null && source.error ? "Ungeprüftes Geräte-Original herunterladen" : "Gerätestand sichern"}</Button>
      {storageError && <Button variant="outline" size="sm" onClick={() => { setServerReview({ state, accountId: workspace.user.id }); setConfirm("server"); }}>Serverstand laden</Button>}
      {legacy && <Button size="sm" onClick={() => setConfirm("legacy")}>Bisherige Browserdaten übernehmen</Button>}
      {legacy && !manual && <Button variant="ghost" size="sm" disabled={busy} onClick={dismiss}>Hinweis ausblenden</Button>}
    </div>
    {source.raw !== null && source.error && <p role="alert" className="mt-3 text-destructive">Das Geräte-Original ist unlesbar oder ungültig und bleibt unverändert. Der Download enthält nur den ungeprüften Originaltext und ist kein wiederherstellbarer JSON-Kontostand. Beim Laden des Serverstands wird dieser Originaltext zusätzlich als Konfliktsicherung aufbewahrt.</p>}
    {source.unavailable && <p role="alert" className="mt-3 text-destructive">{source.error}</p>}
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
  return <><AccountConflictRecovery />{manual ? <details className="mt-4">
    <summary className="cursor-pointer text-xs font-medium">Bisherige Browserdaten</summary>
    <div className="mt-3">{content}</div>
  </details> : content}</>;
}
