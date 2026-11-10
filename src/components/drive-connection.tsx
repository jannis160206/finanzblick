"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderSync, Loader2, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { useAccountWorkspace } from "@/components/account-context";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import { accountRequest } from "@/lib/account-request";
import { navigate } from "@/lib/browser-navigation";
import type { DriveStatus } from "@/lib/drive/store";
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
const timeFormat = new Intl.DateTimeFormat("de-AT", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

export function DriveConnection() {
  const workspace = useAccountWorkspace();
  const account = workspace?.user.id ?? null;
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<"connect" | "remove" | null>(null);
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
            <div className="min-w-0 flex-1">
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
            {status.configured && (!connected || expired) && (
              <Button size="sm" disabled={!!busy} onClick={() => { void connect(); }}>
                {busy === "connect" ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : expired ? <RefreshCw aria-hidden="true" className="size-4" /> : <FolderSync aria-hidden="true" className="size-4" />}
                {expired ? "Erneut verbinden" : "Mit Google verbinden"}
              </Button>
            )}
          </div>
          {expired && <p className="text-xs leading-relaxed text-muted-foreground">Im Google-Testmodus gilt eine Freigabe sieben Tage. Danach einmal erneut verbinden; bereits importierte Dateien werden nicht doppelt übernommen.</p>}
          {status.lastError && !expired && <p role="alert" className="text-sm text-destructive">{status.lastError}</p>}
          {notice && !notice.ok && <p role="alert" className="text-sm text-destructive">{notice.text}</p>}
          <details className="group text-xs text-muted-foreground">
            <summary className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-md font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              Einrichtung
              <InfoTip label="Google-Testmodus">Solange die App in der Google Cloud im Testmodus ist, laufen Freigaben nach sieben Tagen ab und nur eingetragene Testnutzer können sich verbinden.</InfoTip>
            </summary>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 leading-relaxed">
              <li>In der Google Cloud Console die <strong className="font-medium text-foreground">Google Drive API</strong> aktivieren und dein Google-Konto als Testnutzer eintragen.</li>
              <li>Als autorisierte Weiterleitungs-URI eintragen: <code className="break-all rounded bg-muted px-1.5 py-0.5 text-foreground">{redirectUri}</code></li>
              <li><code className="rounded bg-muted px-1 py-0.5">GOOGLE_CLIENT_ID</code> und <code className="rounded bg-muted px-1 py-0.5">GOOGLE_CLIENT_SECRET</code> in der privaten Umgebungsdatei des Servers setzen und neu starten.</li>
            </ol>
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
