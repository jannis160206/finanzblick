import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";

test.skip(process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1", "Requires an isolated account-mode test database.");

async function showSettings(page: Page) {
  const privacy = page.getByRole("button", { name: /^Sicherheitsmodus (deaktivieren|aktivieren)$/ });
  await expect(privacy).toBeEnabled();
  if (await privacy.getAttribute("aria-pressed") === "true") await privacy.click();
  await expect(page.getByRole("heading", { name: "Profil & Einstellungen" })).toBeVisible();
}

async function settings(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Benutzername", { exact: true }).fill("admin");
  await page.getByLabel("Passwort", { exact: true }).fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
  await page.goto("/einstellungen");
  await showSettings(page);
}

for (const width of [1440, 390]) {
  test(`redesigned settings preserve profile, confirmed edits and layout at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await settings(page);
    const profile = await page.locator("#profil").innerHTML();
    const appearance = page.getByRole("region", { name: "Erscheinungsbild" });
    await appearance.getByRole("radio", { name: "Blau", exact: true }).check();
    await expect(page.locator("html")).toHaveCSS("--user-accent", "#60a5fa");
    await appearance.getByRole("button", { name: "Verwerfen" }).click();
    await expect(appearance.getByRole("radio", { name: "Mint" })).toBeChecked();
    await appearance.getByRole("radio", { name: "Violett", exact: true }).check();
    await appearance.getByRole("checkbox", { name: "Bewegung reduzieren" }).check();
    await appearance.getByRole("button", { name: "Einstellungen speichern" }).click();
    await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
    await page.reload();
    await showSettings(page);
    await expect(appearance.getByRole("radio", { name: "Violett" })).toBeChecked();
    await expect(appearance.getByRole("checkbox", { name: "Bewegung reduzieren" })).toBeChecked();
    await expect(page.locator("#profil")).toHaveJSProperty("innerHTML", profile);

    await appearance.getByRole("radio", { name: "Weihnachten", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "christmas");
    await page.reload();
    await showSettings(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "christmas");
    await appearance.getByRole("button", { name: "Automatisch (Saison)" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", "christmas");

    await page.getByRole("button", { name: "Sparziel hinzufügen" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill(`Kamera ${width}`);
    await dialog.getByLabel("Zielbetrag", { exact: true }).fill("1200");
    await dialog.getByLabel("Zieldatum").fill("2027-04-01");
    for (let step = 0; step < 4; step++) await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    await dialog.getByRole("button", { name: "Sparziel anlegen", exact: true }).click();
    const goal = page.getByRole("article", { name: `Sparziel Kamera ${width}`, exact: true });
    await expect(goal.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    await goal.getByRole("button", { name: `Kamera ${width} bearbeiten` }).click();
    await dialog.getByLabel("Zielbetrag", { exact: true }).fill("1500");
    await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await expect(goal).toContainText("1.200,00");
    await expect(page.getByRole("region", { name: "Sicherung" }).getByRole("button", { name: "Exportieren" })).toBeVisible();
    for (const size of width === 390 ? [390, 320] : [1440, 1024]) {
      await page.setViewportSize({ width: size, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    }
    await page.setViewportSize({ width, height: 1000 });
    if (process.env.FINANZBLICK_SETTINGS_ARTIFACTS) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page.locator("#profil")).toBeInViewport();
      await page.screenshot({ path: join(process.env.FINANZBLICK_SETTINGS_ARTIFACTS, `settings-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Farbschema wechseln" }).click();
    await expect(page.locator("html")).toHaveClass(/light/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    if (process.env.FINANZBLICK_SETTINGS_ARTIFACTS) {
      await page.screenshot({ path: join(process.env.FINANZBLICK_SETTINGS_ARTIFACTS, `settings-${width}-light.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Farbschema wechseln" }).click();
    await goal.getByRole("button", { name: `Kamera ${width} Menü` }).click();
    await page.getByRole("menuitem", { name: "Entfernen", exact: true }).click();
    await dialog.getByRole("button", { name: "Entfernen", exact: true }).click();
    await expect(goal).toHaveCount(0);
    await appearance.getByRole("radio", { name: "Mint" }).check();
    await appearance.getByRole("checkbox", { name: "Bewegung reduzieren" }).uncheck();
    await appearance.getByRole("button", { name: "Einstellungen speichern" }).click();
    await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
    expect(errors).toEqual([]);
  });
}
