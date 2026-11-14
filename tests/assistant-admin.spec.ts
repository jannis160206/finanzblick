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
  const routing = [["chat", "deepseek-flash", "DeepSeek Flash"], ["route", "deepseek-flash", "DeepSeek Flash"], ["action", "deepseek-v4-pro", "DeepSeek V4 Pro"],
    ["reasoning", "deepseek-v4-pro", "DeepSeek V4 Pro · Denkmodus"], ["document", local, "Lokal (Qwen)"]].map(([task, model, label]) => ({ task, model, label, fallback: model === local }));
  await page.route("**/api/ai/status", (route) => route.fulfill({ json: {
    available: true, model: "deepseek-flash", label: "DeepSeek Flash", device: "Cloud", local: { available: true, model: local },
    cloud: { provider: "deepseek", available: true, models: { fast: "deepseek-flash", pro: "deepseek-v4-pro", reasoning: "deepseek-v4-pro" } }, routing,
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
    test(`is reachable only from the settings and lists tree, agents, runs and tools at ${width}px (${theme})`, async ({ page }, testInfo) => {
      await prepare(page, width, theme);
      await page.goto("/einstellungen");
      await expect(page.getByRole("link", { name: "Assistent-Orchestrator" })).toBeVisible();
      await expect(page.getByRole("navigation").getByRole("link", { name: /Orchestrator/ })).toHaveCount(0);
      await page.getByRole("link", { name: "Assistent-Orchestrator" }).click();
      await expect(page).toHaveURL(/\/einstellungen\/orchestrator$/);

      await expect(page.getByRole("heading", { level: 1, name: "Orchestrator" })).toBeVisible();
      for (const name of ["Aufbau", "Modelle", "Agenten", "Letzte Läufe", "Werkzeuge", "Feedback"]) await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
      await expect(page.getByRole("group", { name: "Orchestrator-Baum" })).toBeVisible();
      await expect(page.getByText("KI bereit · DeepSeek Flash · Qwen als Rückfall")).toBeVisible();
      await expect(page.getByRole("list", { name: "Modell je Aufgabe" })).toContainText("DeepSeek V4 Pro · Denkmodus");
      const runs = page.getByRole("list", { name: "Letzte Läufe" });
      await expect(runs.locator(":scope > li")).toHaveCount(2);
      await expect(runs.getByText("Wie viel netto bekomme ich?")).toBeVisible();
      await expect(runs.getByRole("group", { name: "Modelle" })).toHaveText("Lokal (Qwen) (Rückfall, weil DeepSeek: Rate-Limit (HTTP 429))");
      await expect(runs.getByRole("list", { name: "Werkzeugaufrufe" }).first()).toContainText("Erfolgreich: Antwort formulieren");
      await expect(page.getByRole("list", { name: "Werkzeuge Gehalt & Steuern" })).toContainText("Gehalt");
      await expect(page.getByRole("button", { name: "Aktualisieren" })).toBeEnabled();

      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath(`orchestrator-admin-${width}-${theme}.png`), fullPage: true });
    });
  }
});
