import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";

// Läuft ausschließlich mit synthetischen Daten (createSeed, per localStorage eingespielt).
const storageKey = "finanzdashboard.v1";
const pages = [
  { path: "/", heading: "Übersicht" },
  { path: "/umsaetze", heading: "Umsätze" },
  { path: "/budget", heading: "Budget" },
  { path: "/sparen", heading: "Sparen" },
  { path: "/gehalt-steuern", heading: "Gehalt & Steuern" },
  { path: "/einstellungen", heading: "Einstellungen" },
] as const;
const viewports = [
  { width: 375, height: 812, navigation: "bottom" },
  { width: 768, height: 1024, navigation: "rail" },
  { width: 1440, height: 1000, navigation: "sidebar" },
] as const;

function syntheticState() {
  const state = createSeed();
  const rows: [string, string, number, string][] = [
    ["2026-09-01", "Gehalt Arbeitgeber GmbH", 2840, "Gehalt"],
    ["2026-09-02", "Supermarkt Einkauf mit sehr langem Verwendungszweck ohne Leerzeichen-ABCDEFGHIJKLMNOPQRSTUVWXYZ", -46.8, "Lebensmittel"],
    ["2026-09-03", "Streaming Abo", -13.99, "Abonnements"],
    ["2026-09-04", "Tankstelle", -62.4, "Tanken"],
  ];
  state.transactions = rows.map(([date, description, amount, category], index) => ({
    id: `responsive-${index}`, date, description, amount, bank: "Girokonto", pocket: null,
    category, categoryOverride: true, manualCategory: true, reviewed: true, includeInPlan: true,
  })) as typeof state.transactions;
  return state;
}

async function seed(page: Page, theme: "light" | "dark") {
  await page.clock.setFixedTime(new Date("2026-09-12T12:00:00Z"));
  await page.addInitScript(
    ({ key, state, theme, activation }) => {
      localStorage.setItem("theme", theme);
      localStorage.setItem(activation, "off");
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
    },
    { key: storageKey, state: syntheticState(), theme, activation: SECURITY_ACTIVATION_KEY },
  );
}

for (const theme of ["light", "dark"] as const)
  for (const viewport of viewports)
    test(`${viewport.width}px · ${theme}: alle Seiten ohne horizontales Scrollen`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seed(page, theme);
      for (const { path, heading } of pages) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        await expect(page.locator("html")).toHaveClass(new RegExp(theme));
        const sidebar = page.getByRole("complementary").filter({ has: page.getByRole("navigation", { name: "Hauptnavigation" }) });
        const bottom = page.getByRole("navigation", { name: "Schnellnavigation" });
        if (viewport.navigation === "bottom") {
          await expect(bottom).toBeVisible();
          await expect(sidebar).toBeHidden();
        } else {
          await expect(bottom).toBeHidden();
          await expect(sidebar).toBeVisible();
          const width = (await sidebar.boundingBox())?.width ?? 0;
          expect(width, "Rail auf Tablet, volle Sidebar auf Desktop").toBeLessThan(viewport.navigation === "rail" ? 100 : 260);
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${path} bei ${viewport.width}px`).toBeLessThanOrEqual(0);
      }
    });
