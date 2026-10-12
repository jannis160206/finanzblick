import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { SECURITY_MODE_KEY, SECURITY_FALLBACK_KEY, SECURITY_AUTO_LOCK_KEY, SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";
import type { AppState } from "../src/lib/types";
import { focusTest } from "./helpers/real-focus";

const storageKey = "finanzdashboard.v1";

async function seed(page: Page, locked = false, baseURL?: string, financeRows?: AppState["financeRows"]) {
  await page.bringToFront();
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
  if (financeRows) state.financeRows = financeRows;
  await page.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await page.addInitScript(({ state, storageKey, securityKey, locked }) => {
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(state));
    if (!localStorage.getItem(securityKey)) localStorage.setItem(securityKey, String(locked));
  }, { state, storageKey, securityKey: SECURITY_MODE_KEY, locked });
  await page.goto(baseURL ? new URL("/umsaetze", baseURL).href : "/umsaetze");
  if (baseURL) {
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  }
  const toggle = page.getByRole("button", { name: /^Sicherheitsmodus (deaktivieren|aktivieren)$/ });
  await expect(toggle).toBeEnabled();
  // A real browser can lose focus during startup; explicitly unlock the test's starting state.
  if (!locked && await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(locked));
}

async function expectShield(page: Page) {
  await expect(page.locator("[data-security-notice]")).toBeVisible();
  await expect(page.locator("[data-financial-content]")).toBeVisible();
  await expect(page.locator("[data-security-screen]")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /Umsätze durchsuchen|Positionen suchen/ })).toHaveCount(0);
  await expect(page.getByRole("spinbutton")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-sonner-toaster]")).toHaveCount(0);
  const marks = page.locator("[data-financial-data]");
  for (const mark of await marks.all()) {
    await expect(mark).toHaveAttribute("aria-hidden", "true");
    await expect(mark).toHaveAttribute("inert", "");
  }
  expect(await page.locator(".app-shell").ariaSnapshot()).not.toMatch(/Privater Beispielkauf|Unbekannter Beispielkauf|1\.234,56|987,65/);
}

test("header shield blurs data without replacing the screen, persists on reload and never changes financial data", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seed(page);
  await expect(page.getByRole("cell", { name: "Privater Beispielkauf", exact: true })).toBeVisible();
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible();
  const before = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as AppState, storageKey);
  await page.getByLabel("Umsätze durchsuchen").fill("Privater");
  const rows = page.locator("table[aria-label='Buchungen'] tbody");
  const beforeBox = await rows.boundingBox();
  const lock = page.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true });
  const color = page.getByRole("button", { name: "Farbschema wechseln" });
  const lockBox = (await lock.boundingBox())!;
  const colorBox = (await color.boundingBox())!;
  expect(Math.abs(lockBox.y - colorBox.y)).toBeLessThanOrEqual(5);
  expect(colorBox.x - (lockBox.x + lockBox.width)).toBeLessThanOrEqual(16);
  await lock.click();
  await expect(page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expectShield(page);
  await expect(rows).toHaveCSS("filter", "blur(10px)");
  const afterBox = await rows.boundingBox();
  expect(afterBox?.width).toBe(beforeBox?.width);
  expect(afterBox?.height).toBe(beforeBox?.height);
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toHaveCSS("filter", "none");
  await page.screenshot({ path: testInfo.outputPath("security-desktop.png") });
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(page.getByLabel("Umsätze durchsuchen")).toHaveValue("Privater");
  await lock.click();
  for (const route of ["/", "/monate", "/pockets", "/plan", "/gehalt-steuern", "/einstellungen", "/umsaetze"]) {
    await page.goto(route);
    await expectShield(page);
    if (route === "/") await page.screenshot({ path: testInfo.outputPath("security-overview.png") });
  }
  await page.reload();
  await expectShield(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  const navigation = page.getByRole("dialog", { name: "Finanzblick", exact: true });
  await expect(navigation.getByRole("link", { name: "Umsätze", exact: true })).toBeVisible();
  expect(await navigation.ariaSnapshot()).not.toMatch(/offene Zuordnungen|Umsätze \d/);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-variant="navigation"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("security-mobile.png") });
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
  const after = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as AppState, storageKey);
  expect(after.transactions).toEqual(before.transactions);
  expect(after.financeRows).toEqual(before.financeRows);
  expect(after.settings).toEqual(before.settings);
  expect(errors).toEqual([]);
});

