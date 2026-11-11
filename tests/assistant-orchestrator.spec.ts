import { expect, test, type Page } from "@playwright/test";
import { SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";
import { payrollFixture } from "./fixtures/payroll-state";

// Nur synthetische Daten. Die freie Antwort der lokalen KI ist gemockt; Routing und Werkzeuge laufen echt.
const storageKey = "finanzdashboard.v1";

async function prepare(page: Page, width: number, theme: "light" | "dark") {
  await page.clock.setFixedTime(new Date("2026-10-15T12:00:00Z"));
  await page.setViewportSize({ width, height: width < 768 ? 812 : 1000 });
  await page.addInitScript(({ key, json, theme, activation }) => {
    localStorage.setItem("theme", theme);
    localStorage.setItem(activation, "off");
    if (!localStorage.getItem(key)) localStorage.setItem(key, json);
  }, { key: storageKey, json: JSON.stringify(payrollFixture()), theme, activation: SECURITY_ACTIVATION_KEY });
}

async function ask(page: Page, text: string) {
  const input = page.getByLabel("Nachricht an den Finanz-Assistenten", { exact: true });
  await input.fill(text);
  await input.press("Enter");
}

test.describe("assistant orchestrator", () => {
  test.skip(process.env.FINANZBLICK_AUTH === "true", "Seeds the browser-mode store.");

  for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
    test(`routes small talk, a general question and a payroll question to the right agent at ${width}px (${theme})`, async ({ page }, testInfo) => {
      await prepare(page, width, theme);
      const answers: { agent?: string; facts?: Record<string, unknown> }[] = [];
      await page.route("**/api/ai/answer**", async (route) => {
        answers.push(route.request().postDataJSON());
        await route.fulfill({
          contentType: "application/x-ndjson; charset=utf-8",
          body: [{ delta: "Spannend, aber ziemlich schwankend." }, { done: true, ok: true, text: "Spannend, aber ziemlich schwankend. Nur mit Geld, das du länger nicht brauchst." }]
            .map((event) => JSON.stringify(event)).join("\n") + "\n",
        });
      });
      await page.goto("/");
      await page.getByRole("button", { name: /^Finanz-Assistent öffnen/ }).click();
      const chat = page.getByRole("region", { name: "Chat mit dem Finanz-Assistenten" });

      // Small talk: answered instantly by the general chat, without the model.
      await ask(page, "Hallo");
      await expect(chat.getByText(/^(?:Guten Morgen|Hallo|Guten Abend)! /)).toBeVisible();

      // Nothing about own money: the general chat answers in its own voice and sees no personal facts.
      await ask(page, "Was hältst du von Bitcoin?");
      await expect(chat.getByText("Spannend, aber ziemlich schwankend. Nur mit Geld, das du länger nicht brauchst.")).toBeVisible();
      expect(answers.at(-1)).toMatchObject({ agent: "general", facts: { today: expect.any(String) } });
      expect(Object.keys(answers.at(-1)?.facts ?? {})).toEqual(["today"]);

      // A payroll question goes to the Gehalt & Steuern specialist; its tool computes the numbers, no model needed.
      await ask(page, "Wie viel netto bekomme ich?");
      const payroll = chat.getByRole("article", { name: /^Gehalt · / });
      await expect(payroll).toBeVisible();
      await expect(chat.getByText("Gehalt & Steuern", { exact: true }).last()).toBeVisible();
      await expect(payroll.getByText(/^Nächste Sonderzahlung/)).toBeVisible();
      expect(answers).toHaveLength(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath(`assistant-${width}-${theme}.png`) });
    });
  }
});
