import { expect, test, type Page } from "@playwright/test";
import { SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";
import { payrollFixture } from "./fixtures/payroll-state";

// Nur synthetische Daten: zwei Läufe im Chatverlauf, der KI-Status ist gemockt.
const storageKey = "finanzdashboard.v1";
const local = "OpenVINO/Qwen3-8B-int4-cw-ov";
const at = Date.UTC(2026, 9, 15, 10);

function adminState() {
  return {
    ...payrollFixture(),
    assistantChat: [
      { id: "u1", role: "user", text: "Wie viel netto bekomme ich?", at },
      { id: "a1", role: "assistant", text: "Deine letzte Abrechnung bringt 2.780,00 € netto.", at: at + 400, source: "Regel", agent: "payroll", via: "rule", ms: 380, tool: "payroll" },
      { id: "u2", role: "user", text: "Was hältst du von Bitcoin?", at: at + 60_000 },
      { id: "a2", role: "assistant", text: "Spannend, aber ziemlich schwankend.", at: at + 64_000, source: "KI", agent: "general", via: "rule", ms: 4100, tool: "free",
        models: [{ provider: "local", model: "OpenVINO/Qwen3-8B-int4-cw-ov", task: "chat", fallback: true, reason: "Rate-Limit (HTTP 429)" }] },
    ],
  };
}

async function prepare(page: Page, width: number, theme: "light" | "dark") {
  await page.clock.setFixedTime(new Date("2026-10-15T12:00:00Z"));
  await page.setViewportSize({ width, height: width < 768 ? 812 : 1000 });
  const routing = [["chat", "deepseek-flash", "DeepSeek Flash"], ["route", "deepseek-flash", "DeepSeek Flash"], ["supervise", "deepseek-flash", "DeepSeek Flash"],
    ["synthesize", "deepseek-v4-pro", "DeepSeek V4 Pro"], ["action", "deepseek-v4-pro", "DeepSeek V4 Pro"],
    ["reasoning", "deepseek-v4-pro", "DeepSeek V4 Pro · Denkmodus"], ["document", local, "Lokal (Qwen)"]].map(([task, model, label]) => ({ task, model, label, fallback: model === local }));
  // The prompt file is mocked: one saved change per test run, never written to disk.
  let voice = { id: "voice.budget", group: "budget", label: "Stimme", hint: "Rolle, Fachwissen und Ton.", default: "Du bist Finanzblick.", text: "Du bist Finanzblick.", custom: false };
  await page.route("**/api/agent-prompts", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { text?: string };
      voice = { ...voice, text: body.text ?? voice.default, custom: !!body.text };
    }
    await route.fulfill({ json: { file: "config/agent-prompts.json", prompts: [
      { id: "supervisor", group: "supervisor", label: "Planung (DeepSeek Flash)", hint: "Plant.", default: "Plane.", text: "Plane.", custom: false }, voice,
    ] } });
  });
  const at = "2026-10-15T11:00:00.000Z";
  await page.route("**/api/assistant-rules", (route) => route.fulfill({ json: { file: "data/assistant-rules.json", loop: "bereit", count: {}, rules: [
    { id: "rule-0002", feedbackId: "fb-00000002", createdAt: at, updatedAt: at, appliedAt: at, status: "active", kind: "prompt",
      comment: "Du sollst meine Verträge durchsuchen und nach einer günstigeren Alternative suchen.", question: "Lohnt sich ein anderes Konto?", answer: "Schau unter Verträge.",
      rule: "Bei Fragen nach Alternativen hol die passenden Verträge und recherchiere günstigere Angebote im Web.", scope: "all", target: "routing",
      prompt: { id: "voice.contracts", mode: "replace", before: "Behaupte nie, dass er ein gefragtes Angebot schon hat.",
        after: "Bei Fragen nach Alternativen hol die passenden Verträge und recherchiere günstigere Angebote im Web." },
      review: { fixed: true, note: "Holt jetzt die Verträge und sucht im Web nach Alternativen." }, votes: { up: 3, down: 1 },
      check: { at, model: "deepseek-flash", passed: true, baseline: { passed: 85, total: 86, hard: 0 }, candidate: { passed: 86, total: 86, hard: 0 } } },
    { id: "rule-0001", feedbackId: "fb-00000001", createdAt: at, updatedAt: at, status: "active", comment: "Die Antwort beginnt mit einer Floskel und wiederholt sich.",
      question: "Was ist ein ETF?", answer: "Gute Frage! …", rule: "Beginne Antworten ohne Floskel und vermeide Wiederholungen.", scope: "all", target: "answer",
      check: { at, model: "deepseek-flash", passed: true, baseline: { passed: 85, total: 86, hard: 0 }, candidate: { passed: 85, total: 86, hard: 0 } } },
  ] } }));
  await page.route("**/api/ai/status", (route) => route.fulfill({ json: {
    available: true, model: "deepseek-flash", label: "DeepSeek Flash", device: "Cloud", local: { available: true, model: local },
    cloud: { provider: "deepseek", available: true, models: { fast: "deepseek-flash", pro: "deepseek-v4-pro", reasoning: "deepseek-v4-pro" } }, routing,
    usage: { "deepseek-flash": { calls: 4, input: 12000, output: 500, cached: 6000 }, "deepseek-v4-pro": { calls: 2, input: 8000, output: 500, cached: 2000 } },
  } }));
  await page.addInitScript(({ key, json, theme, activation }) => {
    localStorage.setItem("theme", theme);
    localStorage.setItem(activation, "off");
    if (!localStorage.getItem(key)) localStorage.setItem(key, json);
  }, { key: storageKey, json: JSON.stringify(adminState()), theme, activation: SECURITY_ACTIVATION_KEY });
}