test("privacy settings stay usable while locked and persist manual and disabled activation without changing finances", async ({ page }, testInfo) => {
  await seed(page);
  const before = await page.evaluate((key) => localStorage.getItem(key), storageKey);
  await page.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true }).click();
  await page.goto("/einstellungen");
  await expectShield(page);
  const settings = page.getByRole("region", { name: "Sicherheitsmodus", exact: true });
  await expect(settings).toHaveCSS("filter", "none");
  await settings.getByRole("radio", { name: "Nur manuell", exact: true }).check();
  await expect(settings.getByRole("radio", { name: "Nur manuell", exact: true })).toBeChecked();
  expect(await page.evaluate((key) => localStorage.getItem(key), SECURITY_ACTIVATION_KEY)).toBe("manual");
  await page.locator("[data-security-notice]").getByRole("button", { name: "Daten anzeigen" }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator("html")).toHaveAttribute("data-security-mode", "open");
  await page.reload();
  await expect(settings.getByRole("radio", { name: "Nur manuell", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true }).click();
  await settings.getByRole("radio", { name: "Deaktiviert", exact: true }).check();
  await expect(page.locator("[data-security-notice]")).toBeHidden();
  await expect(page.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-security-mode", "open");
  await expect(settings.getByRole("radio", { name: "Deaktiviert", exact: true })).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("security-settings-mobile.png") });
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(before);
});

test("locked financial values stay absent from printed output", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true }).click();
  await page.emulateMedia({ media: "print", reducedMotion: "reduce" });
  await expect(page.locator("table[aria-label='Buchungen'] tbody")).toHaveCSS("visibility", "hidden");
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
});

test("automatic privacy locking does not save an unfinished amount edit", async ({ page }) => {
  await seed(page, false, undefined, [{ id: "privacy-income", kind: "income", label: "Beispielgehalt", values: { "2026-09": 3000 } }]);
  await page.goto("/monate");
  const shield = page.getByRole("button", { name: /^Sicherheitsmodus (deaktivieren|aktivieren)$/ });
  await expect(shield).toBeEnabled();
  if (await shield.getAttribute("aria-pressed") === "true") await shield.click();
  await page.getByRole("button", { name: "Plan bearbeiten", exact: true }).click();
  const input = page.locator('input[inputmode="decimal"]').first();
  await expect(input).toBeVisible();
  const before = await page.evaluate((key) => localStorage.getItem(key), storageKey);
  await input.fill("5432");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expectShield(page);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(before);
  await page.locator("[data-security-notice]").getByRole("button", { name: "Daten anzeigen" }).click();
  await expect(input).toHaveValue("5432");
});

focusTest("manual and disabled preferences ignore real tab changes and survive reload", async ({ focusContext: context, baseURL }) => {
  const page = await context.newPage();
  await seed(page, false, baseURL);
  for (const choice of ["Nur manuell", "Deaktiviert"]) {
    await page.goto(new URL("/einstellungen", baseURL).href);
    await page.getByRole("region", { name: "Sicherheitsmodus", exact: true }).getByRole("radio", { name: choice, exact: true }).check();
    const shield = page.getByRole("button", { name: /^Sicherheitsmodus (deaktivieren|aktivieren)$/ });
    if (await shield.getAttribute("aria-pressed") === "true") await shield.click();
    const other = await context.newPage();
    await other.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await expect(page.locator("html")).toHaveAttribute("data-security-mode", "open");
    await page.bringToFront();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-security-mode", "open");
    await expect(page.getByRole("radio", { name: choice, exact: true })).toBeChecked();
    await other.close();
  }
});

