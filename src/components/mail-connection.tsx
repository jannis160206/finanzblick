"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Mail, RefreshCw, ShoppingBag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccountWorkspace } from "@/components/account-context";
import { SettingsSection } from "@/components/settings-section";
import { FinancialData } from "@/components/financial-data";
import { currency, dateLabel } from "@/lib/format";
import type { MailStatus, MailSyncResult } from "@/lib/mail/sync";

async function request(account: string, init: RequestInit & { json?: unknown } = {}): Promise<unknown> {
  const response = await fetch("/api/mail", {
    ...init,
    credentials: "same-origin",
    headers: { "X-Finanzblick-Account": account, ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Die E-Mail-Anbindung ist nicht erreichbar.");
  return body;
}

const statusLabel = { open: "offen", paid: "bezahlt", cancelled: "storniert", expired: "abgelaufen", dismissed: "ausgeblendet" } as const;
const statusTone = {
  open: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
  paid: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
  cancelled: "bg-muted text-muted-foreground",
  expired: "bg-muted text-muted-foreground",
  dismissed: "bg-muted text-muted-foreground",
} as const;
const methodLabel = { card: "Karte", paypal: "PayPal", klarna: "Klarna", invoice: "Rechnung", unknown: "" } as const;

function summary(result: MailSyncResult): string {
  const parts = [`${result.scanned} neue Mail${result.scanned === 1 ? "" : "s"} geprüft`];
  if (result.added) parts.push(`${result.added} Bestellung${result.added === 1 ? "" : "en"} vorgemerkt`);
  if (result.paid) parts.push(`${result.paid} als bezahlt erkannt`);
  if (result.cancelled) parts.push(`${result.cancelled} storniert`);
  return `${parts.join(" · ")}.`;
}

export function MailConnection() {
  const workspace = useAccountWorkspace();
  const account = workspace?.user.id ?? null;
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [busy, setBusy] = useState<"connect" | "sync" | "remove" | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    if (!account) return;
    try { setStatus(await request(account) as MailStatus); } catch { setStatus({ connected: false, orders: [] }); }
  }, [account]);
  useEffect(() => {
    if (!account) return;
    let active = true;
    request(account).then((body) => active && setStatus(body as MailStatus), () => active && setStatus({ connected: false, orders: [] }));
    return () => { active = false; };
  }, [account]);

  const run = async (kind: "connect" | "sync") => {
    if (!account) return;
    setBusy(kind);
    try {
      const result = await request(account, { method: "POST", json: kind === "connect" ? { action: "connect", email, password } : { action: "sync" } }) as MailSyncResult;
      setStatus(result);
      if (kind === "connect") { setPassword(""); toast.success(`Gmail verbunden. ${summary(result)}`); } else toast.success(summary(result));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Gmail-Abruf fehlgeschlagen.");
      void load();
    } finally { setBusy(null); }
  };

  const remove = async () => {
    if (!account || !window.confirm("Gmail-Verbindung trennen? Offene vorgemerkte Bestellungen werden aus der Planung entfernt.")) return;
    setBusy("remove");
    try {
      setStatus(await request(account, { method: "DELETE" }) as MailStatus);
      toast.success("Gmail getrennt.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Trennen fehlgeschlagen.");
    } finally { setBusy(null); }
  };

  if (!workspace) return null;
  const open = status?.orders.filter((order) => order.status === "open") ?? [];
  return <SettingsSection id="email" title="E-Mail-Bestellungen" icon={Mail}
    description="Bestellbestätigungen aus Gmail erkennen und als kommende Zahlung vormerken – inklusive Klarna, PayPal und Rechnung. Abruf alle 6 Stunden."
    action={status?.connected ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run("sync")}>
      {busy === "sync" ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="size-4" />}Jetzt prüfen
    </Button> : undefined}>
    {!status ? <p className="text-sm text-muted-foreground">Status wird geladen …</p> : !status.connected ? (
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void run("connect"); }}>
        <div className="rounded-2xl border border-border/70 bg-muted/15 p-4 text-xs leading-relaxed text-muted-foreground sm:p-5">
          <p className="text-sm font-medium text-foreground">So richtest du es ein</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>Google-Konto → Sicherheit → <strong>Bestätigung in zwei Schritten</strong> aktivieren.</li>
            <li>Unter <a className="text-primary underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">App-Passwörter</a> ein Passwort „Finanzblick“ erstellen (16 Zeichen).</li>
            <li>In Gmail → Einstellungen → Weiterleitung und POP/IMAP prüfen, dass <strong>IMAP aktiviert</strong> ist.</li>
          </ol>
          <p className="mt-2">Finanzblick liest nur lesend Bestell- und Zahlungsmails auf diesem Rechner. Nichts wird markiert, gelöscht oder weitergegeben.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm"><span className="font-medium">Gmail-Adresse</span>
            <Input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@gmail.com" /></label>
          <label className="space-y-1 text-sm"><span className="font-medium">App-Passwort</span>
            <Input type="password" autoComplete="off" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="xxxx xxxx xxxx xxxx" /></label>
        </div>
        <Button type="submit" disabled={busy !== null || !email || password.replace(/\s/g, "").length < 8}>
          {busy === "connect" ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Mail aria-hidden="true" className="size-4" />}Gmail verbinden
        </Button>
      </form>
    ) : <FinancialData>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border/70 bg-muted/15 p-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium"><Mail aria-hidden="true" className="size-4 text-primary" />{status.email}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {status.lastSync ? `Zuletzt geprüft ${new Date(status.lastSync).toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" })}` : "Noch nicht geprüft"}
              {` · ${open.length} offene Bestellung${open.length === 1 ? "" : "en"} in der Planung`}
            </p>
            {status.lastError && <p role="alert" className="mt-2 text-xs font-medium text-destructive">{status.lastError}</p>}
          </div>
          <Button size="sm" variant="ghost" disabled={busy !== null} aria-label="Gmail trennen" onClick={() => void remove()}><Trash2 aria-hidden="true" className="size-4" /></Button>
        </div>
        {status.orders.length > 0 ? <ul className="divide-y divide-border/60 rounded-xl border border-border/60 bg-background/40">
          {status.orders.map((order) => <li key={order.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate font-medium"><ShoppingBag aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />{order.shop}{order.product ? ` · ${order.product}` : ""}</p>
              <p className="text-xs text-muted-foreground">
                Bestellt {dateLabel(order.orderDate)} · fällig {dateLabel(order.dueDate)}
                {methodLabel[order.method] ? ` · ${methodLabel[order.method]}` : ""}{order.installments > 1 ? ` · ${order.installments} Raten` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="tabular-nums">{currency(order.amount)}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone[order.status]}`}>{statusLabel[order.status]}</span>
            </div>
          </li>)}
        </ul> : <p className="text-sm text-muted-foreground">Noch keine Bestellungen erkannt. Neue Bestellbestätigungen erscheinen hier und als geplante Zahlung.</p>}
        <p className="text-xs text-muted-foreground">Bezahlte Bestellungen werden automatisch mit dem Bankumsatz abgeglichen, Stornos entfernt. Vorgemerkte Zahlungen kannst du in der Planung löschen – sie kommen dann nicht wieder.</p>
      </div>
    </FinancialData>}
  </SettingsSection>;
}
