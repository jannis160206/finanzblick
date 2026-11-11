import { createHash } from "node:crypto";
import { daysInMonth, round, type Dashboard } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { detectDuplicateCharges, detectDuplicateFixedCosts, detectSubscriptions } from "@/lib/insights";
import type { AppState } from "@/lib/types";
import { memoryValue } from "./agent";
import { reminders } from "./extras";
import { unusualBookings, type WatchAlert, type WatchAlertKind } from "./essentials";
import { budgetPace } from "./pulse";

// Nightly background check: only things worth a Windows notification, each reported once.

export type { WatchAlert, WatchAlertKind } from "./essentials";
// Keys are hashed so the state file holds no merchant names; transaction ids tell which bookings are new.
export type WatchSeen = { version: 1; keys: Record<string, string>; transactionIds?: string[]; lastRun?: string };

const DAY_MS = 86_400_000;
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const order: WatchAlertKind[] = ["reminder", "duplicate", "buffer", "amex", "budget", "booking", "price", "renewal"];

export const emptySeen = (): WatchSeen => ({ version: 1, keys: {} });
export const alertHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

// Every important alert for today that was not reported before.
export function findAlerts(state: AppState, dashboard: Dashboard, today: string, seen: WatchSeen = emptySeen()): WatchAlert[] {
  const alerts: WatchAlert[] = [];
  const soon = shiftDate(today, 3);
  for (const entry of reminders(state).filter((item) => item.due! <= soon)) {
    const label = entry.text.replace(/\s*\([^)]*\)$/, "");
    alerts.push({ key: `reminder:${entry.id}:${entry.due}`, kind: "reminder", tone: entry.due! < today ? "bad" : "warn",
      title: `Erinnerung: ${label}`,
      detail: entry.due! < today ? `überfällig seit ${dateLabel(entry.due!)}` : entry.due === today ? "heute fällig" : `fällig am ${dateLabel(entry.due!)}` });
  }
  for (const item of detectDuplicateCharges(state, shiftDate(today, -14)))
    alerts.push({ key: `duplicate:${[...item.ids].sort().join("|")}`, kind: "duplicate", tone: "warn",
      title: `Doppelt abgebucht? ${item.merchant}`, detail: `${currency(item.amount)} am ${dateLabel(item.dates[0])} und ${dateLabel(item.dates[1])}` });
  for (const item of detectDuplicateFixedCosts(state, today.slice(0, 7)))
    alerts.push({ key: `duplicate-fixed:${today.slice(0, 7)}:${[...item.ids].sort().join("|")}`, kind: "duplicate", tone: "warn",
      title: `Fixkosten doppelt? ${item.label}`, detail: `${item.count}× ${currency(item.amount)} im Monatsplan` });
  const month = today.slice(0, 7);
  const surplus = dashboard.current?.surplus;
  const buffer = memoryValue(state, "buffer") ?? 0;
  if (surplus !== undefined && surplus < buffer)
    alerts.push({ key: `buffer:${month}:${surplus < 0 ? "minus" : "low"}`, kind: "buffer", tone: surplus < 0 ? "bad" : "warn",
      title: surplus < 0 ? `${monthLabel(month)} geht sich nicht aus` : `${monthLabel(month)} wird knapp`,
      detail: surplus < 0 ? `${currency(surplus)} nach Fixkosten, Amex und Plan` : `nur ${currency(surplus)} übrig, dein Puffer ist ${currency(buffer)}` });
  const amexShortfall = round(dashboard.amex?.shortfall ?? 0);
  if (amexShortfall > 0.5)
    alerts.push({ key: `amex:${month}`, kind: "amex", tone: "warn",
      title: "Amex-Rückzahlung nicht gedeckt", detail: `es fehlen noch ${currency(amexShortfall)}` });
  if (seen.transactionIds) alerts.push(...unusualBookings(state, today, new Set(seen.transactionIds)));
  // Budget lines that are used up, or 90 % gone with more than ten days left; each level once per month.
  const daysLeft = daysInMonth(month) - Number(today.slice(8, 10));
  for (const row of budgetPace(dashboard, today)) {
    const level = row.actual > row.total + 0.5 ? "over" : row.total >= 50 && row.actual >= row.total * 0.9 && daysLeft > 10 ? "near" : undefined;
    if (!level || row.id === "buffer") continue;
    alerts.push({ key: `budget:${month}:${row.id}:${level}`, kind: "budget", tone: level === "over" ? "bad" : "warn",
      title: level === "over" ? `Budget überschritten: ${row.label}` : `Budget fast aufgebraucht: ${row.label}`,
      detail: `${currency(-row.actual)} von ${currency(-row.total)} · noch ${daysLeft} Tage im Monat` });
  }
  const subscriptions = detectSubscriptions(state, today);
  for (const item of subscriptions.filter((entry) => entry.priceChange && entry.priceChange.date >= shiftDate(today, -35)))
    alerts.push({ key: `price:${item.merchant}:${item.priceChange!.date}`, kind: "price", tone: "warn",
      title: `${item.merchant} wurde teurer`,
      detail: `${currency(item.priceChange!.from)} → ${currency(item.priceChange!.to)} (+${item.priceChange!.percent.toLocaleString("de-AT")} %)` });
  for (const item of subscriptions.filter((entry) => entry.interval === "jährlich" && entry.nextDate >= today && entry.nextDate <= shiftDate(today, 14)))
    alerts.push({ key: `renewal:${item.merchant}:${item.nextDate}`, kind: "renewal", tone: "info",
      title: `Jahresabo verlängert sich: ${item.merchant}`, detail: `am ${dateLabel(item.nextDate)} · ${currency(item.amount)} – noch kündigen?` });
  return alerts.filter((alert) => !seen.keys[alertHash(alert.key)])
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

