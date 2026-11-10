"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FolderOpen, FolderSync, Loader2, RefreshCw, RotateCcw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { useAccountWorkspace } from "@/components/account-context";
import { requestDriveInbox } from "@/components/drive-inbox";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { accountRequest } from "@/lib/account-request";
import { navigate } from "@/lib/browser-navigation";
import { DRIVE_FOLDER_NAMES, DRIVE_FOLDER_PURPOSE } from "@/lib/drive/folders";
import type { DriveFolderKind, DriveProcessed, DriveStatus } from "@/lib/drive/store";
import type { DriveSyncResult } from "@/lib/drive/sync";
import { cn } from "@/lib/utils";

const outcomes: Record<string, { ok: boolean; text: string }> = {
  verbunden: { ok: true, text: "Google Drive verbunden." },
  abgelehnt: { ok: false, text: "Der Zugriff wurde bei Google abgelehnt." },
  abgelaufen: { ok: false, text: "Die Anmeldung bei Google hat zu lange gedauert oder lief in einem anderen Fenster. Bitte erneut verbinden." },
  anmeldung: { ok: false, text: "Die Rückleitung von Google kam ohne Anmeldung an. Weiterleitungs-URI und Finanzblick-Adresse müssen denselben Host verwenden (z. B. beide „localhost“)." },
  "drive-fehlt": { ok: false, text: "Der Lesezugriff auf Google Drive wurde nicht erlaubt. Beim Verbinden bitte das Häkchen für Drive setzen." },
  "nicht-eingerichtet": { ok: false, text: "Google Drive ist auf diesem Server nicht eingerichtet." },
  fehler: { ok: false, text: "Google Drive konnte nicht verbunden werden. Bitte erneut versuchen." },
};

