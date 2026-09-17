import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { SECURITY_MODE_KEY, SECURITY_FALLBACK_KEY } from "../src/lib/security-mode";
import type { AppState } from "../src/lib/types";

const storageKey = "finanzdashboard.v1";

async function seed(page: Page, locked = false) {
  const state = createSeed();
  state.settings.asOf = "2026-09-17";
  state.settings.baselineDate = "2026-09-01";
  state.transactions = [{
    id: "privacy-purchase", description: "Privater Beispielkauf", date: "2026-09-12",
    amount: -1234.56, bank: "Revolut", pocket: null, category: "Shopping",
    categoryOverride: true, includeInPlan: true,
  }, {
    id: "privacy-review", description: "Unbekannter Beispielkauf", date: "2026-09-12",
    amount: -987.65, bank: "Revolut", pocket: null, category: "Prüfen", includeInPlan: false,
  }];
  state.fixedReceipts = [];
  await page.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await page.addInitScript(({ state, storageKey, securityKey, locked }) => {
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(state));
    if (!localStorage.getItem(securityKey)) localStorage.setItem(securityKey, String(locked));
  }, { state, storageKey, securityKey: SECURITY_MODE_KEY, locked });
  await page.goto("/umsaetze");
}

async function expectShield(page: Page) {
  await expect(page.getByRole("heading", { name: "Sicherheitsmodus aktiv", exact: true })).toBeVisible();
  await expect(page.locator("[data-financial-content]")).toBeHidden();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("spinbutton")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-sonner-toaster]")).toHaveCount(0);
  expect(await page.locator(".app-shell").innerText()).not.toMatch(/\d/);
}

test("header shield covers all screens, persists on reload and never changes financial data", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seed(page);
  await expect(page.getByRole("cell", { name: "Privater Beispielkauf", exact: true })).toBeVisible();
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible();
  const before = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as AppState, storageKey);
  await page.getByLabel("Umsätze durchsuchen").fill("Privater");
  const lock = page.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true });
  const color = page.getByRole("button", { name: "Farbschema wechseln" });
  const lockBox = (await lock.boundingBox())!;
  const colorBox = (await color.boundingBox())!;
  expect(Math.abs(lockBox.y - colorBox.y)).toBeLessThanOrEqual(5);
  expect(colorBox.x - (lockBox.x + lockBox.width)).toBeLessThanOrEqual(16);
  await lock.click();
  await expect(page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expectShield(page);
  await page.screenshot({ path: testInfo.outputPath("security-desktop.png") });
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(page.getByLabel("Umsätze durchsuchen")).toHaveValue("Privater");
  await lock.click();
  for (const route of ["/", "/monate", "/pockets", "/plan", "/einstellungen", "/umsaetze"]) {
    await page.goto(route);
    await expectShield(page);
  }
  await page.reload();
  await expectShield(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  const navigation = page.getByRole("dialog", { name: "Finanzblick", exact: true });
  await expect(navigation.getByRole("link", { name: "Umsätze", exact: true })).toBeVisible();
  expect(await navigation.innerText()).not.toMatch(/\d/);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("security-mobile.png") });
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
  const after = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as AppState, storageKey);
  expect(after.transactions).toEqual(before.transactions);
  expect(after.financeRows).toEqual(before.financeRows);
  expect(after.settings).toEqual(before.settings);
  expect(errors).toEqual([]);
});

test("another tab hides open financial portals without losing an unsaved category", async ({ page, context }) => {
  await seed(page);
  await page.getByRole("button", { name: "Zuordnung ändern: Privater Beispielkauf", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Zuordnung ändern", exact: true });
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Elektronik");
  const other = await context.newPage();
  await other.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await other.goto("/");
  await other.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true }).click();
  await expectShield(page);
  await expect(page.locator('[data-financial-overlay]')).toHaveCount(0);
  await other.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Kategorie", { exact: true })).toHaveValue("Elektronik");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await page.getByRole("button", { name: "Weitere Filter", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Weitere Filter", exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true }).click();
  await expectShield(page);
  await other.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Weitere Filter", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Kategorie filtern", { exact: true }).click();
  await expect(page.locator("select:open")).toHaveCount(1);
  await other.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true }).click();
  await expectShield(page);
  await expect.poll(() => page.getByLabel("Kategorie filtern", { exact: true })
    .evaluate((select) => getComputedStyle(select, "::picker(select)").visibility)).toBe("hidden");
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
  await other.close();
});

test("saved security preference protects the first page even when hydration scripts fail", async ({ page }) => {
  await seed(page, true);
  await expectShield(page);
  await page.route("**/_next/static/**/*.js", (route) => route.abort());
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-security-mode", "locked");
  await expectShield(page);
});

test("a failed preference write remains protected through a reload and explains the failure", async ({ page }) => {
  await seed(page);
  await page.addInitScript((securityKey) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === securityKey) throw new DOMException("Full", "QuotaExceededError");
      original.call(this, key, value);
    };
  }, SECURITY_MODE_KEY);
  await page.reload();
  await page.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true }).click();
  await expectShield(page);
  await expect(page.locator(".app-shell").getByRole("alert")).toContainText("nicht dauerhaft gespeichert");
  expect(await page.evaluate((key) => sessionStorage.getItem(key), SECURITY_FALLBACK_KEY)).toBe("true");
  await page.reload();
  await expectShield(page);
  await expect(page.locator(".app-shell").getByRole("alert")).toContainText("nicht dauerhaft gespeichert");
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expectShield(page);
});
