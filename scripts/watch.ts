// Nightly background check ("Hintergrund-Agent"): reads the local finance data, looks for important news
// (new unusual bookings, double charges, price increases, due reminders, renewals, Amex gap, tight month)
// and shows one Windows notification only when something new is found.
//   npm run watch:run                 normal run (toast, remembers what was reported)
//   npm run watch:run -- --dry-run    print only, no toast, nothing remembered
//   npm run watch:run -- --counts     like --dry-run, but prints only counts per kind (no names or amounts)
//   npm run watch:run -- --test       one sample toast, no data access
//   npm run watch:run -- --ai         let the local AI phrase the first line (numbers are checked against the facts)
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { calculateDashboard } from "../src/lib/calc";
import { createEmptyAccountState } from "../src/lib/account-state";
import { chat } from "../src/lib/ai/client";
import { numbersBacked } from "../src/lib/ai/summary";
import { cleanFacts, contactsBacked, DATA_RULE } from "../src/lib/ai/untrusted";
import { findAlerts, parseSeen, rememberAlerts, toastLines, toastXml, type WatchAlert } from "../src/lib/assistant/watch";
import { openFinanceAccess } from "./mcp-server";

const APP_ID = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;
const LAUNCH = process.env.FINANZBLICK_URL ? `${process.env.FINANZBLICK_URL.replace(/\/$/, "")}/assistent` : "http://127.0.0.1:3000/assistent";

const args = new Set(process.argv.slice(2));
const counts = args.has("--counts");
const dryRun = args.has("--dry-run") || counts;

function statePath() {
  const configured = process.env.FINANZBLICK_WATCH_STATE;
  if (configured) return isAbsolute(configured) ? configured : resolve(configured);
  // Outside the repository: the list of reported alerts is private.
  return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "FinanzblickAI", "watch-state.json") : resolve(".local-data", "watch-state.json");
}

const localDate = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function showToast(title: string, lines: string[], launch = LAUNCH): Promise<void> {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows-Benachrichtigungen gibt es nur unter Windows."));
  const xml = Buffer.from(toastXml(title, lines, launch), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xml}')))`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)`,
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // WinRT toasts need Windows PowerShell 5.1 (pwsh 7 cannot load the WinRT types).
  return new Promise((done, fail) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true, timeout: 30_000 }, (error, _stdout, stderr) => error ? fail(new Error(stderr.trim() || error.message)) : done()));
}

// Optional: one friendly sentence from the local model; every number must appear in the alert texts.
async function aiHeadline(alerts: WatchAlert[]): Promise<string | undefined> {
  const facts = cleanFacts({ hinweise: alerts.slice(0, 6).map((alert) => `${alert.title}: ${alert.detail}`) }, 160);
  try {
    const answer = await chat([
      { role: "system", content: "Du fasst nächtliche Finanz-Hinweise in genau einem kurzen Satz auf Deutsch (Du-Form) zusammen, höchstens 120 Zeichen, kein Markdown. " +
        "Nenne nur Beträge, die genau so in den Hinweisen stehen, und rechne nichts aus. " + DATA_RULE },
      { role: "user", content: `Hinweise (JSON):\n${JSON.stringify(facts)}` },
    ], { task: "chat", maxTokens: 80, temperature: 0.2, signal: AbortSignal.timeout(20_000) });
    const text = answer.content.replace(/\s+/g, " ").trim();
    const factNumbers = { values: alerts.flatMap((alert) => (`${alert.title} ${alert.detail}`.match(/\d+(?:\.\d{3})*(?:,\d+)?/g) ?? [])
      .map((raw) => Number(raw.replace(/\./g, "").replace(",", ".")))) };
    return text.length >= 15 && text.length <= 160 && numbersBacked(text, factNumbers) && contactsBacked(text, facts) ? text : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  if (args.has("--test")) {
    await showToast("Finanzblick", ["Testbenachrichtigung vom Hintergrund-Agenten", "So sieht ein Hinweis aus – Klick öffnet den Finanz-Assistenten."]);
    console.log("Testbenachrichtigung gesendet.");
    return;
  }
  const access = openFinanceAccess();
  try {
    const state = access.database.getFinance(access.userId).state ?? createEmptyAccountState();
    const today = localDate();
    const path = statePath();
    const seen = parseSeen(existsSync(path) ? readFileSync(path, "utf8") : undefined);
    const alerts = findAlerts(state, calculateDashboard(state), today, seen);
    if (counts) {
      const byKind = Object.fromEntries([...new Set(alerts.map((alert) => alert.kind))].map((kind) => [kind, alerts.filter((alert) => alert.kind === kind).length]));
      console.log(JSON.stringify({ today, alerts: alerts.length, byKind, firstRun: !seen.transactionIds }));
      return;
    }
    if (dryRun) {
      console.log(alerts.length ? `${alerts.length} neue Hinweise (Probelauf, keine Benachrichtigung):` : "Nichts Wichtiges – keine Benachrichtigung.");
      for (const alert of alerts) console.log(`- [${alert.kind}] ${alert.title} – ${alert.detail}`);
      return;
    }
    if (alerts.length) {
      const headline = args.has("--ai") ? await aiHeadline(alerts) : undefined;
      const lines = headline ? [headline, ...toastLines(alerts, 2)] : toastLines(alerts, 3);
      await showToast("Finanzblick", lines);
    }
    // Remember only after the toast was shown, so a failed toast is retried next night.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(rememberAlerts(seen, alerts, state, today)));
    renameSync(`${path}.tmp`, path);
    console.log(alerts.length ? `${alerts.length} Hinweise gemeldet.` : "Nichts Wichtiges – keine Benachrichtigung.");
  } finally {
    access.close();
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/watch.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
