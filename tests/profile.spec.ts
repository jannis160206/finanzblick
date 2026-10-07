import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

test.skip(process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1", "Requires an isolated account-mode test database.");

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Benutzername", { exact: true }).fill("admin");
  await page.getByLabel("Passwort", { exact: true }).fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
}

test("desktop profile is bottom-left and opens the existing settings cleanly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const sidebar = page.getByRole("complementary");
  const profile = sidebar.getByRole("region", { name: "Benutzerprofil" });
  await expect(profile.getByText("admin", { exact: true })).toBeVisible();
  await expect(profile.getByRole("button", { name: "Abmelden" })).toBeVisible();
  await expect(page.locator("header").getByRole("button", { name: "Abmelden" })).toHaveCount(0);
  const box = await profile.boundingBox();
  expect(box!.y + box!.height).toBeGreaterThan(850);
  expect(box!.x).toBeLessThan(224);
  await profile.getByRole("link", { name: "Einstellungen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Profil & Einstellungen" })).toBeVisible();
  await expect(page.locator("#profil").getByRole("heading", { name: "admin" })).toBeVisible();
  await expect(profile.getByRole("link", { name: "Einstellungen", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Erscheinungsbild", exact: true })).toBeVisible();
  if (process.env.FINANZBLICK_PROFILE_ARTIFACTS)
    await page.screenshot({ path: join(process.env.FINANZBLICK_PROFILE_ARTIFACTS, "profile-desktop.png") });
  await page.locator("#profil").getByRole("link", { name: "Erscheinungsbild" }).click();
  await expect(page).toHaveURL(/#jahreszeit$/);
  const appearance = await page.getByRole("heading", { name: "Erscheinungsbild", exact: true }).boundingBox();
  expect(appearance!.y).toBeGreaterThanOrEqual(76);
  await page.setViewportSize({ width: 1280, height: 600 });
  await expect(profile.getByRole("button", { name: "Abmelden" })).toBeInViewport();
  await expect(sidebar.getByRole("link", { name: "Gehalt & Steuern" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test("mobile drawer keeps the profile at the bottom, closes on settings and logs out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  const menu = page.getByRole("dialog");
  const profile = menu.getByRole("region", { name: "Benutzerprofil" });
  await expect(profile.getByText("admin", { exact: true })).toBeVisible();
  await expect(profile.getByRole("button", { name: "Abmelden" })).toBeInViewport();
  const box = await profile.boundingBox();
  expect(box!.y + box!.height).toBeGreaterThan(790);
  if (process.env.FINANZBLICK_PROFILE_ARTIFACTS)
    await page.screenshot({ path: join(process.env.FINANZBLICK_PROFILE_ARTIFACTS, "profile-mobile-menu.png") });
  await profile.getByRole("link", { name: "Einstellungen", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole("heading", { name: "Profil & Einstellungen" })).toBeVisible();
  if (process.env.FINANZBLICK_PROFILE_ARTIFACTS)
    await page.screenshot({ path: join(process.env.FINANZBLICK_PROFILE_ARTIFACTS, "profile-mobile-settings.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.locator("#profil").getByRole("link", { name: "Erscheinungsbild" }).click();
  await expect(page).toHaveURL(/#jahreszeit$/);
  await expect(page.getByRole("heading", { name: "Erscheinungsbild", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await profile.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);
});
