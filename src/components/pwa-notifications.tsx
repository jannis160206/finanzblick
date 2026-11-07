"use client";

import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import { Bell } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { detectNotificationEvents, type NotificationEvent } from "@/lib/notifications";

export const NOTIFICATION_SETTINGS_KEY = "finanzblick.notifications.v1";
export const NOTIFIED_KEY = "finanzblick.notified.v1";
const CHANGE_EVENT = "finanzblick-notifications-change";
const MAX_NOTIFIED = 500;
const DEFAULT_LARGE_DEBIT = 200;

export type NotificationPreferences = {
  enabled: boolean;
  largeDebit: number;
  /** Datum (YYYY-MM-DD), ab dem Abbuchungen gemeldet werden; wird beim Aktivieren gesetzt. */
  since?: string;
};
const defaults: NotificationPreferences = { enabled: false, largeDebit: DEFAULT_LARGE_DEBIT };

function readRaw(): string | null {
  try { return localStorage.getItem(NOTIFICATION_SETTINGS_KEY); } catch { return null; }
}
function parsePreferences(raw: string | null): NotificationPreferences {
  if (!raw) return defaults;
  try {
    const value = JSON.parse(raw) as Partial<NotificationPreferences>;
    const largeDebit = typeof value.largeDebit === "number" && Number.isFinite(value.largeDebit) && value.largeDebit > 0
      ? value.largeDebit : DEFAULT_LARGE_DEBIT;
    const since = typeof value.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.since) ? value.since : undefined;
    return { enabled: value.enabled === true, largeDebit, ...(since ? { since } : {}) };
  } catch { return defaults; }
}
function writePreferences(next: NotificationPreferences) {
  try { localStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(next)); } catch { /* Speicher nicht verfügbar */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === NOTIFICATION_SETTINGS_KEY) callback(); };
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(CHANGE_EVENT, callback); window.removeEventListener("storage", onStorage); };
}
function usePreferences(): NotificationPreferences {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  return parsePreferences(raw);
}

const supported = () => typeof window !== "undefined" && "Notification" in window;
const permission = (): NotificationPermission | "unsupported" => supported() ? Notification.permission : "unsupported";
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const daysBefore = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
};

function readNotified(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}
function writeNotified(ids: string[]) {
  try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(ids.slice(-MAX_NOTIFIED))); } catch { /* Speicher nicht verfügbar */ }
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator)) return undefined;
  try { return await navigator.serviceWorker.getRegistration("/") ?? undefined; } catch { return undefined; }
}

async function showNotification(event: Pick<NotificationEvent, "id" | "title" | "body" | "url">): Promise<boolean> {
  if (permission() !== "granted") return false;
  const options: NotificationOptions = { body: event.body, tag: event.id, icon: "/icon.svg", badge: "/icon.svg", data: { url: event.url } };
  const worker = await registration();
  if (worker) {
    try { await worker.showNotification(event.title, options); return true; } catch { /* Fallback unten */ }
  }
  try {
    const notification = new Notification(event.title, options);
    notification.onclick = () => { window.focus(); window.location.assign(event.url); notification.close(); };
    return true;
  } catch { return false; }
}

export function PwaNotifications() {
  const { state, dashboard, ready } = useFinance();
  const preferences = usePreferences();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!ready || !preferences.enabled || permission() !== "granted") return;
    const asOf = state.settings.asOf;
    const events = detectNotificationEvents(state, dashboard, {
      asOf, largeDebitThreshold: preferences.largeDebit,
      sinceDate: daysBefore(preferences.since ?? asOf, 7),
    });
    const notified = new Set(readNotified());
    const fresh = events.filter((event) => !notified.has(event.id));
    if (!fresh.length) return;
    // Mark first so concurrent renders or other tabs never show an event twice.
    writeNotified([...notified, ...fresh.map((event) => event.id)]);
    void (async () => {
      for (const event of fresh) await showNotification(event);
    })();
  },  [ready, state, dashboard, preferences.enabled, preferences.largeDebit, preferences.since]);

  return null;
}

