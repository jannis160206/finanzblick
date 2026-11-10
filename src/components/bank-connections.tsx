"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, ChevronDown, Landmark, Loader2, MoreHorizontal, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DialogSkeleton } from "@/components/ui/premium-dialog";
import { AddBankDialog, type BankCountry } from "@/components/bank-picker";
import { BankLogo } from "@/components/bank-logo";
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
  const [country, setCountry] = useState<BankCountry>("AT");
  const [loaded, setLoaded] = useState<{ country: BankCountry; banks: BankChoice[] } | null>(null);
  const banks = loaded?.country === country ? loaded.banks : null;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const enableBanking = status?.provider === "enablebanking";

  useEffect(() => {
    if (!account || !enableBanking || !adding) return;
    let active = true;
    request(account, {}, `?banks=${country}`).then(
      (body) => active && setLoaded({ country, banks: (body as { banks: BankChoice[] }).banks }),
      (error: unknown) => { if (active) { setLoaded({ country, banks: [] }); toast.error(error instanceof Error ? error.message : "Bankliste nicht verfügbar."); } },
    );
    return () => { active = false; };
  }, [account, enableBanking, country, adding]);

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
      setAdding(false);
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

  const remove = async (id: string) => {
    if (!account) return;
    setRemoving(null);
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
  const connections = status?.connections ?? [];
  const asOf = Date.parse(`${state.settings.asOf}T00:00:00Z`);
  return <SettingsSection id="bankverbindung" title="Bankverbindung" icon={Building2}
    description="Verbundene Konten werden etwa alle 6 Stunden abgerufen. Bereits importierte Tage werden übersprungen, doppelte Buchungen erkannt."
    action={configured ? <div className="flex gap-2">
      {connections.length > 0 && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void sync()} aria-label="Jetzt abrufen">
        {busy === "sync" ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="size-4" />}<span className="max-sm:hidden">Jetzt abrufen</span>
      </Button>}
      <Button size="sm" disabled={busy !== null} onClick={() => setAdding(true)}><Plus aria-hidden="true" className="size-4" />Bank hinzufügen</Button>
    </div> : undefined}>
    {!status ? <DialogSkeleton rows={2} label="Status wird geladen …" /> : !configured ? (
      <div className="rounded-2xl border border-dashed border-border/80 p-4 text-sm sm:p-5">
        <p className="font-medium">Bankanbindung noch nicht eingerichtet</p>
        <p className="mt-1 text-xs text-muted-foreground">Bis dahin funktioniert der Import per CSV, PDF oder Screenshot wie gewohnt.</p>
        <details className="group mt-3 text-xs leading-relaxed text-muted-foreground">
          <summary className="inline-flex min-h-9 cursor-pointer items-center gap-1 font-medium text-foreground">
            <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180" />So richtest du sie ein
          </summary>
          <p className="mt-2">
            Für Privatpersonen kostenlos über <strong>Enable Banking</strong>: Auf enablebanking.com eine App registrieren, eigene Konten verknüpfen
            und dann <code className="rounded bg-muted px-1">ENABLEBANKING_APP_ID</code> sowie <code className="rounded bg-muted px-1">ENABLEBANKING_PRIVATE_KEY_PATH</code> in
            {" "}<code className="rounded bg-muted px-1">.env.local</code> eintragen (Anleitung in der README). Alternativ mit Firmenvertrag:
            {" "}<code className="rounded bg-muted px-1">XS2A_API_KEY</code> von Tink. Danach Finanzblick neu starten.
          </p>
        </details>
      </div>
    ) : <FinancialData>
      <div className="space-y-4">
        {connections.length === 0 && <div className="flex flex-col items-center rounded-2xl border border-dashed border-border/80 px-4 py-8 text-center">
          <span aria-hidden="true" className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-accent-muted text-primary"><Landmark className="size-5" /></span>
          <p className="text-sm font-medium">Noch keine Bank verbunden</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">Neue Umsätze kommen dann automatisch, ohne CSV-Export.</p>
          <Button size="sm" variant="outline" className="mt-4" onClick={() => setAdding(true)}><Plus aria-hidden="true" className="size-4" />Bank hinzufügen</Button>
        </div>}
        {connections.length > 0 && <ul className="space-y-3">
          {connections.map((connection) => {
            const name = connection.bankName ?? connection.bic ?? "Bank";
            const accounts = status.accounts.filter((entry) => entry.connectionId === connection.id);
            const main = accounts.find((entry) => entry.label === "Persönliches Konto") ?? accounts.find((entry) => entry.pocket === "Persönliches Konto") ?? accounts[0];
            const others = accounts.filter((entry) => entry !== main && entry.balance !== 0);
            const open = expanded[connection.id] === true;
            const consent = connection.consentValidUntil?.slice(0, 10) ?? null;
            const daysLeft = consent === null ? null : Math.round((Date.parse(`${consent}T00:00:00Z`) - asOf) / 86_400_000);
            const expiresSoon = daysLeft !== null && daysLeft <= 14;
            const paused = connection.syncActive === false;
            const renew = () => void start({ action: "renew", connection: connection.id });
            return <li key={connection.id} className="overflow-hidden rounded-2xl border border-border/70 bg-background/40">
              <div className="flex items-center gap-3 p-4">
                <BankLogo bank={name} country={connection.country ?? country} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words text-sm font-semibold">{name}</span>
                    {paused ? <Badge variant="destructive">Pausiert</Badge>
                      : expiresSoon ? <Badge variant="warning">{daysLeft <= 0 ? "Freigabe abgelaufen" : `Freigabe endet in ${daysLeft} ${daysLeft === 1 ? "Tag" : "Tagen"}`}</Badge>
                        : <Badge variant="success">Aktiv</Badge>}
                    {connection.testmode && <Badge variant="outline">Testmodus</Badge>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {paused && connection.message ? connection.message : [
                      consent && `Freigabe bis ${dateLabel(consent)}`,
                      connection.lastSynced && `geprüft ${ago(Date.parse(connection.lastSynced))}`,
                    ].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {(expiresSoon || paused) && <Button size="sm" variant="outline" className="max-sm:hidden" disabled={busy !== null}
                  aria-label={`${name}: Freigabe erneuern`} onClick={renew}><RotateCcw aria-hidden="true" className="size-4" />Erneuern</Button>}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="size-11 shrink-0 text-muted-foreground" disabled={busy !== null} aria-label={`${name}: Aktionen`}>
                      <MoreHorizontal aria-hidden="true" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={renew}><RotateCcw />Freigabe erneuern</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive data-[highlighted]:bg-destructive/10" onSelect={() => setRemoving({ id: connection.id, name })}>
                      <Trash2 />Trennen
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {!main && <p role="status" className="mx-4 mb-4 flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning">
                <span aria-hidden="true" className="mt-1 size-2 shrink-0 rounded-full bg-warning" />
                <span>Keine Konten abrufbar – {paused ? connection.message ?? "Freigabe nicht aktiv." : connection.message ?? "die Bank hat bei der Freigabe kein Konto geteilt."}</span>
              </p>}
              {main && <ul className="divide-y divide-border/60 border-t border-border/60">
                {[main, ...(open ? others : [])].map((entry) => <Tooltip key={entry.id} className="w-72 max-w-[90vw]" label={<AccountSyncInfo entry={entry} connection={connection} lastSync={status.lastSync} lastError={status.lastError} />}>
                  <li tabIndex={0} className="flex min-h-14 cursor-default items-center justify-between gap-3 px-4 py-2.5 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                    <span className="flex min-w-0 items-center">
                      <SyncDot state={syncState(entry, connection)} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{entry.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {entry.iban && <span className="tabular-nums">{maskIban(entry.iban)} · </span>}→ {entry.pocket ?? entry.bank}
                        </span>
                      </span>
                    </span>
                    {entry.balance !== null && <span className="shrink-0 text-sm font-semibold tabular-nums">{currency(entry.balance)}</span>}
                  </li>
                </Tooltip>)}
                {others.length > 0 && <li>
                  <button type="button" aria-expanded={open} className="flex min-h-11 w-full items-center gap-1 px-4 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setExpanded((current) => ({ ...current, [connection.id]: !open }))}>
                    <ChevronDown aria-hidden="true" className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
                    {open ? "Weniger anzeigen" : `${others.length} ${others.length === 1 ? "weiteres Konto" : "weitere Konten"}`}
                  </button>
                </li>}
              </ul>}
            </li>;
          })}
        </ul>}
        {status.lastSync && <p className="text-xs text-muted-foreground">
          Zuletzt abgerufen {ago(status.lastSync)}{status.lastSyncRows !== null && ` · ${status.lastSyncRows} Umsätze`}
        </p>}
        {status.lastError && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">Letzter Abruf fehlgeschlagen: {status.lastError}</p>}
      </div>
    </FinancialData>}
    {configured && <AddBankDialog open={adding} onOpenChange={setAdding} provider={enableBanking ? "enablebanking" : "xs2a"}
      country={country} onCountryChange={setCountry} banks={banks} busy={busy === "connect"}
      onConnect={(choice) => void start({ action: "connect", country, ...choice })} />}
    <Dialog open={removing !== null} onOpenChange={(next) => { if (!next) setRemoving(null); }}>
      <DialogContent variant="confirmation">
        <DialogHeader>
          <DialogTitle>{removing?.name} trennen?</DialogTitle>
          <DialogDescription>Neue Umsätze kommen dann nicht mehr automatisch. Bereits importierte Umsätze bleiben erhalten.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Abbrechen</Button></DialogClose>
          <Button variant="destructive" onClick={() => { if (removing) void remove(removing.id); }}>Trennen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

/** "AT61 1904 3002 3457 3201" → "AT61 •••• 3201". */
function maskIban(iban: string) {
  const compact = iban.replace(/\s/g, "");
  return compact.length > 8 ? `${compact.slice(0, 4)} •••• ${compact.slice(-4)}` : iban;
}

type BankAccountEntry = BankStatus["accounts"][number];
type BankConnectionEntry = BankStatus["connections"][number];
type SyncState = "ok" | "warn" | "error" | "none";
const AUTO_SYNC_MS = 6 * 3_600_000;

function accountSyncedAt(entry: BankAccountEntry, connection: BankConnectionEntry): number | null {
  if (entry.syncedAt) return entry.syncedAt;
  const fallback = connection.lastSynced ? Date.parse(connection.lastSynced) : NaN;
  return Number.isFinite(fallback) ? fallback : null;
}

function syncState(entry: BankAccountEntry, connection: BankConnectionEntry): SyncState {
  if (entry.syncError?.startsWith("Tageslimit")) return "warn";
  if (entry.syncError || connection.syncActive === false) return "error";
  if (!accountSyncedAt(entry, connection)) return "none";
  return entry.balanceOk === false ? "warn" : "ok";
}

const dotTone: Record<SyncState, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", error: "bg-destructive", none: "bg-muted-foreground/50" };
const stateText: Record<SyncState, string> = { ok: "Bank-API funktioniert", warn: "Teilweise abgerufen", error: "Abruf fehlgeschlagen", none: "Noch nicht abgerufen" };

function SyncDot({ state }: { state: SyncState }) {
  return <span aria-label={stateText[state]} role="img" className={`mr-2 inline-block size-2 shrink-0 rounded-full ${dotTone[state]}`} />;
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `vor ${hours} Std.` : `vor ${Math.round(hours / 24)} Tagen`;
}

const timeLabel = (ms: number) => new Date(ms).toLocaleString("de-AT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function AccountSyncInfo({ entry, connection, lastSync, lastError }: { entry: BankAccountEntry; connection: BankConnectionEntry; lastSync: number | null; lastError: string | null }) {
  const state = syncState(entry, connection);
  const syncedAt = accountSyncedAt(entry, connection);
  const error = entry.syncError ?? (connection.syncActive === false ? connection.message ?? lastError : null);
  const rows: [string, string][] = [];
  rows.push(["Letzter erfolgreicher Abruf", syncedAt ? `${timeLabel(syncedAt)} (${ago(syncedAt)})` : "noch keiner"]);
  if (lastSync && lastSync !== syncedAt) rows.push(["Letzter Versuch", `${timeLabel(lastSync)} (${ago(lastSync)})`]);
  if (entry.fetchedRows !== null && entry.fetchedRows !== undefined) rows.push(["Buchungen im Abruf", String(entry.fetchedRows)]);
  rows.push(["Kontostand", entry.balance === null ? "nicht geliefert" : `${currency(entry.balance)}${entry.balanceDate ? ` · Stand ${dateLabel(entry.balanceDate.slice(0, 10))}` : ""}`]);
  if (entry.available !== null && entry.balance !== null && Math.abs(entry.available - entry.balance) >= 0.005) rows.push(["Verfügbar", currency(entry.available)]);
  if (connection.syncActive !== false && lastSync) rows.push(["Nächster Auto-Abruf", `ca. ${timeLabel(lastSync + AUTO_SYNC_MS)}`]);
  return <div className="space-y-2">
    <p className="flex items-center text-sm font-semibold"><SyncDot state={state} />{stateText[state]}</p>
    {error && <p className="rounded-md bg-destructive/10 px-2 py-1 text-destructive">{error}</p>}
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}
    </dl>
    <p className="text-[11px] text-muted-foreground">{connection.bankName ?? entry.bank} · PSD2-Bankschnittstelle</p>
  </div>;
}