// Marks alerts as reported, remembers today's bookings and forgets entries older than 180 days.
export function rememberAlerts(seen: WatchSeen, alerts: WatchAlert[], state: AppState, today: string): WatchSeen {
  const cutoff = shiftDate(today, -180);
  const keys = Object.fromEntries(Object.entries(seen.keys).filter(([, date]) => date >= cutoff));
  for (const alert of alerts) keys[alertHash(alert.key)] = today;
  return { version: 1, keys, transactionIds: state.transactions.map((row) => row.id), lastRun: today };
}

export function parseSeen(raw: string | undefined): WatchSeen {
  if (!raw) return emptySeen();
  try {
    const value = JSON.parse(raw) as Partial<WatchSeen>;
    if (value?.version !== 1 || !value.keys || typeof value.keys !== "object") return emptySeen();
    return { version: 1, keys: Object.fromEntries(Object.entries(value.keys).filter(([, date]) => typeof date === "string")),
      ...(Array.isArray(value.transactionIds) ? { transactionIds: value.transactionIds.filter((id) => typeof id === "string") } : {}),
      ...(typeof value.lastRun === "string" ? { lastRun: value.lastRun } : {}) };
  } catch {
    return emptySeen();
  }
}

// At most three lines; the rest is summed up in the last one.
export function toastLines(alerts: WatchAlert[], max = 3): string[] {
  if (alerts.length <= max) return alerts.map((alert) => `${alert.title} – ${alert.detail}`);
  return [...alerts.slice(0, max - 1).map((alert) => `${alert.title} – ${alert.detail}`), `+ ${alerts.length - max + 1} weitere Hinweise im Finanz-Assistenten`];
}

export const escapeXml = (value: string) => value
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// Windows toast template: title plus up to three lines (the third as small attribution line, the maximum
// ToastGeneric shows); a click opens the assistant in the browser.
export function toastXml(title: string, lines: string[], launch?: string): string {
  const texts = [title, ...lines.slice(0, 3)].map((line, index) =>
    `<text${index === 0 ? ' hint-maxLines="1"' : index === 3 ? ' placement="attribution"' : ""}>${escapeXml(line.slice(0, 200))}</text>`).join("");
  const activation = launch ? ` activationType="protocol" launch="${escapeXml(launch)}"` : "";
  return `<toast${activation} scenario="default"><visual><binding template="ToastGeneric">${texts}</binding></visual>` +
    (launch ? `<actions><action content="Öffnen" activationType="protocol" arguments="${escapeXml(launch)}"/></actions>` : "") + "</toast>";
}