focusTest("leaving the tab locks financial portals until this tab is manually unlocked", async ({ focusContext: context, baseURL }) => {
  const page = await context.newPage();
  await seed(page, false, baseURL);
  await page.getByRole("button", { name: "Zuordnung ändern: Privater Beispielkauf", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Zuordnung ändern", exact: true });
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Guthabenkarten");
  await dialog.getByRole("checkbox", { name: "Als Fixkosten markieren", exact: true }).check();
  const other = await context.newPage();
  await other.bringToFront();
  await other.mouse.click(50, 50);
  await expectShield(page);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), SECURITY_AUTO_LOCK_KEY)).toBe("true");
  await other.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await other.goto(new URL("/", baseURL).href);
  await expectShield(other);
  await expect(page.locator('[data-financial-overlay]')).toHaveCount(0);
  await other.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expectShield(page);
  await page.bringToFront();
  await expectShield(page);
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Kategorie", { exact: true })).toHaveValue("Guthabenkarten");
  await expect(dialog.getByRole("checkbox", { name: "Als Fixkosten markieren", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await page.getByRole("button", { name: "Weitere Filter", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Weitere Filter", exact: true })).toBeVisible();
  await other.bringToFront();
  await expectShield(page);
  await page.bringToFront();
  await expectShield(page);
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Weitere Filter", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Kategorie filtern", { exact: true }).click();
  await expect(page.locator("select:open")).toHaveCount(1);
  await other.bringToFront();
  await expectShield(page);
  await expect.poll(() => page.getByLabel("Kategorie filtern", { exact: true })
    .evaluate((select) => getComputedStyle(select, "::picker(select)").visibility)).toBe("hidden");
  await page.bringToFront();
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
  await other.close();
});

focusTest("automatic tab locks survive reload and keep unsaved review choices until explicit unlock", async ({ focusContext: context, baseURL }) => {
  const page = await context.newPage();
  await seed(page, false, baseURL);
  await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
  const dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Telefon & Internet");
  await dialog.getByRole("checkbox", { name: "Als Fixkosten markieren", exact: true }).check();
  const before = await page.evaluate((key) => localStorage.getItem(key), storageKey);
  const other = await context.newPage();
  await other.bringToFront();
  await other.mouse.click(50, 50);
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  await expectShield(page);
  await page.bringToFront();
  await expectShield(page);
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Kategorie", { exact: true })).toHaveValue("Telefon & Internet");
  await expect(dialog.getByRole("checkbox", { name: "Als Fixkosten markieren", exact: true })).toBeChecked();
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(before);
  await dialog.getByRole("button", { name: "Prüfung schließen", exact: true }).click();
  await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
  await expect(dialog.getByLabel("Kategorie", { exact: true })).toHaveValue("Prüfen");
  await expect(dialog.getByRole("checkbox", { name: "Als Fixkosten markieren", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Prüfung schließen", exact: true }).click();
  await other.bringToFront();
  await other.mouse.click(50, 50);
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  await expectShield(page);
  await page.reload();
  await page.bringToFront();
  await expectShield(page);
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
  await other.close();
});

focusTest("switching to another window locks the still-visible finance tab", async ({ focusContext: context, baseURL }) => {
  const page = await context.newPage();
  await seed(page, false, baseURL);
  await expect(page.getByRole("cell", { name: "Privater Beispielkauf", exact: true })).toBeVisible();
  const cdp = await context.newCDPSession(page);
  const opening = context.waitForEvent("page");
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const other = await opening;
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 10, top: 10, width: 400, height: 300 } });
  await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
  await expectShield(page);
  await page.bringToFront();
  await expectShield(page);
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Privater Beispielkauf", exact: true })).toBeVisible();
  await other.close();
});

focusTest("minimizing the browser locks the hidden page until manually unlocked", async ({ focusContext: context, baseURL }) => {
  const page = await context.newPage();
  await seed(page, false, baseURL);
  await expect(page.getByRole("cell", { name: "Privater Beispielkauf", exact: true })).toBeVisible();
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  try {
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.securityMode)).toBe("locked");
  } finally {
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await page.bringToFront();
  }
  await expectShield(page);
  // Native CDP windows can suspend animation frames after restore; the shield's
  // pointer interaction is covered above, so this checks the preserved action.
  await page.getByRole("button", { name: "Sicherheitsmodus deaktivieren", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("cell", { name: "Privater Beispielkauf", exact: true })).toBeVisible();
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
  const blockSecurityStorage = (securityKey: string) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === securityKey) throw new DOMException("Full", "QuotaExceededError");
      original.call(this, key, value);
    };
  };
  await page.addInitScript(blockSecurityStorage, SECURITY_MODE_KEY);
  await page.evaluate(blockSecurityStorage, SECURITY_MODE_KEY);
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
