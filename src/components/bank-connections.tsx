"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, Link2, Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAccountWorkspace } from "@/components/account-context";
import { useFinance } from "@/components/finance-provider";
import { SettingsSection } from "@/components/settings-section";
import { FinancialData } from "@/components/financial-data";
import { currency, dateLabel } from "@/lib/format";
import type { BankChoice, BankConnectStart, BankStatus } from "@/lib/banking/sync";

const XS2A_ORIGIN = "https://api.xs2a.com";
type Xs2aWidget = {
  useBaseStyles(): void;
  finish(callback: () => void): void;
  abort(callback: () => void): void;
  error(callback: (code: string, messages: string[], recoverable: boolean) => void): void;
  init(): void;
};
declare global {
  interface Window { xs2a?: Xs2aWidget }
}

let widgetScript: Promise<Xs2aWidget> | null = null;
function loadWidget(): Promise<Xs2aWidget> {
  if (window.xs2a) return Promise.resolve(window.xs2a);
  widgetScript ??= new Promise<Xs2aWidget>((resolve, reject) => {
    for (const sheet of ["xs2a.css", "xs2a-responsive.css"]) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `${XS2A_ORIGIN}/${sheet}`;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = `${XS2A_ORIGIN}/xs2a.js`;
    script.async = true;
    script.onload = () => window.xs2a ? resolve(window.xs2a) : reject(new Error("XS2A-Widget nicht verfügbar."));
    script.onerror = () => { widgetScript = null; reject(new Error("Das Bank-Widget konnte nicht geladen werden.")); };
    document.head.appendChild(script);
  });
  return widgetScript;
}

function BankWizard({ sessionKey, onDone, onClose }: { sessionKey: string; onDone: () => void; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    loadWidget().then((xs2a) => {
      if (!active || !container.current) return;
      container.current.innerHTML = "";
      const form = document.createElement("div");
      form.id = "XS2A-Form";
      form.dataset.xs2a = sessionKey;
      container.current.appendChild(form);
      xs2a.useBaseStyles();
      xs2a.finish(() => { if (active) onDone(); });
      xs2a.abort(() => { if (active) onClose(); });
      xs2a.error((_code, messages, recoverable) => {
        if (active && !recoverable) setError(messages.join(" ") || "Die Bankanmeldung ist fehlgeschlagen.");
      });
      xs2a.init();
    }).catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : "Widget-Fehler"));
    return () => { active = false; };
  }, [sessionKey, onDone, onClose]);
  return <div className="min-h-64">
    {error && <p role="alert" className="mb-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <div ref={container} className="xs2a-host text-sm" />
  </div>;
}