const dayFormat = new Intl.DateTimeFormat("de-AT", { day: "numeric", month: "numeric", year: "numeric" });
const folderKinds: DriveFolderKind[] = ["amex", "payslips"];
const outcomeBadge: Record<DriveProcessed["outcome"], { label: string; variant: "success" | "warning" | "destructive" | "secondary" | "info" }> = {
  queued: { label: "An Umsätze übergeben", variant: "info" },
  inbox: { label: "Wird gelesen", variant: "secondary" },
  imported: { label: "Übernommen", variant: "success" },
  skipped: { label: "Übersprungen", variant: "warning" },
  failed: { label: "Fehler", variant: "destructive" },
};
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const timeFormat = new Intl.DateTimeFormat("de-AT", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

export function DriveConnection() {
  const workspace = useAccountWorkspace();
  const account = workspace?.user.id ?? null;
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<"connect" | "remove" | "sync" | "retry" | "folder" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    try {
      setStatus(await accountRequest<DriveStatus>("/api/drive", account));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [account]);

  useEffect(() => {
    if (!account) return;
    let active = true;
    accountRequest<DriveStatus>("/api/drive", account).then(
      (body) => { if (active) { setStatus(body); setFailed(false); } },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [account]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("drive");
    if (!outcome) return;
    url.searchParams.delete("drive");
    window.history.replaceState(window.history.state, "", url);
    const message = outcomes[outcome] ?? outcomes.fehler;
    if (message.ok) toast.success(message.text); else toast.error(message.text);
    queueMicrotask(() => setNotice(message.ok ? null : message));
  }, []);

  if (!account) return null;

  async function connect() {
    if (!account) return;
    setBusy("connect");
    setNotice(null);
    try {
      const { url } = await accountRequest<{ url: string }>("/api/drive/connect", account, { method: "POST" }, "Google Drive konnte nicht gestartet werden.");
      navigate(url);
    } catch (cause) {
      setNotice({ ok: false, text: cause instanceof Error ? cause.message : "Google Drive konnte nicht gestartet werden." });
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!account) return;
    setBusy("remove");
    try {
      setStatus(await accountRequest<DriveStatus>("/api/drive", account, { method: "DELETE" }, "Die Verbindung konnte nicht getrennt werden."));
      setConfirming(false);
      toast.success("Google Drive getrennt");
    } catch (cause) {
      setNotice({ ok: false, text: cause instanceof Error ? cause.message : "Die Verbindung konnte nicht getrennt werden." });
    } finally {
      setBusy(null);
    }
  }

  async function check(body: { action: "sync" } | { action: "retry" } | { action: "folder"; kind: DriveFolderKind; id: string }) {
    if (!account) return;
    setBusy(body.action);
    setNotice(null);
    try {
      const { result, status: next } = await accountRequest<{ result: DriveSyncResult; status: DriveStatus }>("/api/drive", account,
        { method: "POST", json: body }, "Google Drive konnte nicht geprüft werden.");
      setStatus(next);
      const added = folderKinds.reduce((sum, kind) => sum + result.folders[kind].added, 0);
      toast.success(added ? `${plural(added, "neue Datei", "neue Dateien")} aus Google Drive` : "Keine neuen Dateien in Google Drive");
      if (next.inbox) requestDriveInbox();
    } catch (cause) {
      setNotice({ ok: false, text: cause instanceof Error ? cause.message : "Google Drive konnte nicht geprüft werden." });
      void load();
    } finally {
      setBusy(null);
    }
  }

  const redirectUri = status?.redirectUri ?? (typeof window === "undefined" ? "" : `${window.location.origin}/api/auth/callback/google`);
  const connected = !!status?.connected;
  const expired = !!status?.expired;

  return (
    <SettingsSection id="google-drive" title="Google Drive" icon={FolderSync}
      description="Finanzblick liest neue Dateien aus den Ordnern „AMEX Abrechnungen“ (Umsätze) und „Abrechnungen“ (Lohnzettel) – nur lesend und ohne Dateien in Drive zu verändern."
      action={connected && !expired ? <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setConfirming(true)}><Unplug aria-hidden="true" className="size-4" />Trennen</Button> : undefined}>
      {!status ? (
        failed
          ? <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"><p>Status nicht erreichbar.</p><Button variant="outline" size="sm" onClick={() => { void load(); }}>Erneut laden</Button></div>
          : <div role="status" className="h-16 rounded-2xl bg-muted/60 motion-safe:animate-pulse"><span className="sr-only">Wird geladen …</span></div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-background/40 px-4 py-3">
            <span aria-hidden="true" className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl",
              connected && !expired ? "bg-accent-muted text-primary" : "bg-muted text-muted-foreground")}>
              <FolderSync className="size-5" />
            </span>
            <div className="min-w-0 flex-1 basis-48">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span className="truncate">{connected ? status.email ?? status.name ?? "Google-Konto" : status.configured ? "Nicht verbunden" : "Nicht eingerichtet"}</span>
                {connected && <Badge variant={expired ? "warning" : "success"}>{expired ? "Freigabe abgelaufen" : "Aktiv"}</Badge>}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {connected
                  ? [status.connectedAt ? `Verbunden seit ${dayFormat.format(status.connectedAt)}` : null,
                    status.lastSync ? `zuletzt geprüft ${timeFormat.format(status.lastSync)}` : "noch nicht geprüft"].filter(Boolean).join(" · ")
                  : status.configured ? "Ordner „AMEX Abrechnungen“ und „Abrechnungen“ automatisch einlesen." : "GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET fehlen auf dem Server."}
              </p>
            </div>
            {connected && !expired && (
              <Button variant="outline" size="sm" className="w-full sm:w-auto" disabled={!!busy} onClick={() => { void check({ action: "sync" }); }}>
                <RefreshCw aria-hidden="true" className={cn("size-4", busy === "sync" && "motion-safe:animate-spin")} />Jetzt prüfen
              </Button>
            )}
            {status.configured && (!connected || expired) && (
              <Button size="sm" disabled={!!busy} onClick={() => { void connect(); }}>
                {busy === "connect" ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : expired ? <RefreshCw aria-hidden="true" className="size-4" /> : <FolderSync aria-hidden="true" className="size-4" />}
                {expired ? "Erneut verbinden" : "Mit Google verbinden"}
              </Button>
            )}
          </div>
          {connected && <DriveFolders status={status} busy={!!busy} onChoose={(kind, id) => { void check({ action: "folder", kind, id }); }} />}
          {connected && <DriveActivity status={status} busy={!!busy} retrying={busy === "retry"} onRetry={() => { void check({ action: "retry" }); }} />}
          {expired && <p className="text-xs leading-relaxed text-muted-foreground">Im Google-Testmodus gilt eine Freigabe sieben Tage. Danach einmal erneut verbinden; bereits importierte Dateien werden nicht doppelt übernommen.</p>}
          {status.lastError && !expired && <p role="alert" className="text-sm text-destructive">{status.lastError}</p>}
          {notice && !notice.ok && <p role="alert" className="text-sm text-destructive">{notice.text}</p>}
          <details className="group text-xs text-muted-foreground">
            <summary className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
              Einrichtung
            </summary>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 leading-relaxed">
              <li>In der Google Cloud Console die <strong className="font-medium text-foreground">Google Drive API</strong> aktivieren und dein Google-Konto als Testnutzer eintragen.</li>
              <li>Als autorisierte Weiterleitungs-URI eintragen: <code className="break-all rounded bg-muted px-1.5 py-0.5 text-foreground">{redirectUri}</code></li>
              <li><code className="rounded bg-muted px-1 py-0.5">GOOGLE_CLIENT_ID</code> und <code className="rounded bg-muted px-1 py-0.5">GOOGLE_CLIENT_SECRET</code> in der privaten Umgebungsdatei des Servers setzen und neu starten.</li>
            </ol>
            <p className="mt-2 leading-relaxed">Im Google-Testmodus laufen Freigaben nach sieben Tagen ab, und nur eingetragene Testnutzer können sich verbinden.</p>
          </details>
        </div>
      )}
      <Dialog open={confirming} onOpenChange={(open) => { if (!open && !busy) setConfirming(false); }}>
        <DialogContent variant="confirmation">
          <DialogHeader>
            <DialogTitle>Google Drive trennen?</DialogTitle>
            <DialogDescription>Finanzblick widerruft die Freigabe und liest keine neuen Dateien mehr. Bereits importierte Daten bleiben.</DialogDescription>
          </DialogHeader>
          <DialogBody />
          <DialogFooter>
            <Button variant="outline" disabled={!!busy} onClick={() => setConfirming(false)}>Abbrechen</Button>
            <Button variant="destructive" disabled={!!busy} onClick={() => { void disconnect(); }}>
              {busy === "remove" && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}Trennen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

function DriveFolders({ status, busy, onChoose }: { status: DriveStatus; busy: boolean; onChoose: (kind: DriveFolderKind, id: string) => void }) {
  return (
    <ul aria-label="Ordner in Google Drive" className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70">
      {folderKinds.map((kind) => {
        const folder = status.folders?.[kind];
        const missing = !!status.lastSync && !folder;
        return (
          <li key={kind} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <FolderOpen aria-hidden="true" className={cn("size-4 shrink-0", missing ? "text-warning" : "text-muted-foreground")} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{DRIVE_FOLDER_NAMES[kind]}</p>
              <p className="text-xs text-muted-foreground">{DRIVE_FOLDER_PURPOSE[kind]}</p>
            </div>
            {missing ? <Badge variant="warning">Nicht gefunden</Badge>
              : folder ? <span className="text-xs tabular-nums text-muted-foreground">{plural(folder.lastCount ?? 0, "Datei", "Dateien")}</span>
                : <span className="text-xs text-muted-foreground">Noch nicht geprüft</span>}
            {folder?.choices && folder.choices.length > 1 && (
              <select className="select-input w-full sm:w-auto" aria-label={`Ordner „${DRIVE_FOLDER_NAMES[kind]}“ wählen`} disabled={busy}
                value={folder.pinned ? folder.id : ""} onChange={(event) => { if (event.target.value) onChoose(kind, event.target.value); }}>
                {!folder.pinned && <option value="" disabled>Ordner wählen …</option>}
                {folder.choices.map((choice, index) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.modified ? `Geändert ${dayFormat.format(new Date(choice.modified))}` : `Ordner ${index + 1}`}
                  </option>
                ))}
              </select>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DriveActivity({ status, busy, retrying, onRetry }: { status: DriveStatus; busy: boolean; retrying: boolean; onRetry: () => void }) {
  const recent = status.recent ?? [];
  const hints = [
    ...(status.notes ?? []),
    ...(status.inbox ? [`${status.inbox} Lohnzettel ${status.inbox === 1 ? "wartet" : "warten"} auf das Einlesen.`] : []),
    ...(status.backlog ? ["Weitere Dateien folgen beim nächsten Abruf."] : []),
  ];
  if (!recent.length && !hints.length && !status.retryable) return null;
  return (
    <div className="space-y-3">
      {hints.length > 0 && (
        <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          {hints.map((hint) => <li key={hint}>{hint}</li>)}
        </ul>
      )}
      {!!status.retryable && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-warning-soft px-4 py-3 text-sm">
          <p className="min-w-0 flex-1 basis-48">{plural(status.retryable, "Datei wurde", "Dateien wurden")} übersprungen oder nicht gelesen.</p>
          <Button variant="outline" size="sm" className="w-full sm:w-auto" disabled={busy} onClick={onRetry}>
            <RotateCcw aria-hidden="true" className={cn("size-4", retrying && "motion-safe:animate-spin")} />Erneut versuchen
          </Button>
        </div>
      )}
      {recent.length > 0 && (
        <details className="group text-sm">
          <summary className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">
            <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            Zuletzt verarbeitet
            <span className="font-normal text-muted-foreground tabular-nums">{recent.length}</span>
          </summary>
          <ul aria-label="Zuletzt verarbeitete Dateien" className="mt-2 divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70">
            {recent.map((entry) => (
              <li key={`${entry.name}-${entry.at}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <div className="min-w-0 flex-1 basis-52">
                  <p className="truncate" title={entry.name}>{entry.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[DRIVE_FOLDER_NAMES[entry.kind], timeFormat.format(entry.at), entry.note].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <Badge variant={outcomeBadge[entry.outcome].variant}>{outcomeBadge[entry.outcome].label}</Badge>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
