import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";
import type { Transaction } from "../src/lib/types";

const storageKey = "finanzdashboard.v1";
const booking = (id: string, description: string, category: Transaction["category"], date = "2026-09-10"): Transaction => ({
  id, description, date, amount: -12, category, categoryOverride: true,
  bank: "Revolut", pocket: null, includeInPlan: true, reviewed: true,
});

// Der Sichtschutz ist per Voreinstellung deaktiviert (siehe beforeEach); beim Hydratisieren ist er kurz aktiv.
async function unlocked(page: Page) {
  await expect(page.getByRole("button", { name: /^Sicherheitsmodus (aktivieren|deaktivieren)$/ })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-security-mode", "locked");
}

test.beforeEach(async ({ page }) => {
  const state = createSeed();
  state.settings.asOf = "2026-09-15";
  state.transactions = [
    booking("food-1", "Billa Zentrum", "Lebensmittel"),
    booking("food-old", "Spar Altmonat", "Lebensmittel", "2026-08-20"),
    booking("out-1", "Restaurant Linde", "Restaurants"),
  ];
  await page.clock.setFixedTime(new Date("2026-09-15T12:00:00Z"));
  await page.addInitScript(
    ({ key, state, activation }) => {
      localStorage.setItem(activation, "off");
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
    },
    { key: storageKey, state, activation: SECURITY_ACTIVATION_KEY },
  );
});

test("budget card opens exactly its bookings; filter survives reload and back navigation", async ({ page }) => {
  await page.goto("/plan");
  await unlocked(page);
  await page.getByRole("link", { name: "Lebensmittel & Haushalt" }).click();
  await expect(page).toHaveURL(/\/umsaetze\?month=2026-09&group=food$/);
  await unlocked(page);
  await expect(page.getByText("Billa Zentrum")).toBeVisible();
  await expect(page.getByText("Restaurant Linde")).toHaveCount(0);
  await expect(page.getByText("Spar Altmonat")).toHaveCount(0);

  await page.reload();
  await unlocked(page);
  await expect(page.getByText("Billa Zentrum")).toBeVisible();
  await expect(page.getByText("Restaurant Linde")).toHaveCount(0);

  await page.getByRole("link", { name: "Budgetdetails", exact: true }).first().click();
  await expect(page).toHaveURL(/\/plan$/);
  await page.goBack();
  await unlocked(page);
  await expect(page).toHaveURL(/\/umsaetze\?month=2026-09&group=food$/);
  await expect(page.getByText("Billa Zentrum")).toBeVisible();
  await expect(page.getByText("Restaurant Linde")).toHaveCount(0);

  await page.getByRole("button", { name: /Budget: Lebensmittel/ }).click();
  await expect(page).toHaveURL(/\/umsaetze\?month=2026-09$/);
  await expect(page.getByText("Restaurant Linde")).toBeVisible();
});
test("invalid URL parameters are ignored and search text never reaches the URL", async ({ page }) => {
  await page.goto("/umsaetze?month=9999-99&group=nope");
  await unlocked(page);
  await expect(page.getByText("Restaurant Linde")).toBeVisible();
  await expect(page.getByText(/Budget:/)).toHaveCount(0);
  await page.getByLabel("Umsätze durchsuchen").fill("Billa");
  await expect(page.getByText("Restaurant Linde")).toHaveCount(0);
  expect(page.url()).not.toContain("Billa");
});