async function request(account: string, init: RequestInit & { json?: unknown } = {}, query = ""): Promise<unknown> {
  const response = await fetch(`/api/bank${query}`, {
    ...init,
    credentials: "same-origin",
    headers: { "X-Finanzblick-Account": account, ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Die Bankverbindung ist nicht erreichbar.");
  return body;
}

export function BankConnections() {
  const workspace = useAccountWorkspace();
  const { state } = useFinance();
  const account = workspace?.user.id ?? null;
  const [status, setStatus] = useState<BankStatus | null>(null);
  const [busy, setBusy] = useState<"connect" | "sync" | string | null>(null);
  const [wizard, setWizard] = useState<string | null>(null);
  const [country, setCountry] = useState("AT");
  const [bic, setBic] = useState("");
  const [banks, setBanks] = useState<BankChoice[] | null>(null);
  const [aspsp, setAspsp] = useState("");
  const enableBanking = status?.provider === "enablebanking";

  useEffect(() => {
    if (!account || !enableBanking) return;
    let active = true;
    request(account, {}, `?banks=${country}`).then(
      (body) => active && setBanks((body as { banks: BankChoice[] }).banks),
      (error: unknown) => { if (active) { setBanks([]); toast.error(error instanceof Error ? error.message : "Bankliste nicht verfügbar."); } },
    );
    return () => { active = false; };
  }, [account, enableBanking, country]);

  const load = useCallback(async () => {
    if (!account) return;
    try { setStatus(await request(account) as BankStatus); } catch { setStatus(null); }
  }, [account]);
  useEffect(() => {
    if (!account) return;
    let active = true;
    request(account).then((body) => active && setStatus(body as BankStatus), () => active && setStatus(null));
    return () => { active = false; };
  }, [account]);

  const sync = useCallback(async () => {
    if (!account) return;
    setBusy("sync");
    try {
      const result = await request(account, { method: "POST", json: { action: "sync" } }) as BankStatus & { rows: number; queued: boolean };
      setStatus(result);
      toast.success(result.queued ? `${result.rows} Bankumsätze geladen – werden jetzt einsortiert.` : "Keine neuen Bankumsätze.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Bankabruf fehlgeschlagen.");
      void load();
    } finally { setBusy(null); }
  }, [account, load]);

  const start = async (json: unknown) => {
    if (!account) return;
    setBusy("connect");
    try {
      const result = await request(account, { method: "POST", json }) as BankConnectStart;
      if ("redirectUrl" in result) {
        window.location.assign(result.redirectUrl);
        return;
      }
      setWizard(result.wizardSessionKey);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verbindung konnte nicht gestartet werden.");
    } finally { setBusy(null); }
  };
  const finished = useCallback(() => { setWizard(null); toast.success("Bank verbunden. Umsätze werden abgerufen …"); void sync(); }, [sync]);
  const closed = useCallback(() => setWizard(null), []);

  // Return from the bank's own login page (Enable Banking redirect flow).
  const returned = useRef(false);
  useEffect(() => {
    if (!account || returned.current) return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get("bank");
    if (!result) return;
    returned.current = true;
    const message = params.get("message");
    params.delete("bank");
    params.delete("message");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    queueMicrotask(() => {
      if (result === "connected") {
        toast.success("Bank verbunden. Umsätze werden abgerufen …");
        void sync();
      } else {
        toast.error(message || "Die Bankverbindung wurde nicht abgeschlossen.");
        void load();
      }
    });
  }, [account, sync, load]);

  const remove = async (id: string, name: string) => {
    if (!account || !window.confirm(`Verbindung zu ${name} wirklich trennen? Bereits importierte Umsätze bleiben erhalten.`)) return;
    setBusy(id);
    try {
      setStatus(await request(account, { method: "DELETE" }, `?connection=${encodeURIComponent(id)}`) as BankStatus);
      toast.success("Bankverbindung getrennt.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Trennen fehlgeschlagen.");
    } finally { setBusy(null); }
  };

  if (!workspace) return null;
  const configured = status?.configured ?? false;
  const normalizedBic = bic.replace(/\s/g, "").toUpperCase();
  const bicValid = !normalizedBic || /^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(normalizedBic);
  const aspspValid = !enableBanking || (banks ?? []).some((bank) => bank.name === aspsp);
  return <SettingsSection id="bankverbindung" title="Bankverbindung" icon={Building2}
    description={`Konten direkt über die PSD2-Bankschnittstelle${status?.provider ? ` (${enableBanking ? "Enable Banking" : "FinTecSystems XS2A / Tink"})` : ""} verbinden. Neue Umsätze kommen automatisch alle 6 Stunden.`}
    action={configured && status?.connections.length ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void sync()}>
      {busy === "sync" ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="size-4" />}Jetzt abrufen
    </Button> : undefined}>
    {!status ? <p className="text-sm text-muted-foreground">Status wird geladen …</p> : !configured ? (
      <div className="rounded-2xl border border-border/70 bg-muted/15 p-4 text-sm leading-relaxed sm:p-5">
        <p className="font-medium">Noch nicht eingerichtet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Für Privatpersonen kostenlos über <strong>Enable Banking</strong>: Auf enablebanking.com eine App registrieren, eigene Konten verknüpfen
          und dann <code className="rounded bg-muted px-1">ENABLEBANKING_APP_ID</code> sowie <code className="rounded bg-muted px-1">ENABLEBANKING_PRIVATE_KEY_PATH</code> in
          {" "}<code className="rounded bg-muted px-1">.env.local</code> eintragen (Anleitung in der README). Alternativ mit Firmenvertrag:
          {" "}<code className="rounded bg-muted px-1">XS2A_API_KEY</code> von Tink. Danach Finanzblick neu starten.
          Bis dahin funktioniert der Import per CSV, PDF oder Screenshot wie gewohnt.
        </p>
      </div>
    ) : <FinancialData>
      <div className="space-y-4">
        {status.connections.length > 0 && <ul className="space-y-3">
          {status.connections.map((connection) => {
            const name = connection.bankName ?? connection.bic ?? "Bank";
            const accounts = status.accounts.filter((entry) => entry.connectionId === connection.id);
            const consent = connection.consentValidUntil?.slice(0, 10) ?? null;
            const expiresSoon = consent !== null && consent <= new Date(Date.parse(`${state.settings.asOf}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
            return <li key={connection.id} className="rounded-2xl border border-border/70 bg-muted/15 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium"><Link2 aria-hidden="true" className="size-4 text-primary" />{name}{connection.testmode && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">Testmodus</span>}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {connection.syncActive === false ? `Abruf pausiert${connection.message ? `: ${connection.message}` : ""}` : "Automatischer Abruf aktiv"}
                    {consent && <> · Freigabe bis {dateLabel(consent)}</>}
                  </p>
                  {expiresSoon && <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">Die Bankfreigabe läuft bald ab – bitte erneuern.</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void start({ action: "renew", connection: connection.id })}><RotateCcw aria-hidden="true" className="size-4" />Freigabe erneuern</Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null} aria-label={`${name} trennen`} onClick={() => void remove(connection.id, name)}><Trash2 aria-hidden="true" className="size-4" /></Button>
                </div>
              </div>
              {accounts.length > 0 && <ul className="mt-3 divide-y divide-border/60 rounded-xl border border-border/60 bg-background/40">
                {accounts.map((entry) => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                  <span className="min-w-0"><span className="font-medium">{entry.label}</span>{entry.iban && <span className="ml-2 text-muted-foreground tabular-nums">{entry.iban}</span>}<span className="ml-2 text-muted-foreground">→ {entry.bank}{entry.pocket ? ` · ${entry.pocket}` : ""}</span></span>
                  {entry.balance !== null && <span className="font-semibold tabular-nums">{currency(entry.balance)}</span>}
                </li>)}
              </ul>}
            </li>;
          })}
        </ul>}
        <form className="grid gap-3 rounded-2xl border border-dashed border-border/80 p-4 sm:grid-cols-[8rem_1fr_auto] sm:items-end" onSubmit={(event) => {
          event.preventDefault(); if (!bicValid || !aspspValid) return;
          void start(enableBanking ? { action: "connect", country, aspsp } : { action: "connect", country, ...(normalizedBic ? { bic: normalizedBic } : {}) });
        }}>
          <label className="text-xs font-medium">Land
            <select aria-label="Land der Bank" className="mt-2 h-11 w-full rounded-md border border-input bg-background/50 px-3 text-sm" value={country} onChange={(event) => { setCountry(event.target.value); setAspsp(""); }}>
              <option value="AT">Österreich</option><option value="DE">Deutschland</option>
            </select>
          </label>
          {enableBanking ? <label className="text-xs font-medium">Bank {banks === null && "(wird geladen …)"}
            <Input aria-label="Bank auswählen" aria-invalid={aspsp !== "" && !aspspValid} list="bank-choices" className="mt-2 h-11 bg-background/50" placeholder="Bank suchen, z. B. Raiffeisen" maxLength={200} value={aspsp} onChange={(event) => setAspsp(event.target.value)} />
            <datalist id="bank-choices">{(banks ?? []).map((bank) => <option key={bank.name} value={bank.name} />)}</datalist>
          </label> : <label className="text-xs font-medium">BIC (optional – sonst im Fenster suchen)
            <Input aria-label="BIC der Bank" aria-invalid={!bicValid} className="mt-2 h-11 bg-background/50 uppercase" placeholder="z. B. RZKTAT2K" maxLength={14} value={bic} onChange={(event) => setBic(event.target.value)} />
          </label>}
          <Button type="submit" className="h-11" disabled={busy !== null || !bicValid || !aspspValid}>
            {busy === "connect" ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Link2 aria-hidden="true" className="size-4" />}Bank verbinden
          </Button>
        </form>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {enableBanking
            ? "Du wirst zur Anmeldeseite deiner Bank weitergeleitet und kommst danach automatisch zurück – Finanzblick sieht deine Zugangsdaten nie."
            : "Die Anmeldung läuft direkt im gesicherten Fenster der Bank-Schnittstelle – Finanzblick sieht deine Zugangsdaten nie."}
          Bereits per CSV importierte Tage werden übersprungen, doppelte Buchungen erkannt.
          {status.lastSync && <> Letzter Abruf: {new Date(status.lastSync).toLocaleString("de-AT")}{status.lastSyncRows !== null && ` (${status.lastSyncRows} Umsätze)`}.</>}
        </p>
        {status.lastError && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">Letzter Abruf fehlgeschlagen: {status.lastError}</p>}
      </div>
    </FinancialData>}
    <Dialog open={wizard !== null} onOpenChange={(open) => { if (!open) setWizard(null); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Bank verbinden</DialogTitle>
          <DialogDescription>Melde dich wie im Online-Banking an und bestätige die Freigabe in deiner Bank-App.</DialogDescription>
        </DialogHeader>
        {wizard && <BankWizard sessionKey={wizard} onDone={finished} onClose={closed} />}
      </DialogContent>
    </Dialog>
  </SettingsSection>;
}