test.describe("assistant orchestrator admin", () => {
  test.skip(process.env.FINANZBLICK_AUTH === "true", "Seeds the browser-mode store.");

  for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
    test(`is reachable only from the settings, folds out its subpages and shows tree, prompts, runs, tools and feedback at ${width}px (${theme})`, async ({ page }, testInfo) => {
      await prepare(page, width, theme);
      await page.goto("/einstellungen");
      await expect(page.getByRole("link", { name: "Assistent-Orchestrator" })).toBeVisible();
      await expect(page.getByRole("navigation").getByRole("link", { name: /Orchestrator/ })).toHaveCount(0);
      // The arrow next to the link folds out the subpages.
      const arrow = page.getByRole("button", { name: "Orchestrator-Unterseiten anzeigen" });
      await arrow.click();
      const pages = page.getByRole("list", { name: "Orchestrator-Unterseiten" });
      await expect(pages.getByRole("link")).toHaveText(["Aufbau & Topologie", "Agenten & Prompts", "Letzte Läufe", "Werkzeuge", "Feedback & Prüfung"]);
      await expect(page.getByRole("button", { name: "Orchestrator-Unterseiten ausblenden" })).toHaveAttribute("aria-expanded", "true");
      await page.getByRole("link", { name: "Assistent-Orchestrator" }).click();
      await expect(page).toHaveURL(/\/einstellungen\/orchestrator\/aufbau$/);

      await expect(page.getByRole("heading", { level: 1, name: "Orchestrator" })).toBeVisible();
      const sub = page.getByRole("navigation", { name: "Orchestrator-Bereiche" });
      await expect(sub.getByRole("link", { name: "Aufbau & Topologie" })).toHaveAttribute("aria-current", "page");
      for (const name of ["Topologie", "Modelle", "Kosten"]) await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
      await expect(page.getByRole("group", { name: "Im Hintergrund" })).toContainText("Prüfungs-Agent");
      const tree = page.getByRole("group", { name: "Orchestrator-Baum" });
      await expect(tree).toBeVisible();
      await expect(tree.getByText("KI bereit · DeepSeek Flash · Qwen als Rückfall")).toBeVisible();
      await expect(tree.getByRole("list", { name: "Werkzeuge im Baum: Gehalt & Steuern" })).toContainText("Gehaltsübersicht");
      await expect(tree).toContainText("Schreibt:DeepSeek V4 Pro");
      await expect(page.getByRole("list", { name: "Modell je Aufgabe" })).toContainText("DeepSeek V4 Pro · Denkmodus");
      await expect(page.getByRole("list", { name: "Kosten je Modell" })).toContainText("deepseek-v4-pro");
      await page.screenshot({ path: testInfo.outputPath(`orchestrator-aufbau-${width}-${theme}.png`), fullPage: true });

      await sub.getByRole("link", { name: "Agenten & Prompts" }).click();
      await expect(page).toHaveURL(/\/orchestrator\/agenten$/);
      await expect(page.getByRole("heading", { level: 2, name: "System-Prompts" })).toBeVisible();
      await page.getByRole("button", { name: "Stimme" }).click();
      const field = page.getByRole("textbox", { name: "System-Prompt: Budget & Prognose · Stimme" });
      await field.fill("Du bist ein strenger Budget-Coach.");
      await page.getByRole("button", { name: "Speichern" }).click();
      await expect(page.getByText("Gespeichert – gilt ab der nächsten Frage.")).toBeVisible();
      await expect(page.getByText("1 von 2 angepasst")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath(`orchestrator-agenten-${width}-${theme}.png`), fullPage: true });
      await page.getByRole("button", { name: "Auf Standard zurücksetzen" }).click();
      await expect(field).toHaveValue("Du bist Finanzblick.");

      await sub.getByRole("link", { name: "Letzte Läufe" }).click();
      const runs = page.getByRole("list", { name: "Letzte Läufe" });
      await expect(runs.locator(":scope > li")).toHaveCount(2);
      await expect(runs.getByText("Wie viel netto bekomme ich?")).toBeVisible();
      await expect(runs.getByRole("group", { name: "Modelle" })).toHaveText("Lokal (Qwen) (Rückfall, weil DeepSeek: Rate-Limit (HTTP 429))");
      await expect(runs.getByRole("list", { name: "Werkzeugaufrufe" }).first()).toContainText("Erfolgreich: Antwort formulieren");

      await sub.getByRole("link", { name: "Werkzeuge" }).click();
      await expect(page.getByRole("list", { name: "Werkzeuge Gehalt & Steuern" })).toContainText("Gehalt");

      await sub.getByRole("link", { name: "Feedback & Prüfung" }).click();
      const rules = page.getByRole("list", { name: "Änderungen des Prüfungs-Agents" });
      await expect(rules).toContainText("Beginne Antworten ohne Floskel und vermeide Wiederholungen.");
      await expect(rules).toContainText("Gold-Eval ohne → mit Regel: 85/86 → 85/86");
      await expect(rules.getByRole("button", { name: /^Regel deaktivieren/ })).toBeVisible();
      const change = rules.locator(":scope > li").first();
      await expect(change).toContainText("Prompt geändert · Verträge · Stimme");
      await expect(change).toContainText("Statt: „Behaupte nie, dass er ein gefragtes Angebot schon hat.“");
      await expect(change).toContainText("Nachtest: behoben");
      await expect(change.getByRole("button", { name: /^Änderung zurücknehmen/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Aktualisieren" })).toBeEnabled();

      // The bare address still works and opens the first subpage.
      await page.goto("/einstellungen/orchestrator");
      await expect(page).toHaveURL(/\/einstellungen\/orchestrator\/aufbau$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});