function useInstalled() {
  return useSyncExternalStore((callback) => {
    const query = window.matchMedia?.("(display-mode: standalone)");
    query?.addEventListener?.("change", callback);
    return () => query?.removeEventListener?.("change", callback);
  }, () => !!window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true, () => true);
}

export function NotificationSettings() {
  const preferences = usePreferences();
  const installed = useInstalled();
  const id = useId();
  const [state, setState] = useState<NotificationPermission | "unsupported" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<string | null>(null);

  useEffect(() => {
    const update = () => setState(permission());
    update();
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);

  const toggle = useCallback(async (enabled: boolean) => {
    setMessage(null);
    if (!enabled) { writePreferences({ ...preferences, enabled: false }); return; }
    if (!supported()) { setState("unsupported"); return; }
    let result = Notification.permission;
    if (result === "default") {
      try { result = await Notification.requestPermission(); } catch { result = Notification.permission; }
    }
    setState(result);
    if (result !== "granted") { setMessage("Benachrichtigungen wurden nicht erlaubt."); return; }
    writePreferences({ ...preferences, enabled: true, since: today() });
  }, [preferences]);

  const commitThreshold = () => {
    if (threshold === null) return;
    const value = Number(threshold.replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(value) && value > 0) writePreferences({ ...preferences, largeDebit: Math.round(value * 100) / 100 });
    setThreshold(null);
  };

  const test = async () => {
    const shown = await showNotification({ id: `test-${Date.now()}`, title: "Test-Benachrichtigung",
      body: "So sehen Hinweise von Finanzblick aus.", url: "/" });
    setMessage(shown ? "Test-Benachrichtigung gesendet." : "Die Test-Benachrichtigung konnte nicht angezeigt werden.");
  };

  const blocked = state === "denied";
  const unsupported = state === "unsupported";
  const active = preferences.enabled && state === "granted";
  return <SettingsSection id="benachrichtigungen" title="Benachrichtigungen" icon={Bell}
    description="Lokale Hinweise bei Budgetüberschreitung, großen Abbuchungen und Gehaltseingang.">
    <div className="space-y-5">
      <label className="flex min-h-11 cursor-pointer items-start justify-between gap-4 rounded-2xl border border-border/70 bg-muted/15 p-4">
        <span>
          <span className="block text-sm font-medium">Benachrichtigungen aktivieren</span>
          <span id={`${id}-switch`} className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            Nur in diesem Browser · Finanzdaten verlassen das Gerät nicht.
          </span>
        </span>
        <input type="checkbox" role="switch" checked={active} disabled={unsupported || state === null}
          aria-describedby={`${id}-switch`} onChange={(event) => void toggle(event.target.checked)}
          className="peer sr-only" />
        <span aria-hidden="true" className="relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50 after:absolute after:left-0.5 after:size-5 after:rounded-full after:bg-background after:shadow-sm after:transition-transform peer-checked:after:translate-x-5" />
      </label>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor={`${id}-threshold`}>Große Abbuchung ab (€)</Label>
          <Input id={`${id}-threshold`} inputMode="decimal" type="text"
            value={threshold ?? String(preferences.largeDebit).replace(".", ",")}
            onChange={(event) => setThreshold(event.target.value)} onBlur={commitThreshold}
            onKeyDown={(event) => { if (event.key === "Enter") commitThreshold(); }} />
        </div>
        <Button type="button" variant="outline" disabled={state !== "granted"} onClick={() => void test()}>
          Test-Benachrichtigung
        </Button>
      </div>

      <div className="space-y-2 text-xs leading-relaxed text-muted-foreground" aria-live="polite">
        {unsupported && <p>Dieser Browser unterstützt keine Benachrichtigungen.</p>}
        {blocked && <p role="alert">Benachrichtigungen sind im Browser blockiert. Erlaube sie in den Website-Einstellungen und lade die Seite neu.</p>}
        {!installed && <p>Über das Browser-Menü „App installieren“ als App hinzufügen, damit Hinweise zuverlässig erscheinen.</p>}
        {message && <p>{message}</p>}
      </div>
    </div>
  </SettingsSection>;
}
