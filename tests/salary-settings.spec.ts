import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";
import type { AppState } from "../src/lib/types";
import { payrollFixture } from "./fixtures/payroll-state";
import { pocketFixture } from "./fixtures/pocket-state";

// Nur synthetische Daten (Fixtures bzw. createSeed, per localStorage eingespielt); Bank-API und Logos sind gemockt.
const storageKey = "finanzdashboard.v1";
const blocking = new Set(["critical", "serious"]);
const widths = [375, 768, 1440] as const;
const themes = ["light", "dark"] as const;
type Theme = (typeof themes)[number];
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

async function prepare(page: Page, width: number, theme: Theme, state?: AppState) {
  await page.clock.setFixedTime(new Date("2026-10-15T12:00:00Z"));
  await page.setViewportSize({ width, height: width < 768 ? 812 : 1000 });
  await page.addInitScript(
    ({ key, json, theme, activation }) => {
      localStorage.setItem("theme", theme);
      localStorage.setItem(activation, "off");
      if (json && !localStorage.getItem(key)) localStorage.setItem(key, json);
    },
    { key: storageKey, json: state ? JSON.stringify(state) : "", theme, activation: SECURITY_ACTIVATION_KEY },
  );
}

async function settled(page: Page, theme: Theme) {
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

async function axe(page: Page, scope = "main") {
  // Contrast is measured once entrance transitions have finished.
  await page.waitForTimeout(800);
  const { violations } = await new AxeBuilder({ page }).include(scope)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.filter((item) => blocking.has(item.impact ?? "")).flatMap((item) =>
    item.nodes.slice(0, 6).map((node) => `${item.id}: ${node.target.join(" ")} – ${node.failureSummary?.split("\n").slice(-1)[0] ?? ""}`))).toEqual([]);
}

async function logoLoaded(scope: Locator) {
  await expect(scope.locator("[data-bank-logo] img").first()).toHaveClass(/opacity-100/);
}

for (const width of widths) {
  for (const theme of themes) {
    test(`Gehalt & Steuern leads with Brutto → Netto at ${width}px (${theme})`, async ({ page }) => {
      await prepare(page, width, theme, payrollFixture());
      await page.goto("/gehalt-steuern");
      await expect(page.getByRole("heading", { level: 1, name: "Gehalt & Steuern" })).toBeVisible();
      const focus = page.getByRole("region", { name: /^Gehalt \S+ 2026$/ });
      await expect(focus).toBeVisible();
      await expect(focus.getByRole("list", { name: "Aufteilung des Bruttos" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Jahr bisher" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Monate 2026" }).getByRole("listitem")).toHaveCount(12);
      await page.getByLabel("Monat", { exact: true }).selectOption("1");
      await expect(page.getByRole("region", { name: "Gehalt Jänner 2026" })).toBeVisible();
      await settled(page, theme);
      await axe(page);
    });

    test(`settings open categories and deep links at ${width}px (${theme})`, async ({ page }) => {
      await prepare(page, width, theme, createSeed());
      await page.goto("/einstellungen#sicherung");
      await expect(page.getByRole("region", { name: "Sicherung" })).toBeVisible();
      await settled(page, theme);
      await axe(page);
      if (width < 1024) await page.getByRole("button", { name: "Alle Einstellungen" }).click();
      await page.getByRole("link", { name: /^Darstellung/ }).click();
      await expect(page.getByRole("region", { name: "Erscheinungsbild" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Sicherung" })).toBeHidden();
      await settled(page, theme);
    });
  }
}

test("Gehalt & Steuern without payslips starts with the import at 375px", async ({ page }) => {
  const state = createSeed();
  state.payslips = [];
  await prepare(page, 375, "light", state);
  await page.goto("/gehalt-steuern");
  await expect(page.getByText("Noch keine Lohnabrechnungen für 2026")).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF auswählen", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Gehalt / })).toHaveCount(0);
  await settled(page, "light");
});

for (const [width, theme] of [[375, "light"], [1440, "dark"]] as const) {
  test(`savings goal includes Trade Republic only as a deliberate exception at ${width}px (${theme})`, async ({ page }) => {
    const state = pocketFixture();
    state.trBalances = [{ date: "2026-10-09", balance: 9000 }];
    state.settings.emergencyTarget = 2000;
    await prepare(page, width, theme, state);
    await page.goto("/sparen");
    await page.getByRole("button", { name: "Sparziel hinzufügen" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Sparziel hinzufügen" });
    await dialog.getByLabel("Name", { exact: true }).fill("Auto");
    await dialog.getByLabel("Zielbetrag").fill("40000");
    await dialog.getByLabel("Zieldatum").fill("2027-06-30");
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    await expect(dialog.getByRole("group", { name: "Startkapital" })).toBeVisible();
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    const tr = dialog.getByRole("listitem").filter({ hasText: "Trade Republic · Notgroschen" });
    await expect(tr.getByLabel("Mindestens behalten")).toHaveCount(0);
    await tr.getByRole("switch", { name: "Als Ausnahme einbeziehen" }).click();
    await expect(tr.getByLabel("Mindestens behalten")).toHaveValue("2.000,00");
    await settled(page, theme);
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    const plan = dialog.getByRole("group", { name: "Verteilung" });
    await expect(plan.getByLabel(/^Betrag .+, Trade Republic$/)).toHaveValue("7.000,00");
    await expect(plan.getByLabel("Monat Trade Republic")).toBeVisible();
    await settled(page, theme);
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    await expect(dialog.getByRole("group", { name: "Übersicht" }).getByRole("listitem").filter({ hasText: "Trade Republic" })).toBeVisible();
    await axe(page, '[role="dialog"]');
    await dialog.getByRole("button", { name: "Sparziel anlegen" }).click();
    await expect(dialog).toBeHidden();
  });
}

test.describe("account mode", () => {
  test.skip(process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1", "Requires an isolated account-mode test database.");

  const now = Date.parse("2026-10-15T12:00:00Z");
  const status = {
    available: true, configured: true, provider: "enablebanking", lastSync: now - 2 * 3_600_000, lastSyncRows: 12, lastError: null,
    connections: [
      { id: "c1", bankName: "Raiffeisenbank Kärnten", bic: "RZKTAT2K", syncActive: true, message: null, consentValidUntil: "2027-03-01T00:00:00Z", lastSynced: "2026-10-15T09:00:00Z", testmode: false, country: "AT" },
      { id: "c2", bankName: "Trade Republic", bic: null, syncActive: false, message: "Freigabe abgelaufen", consentValidUntil: "2026-10-01T00:00:00Z", lastSynced: null, testmode: false, country: "AT" },
    ],
    accounts: [
      { id: "a1", connectionId: "c1", bank: "Raiffeisen", pocket: "Raiffeisen Giro", label: "Girokonto", iban: "AT61 1904 3002 3457 3201", balance: 1834.2, available: null, balanceDate: null, syncedAt: now - 3 * 3_600_000, fetchedRows: 12, balanceOk: true, syncError: null },
    ],
  };
  const banks = ["Bank Austria", "Erste Bank und Sparkassen", "Raiffeisenbank Kärnten", "Trade Republic", "Volksbank Wien"]
    .map((name) => ({ name, country: "AT", logo: null }));

  async function signIn(page: Page) {
    await page.route("**/api/bank?banks=*", (route) => route.fulfill({ json: { banks } }));
    await page.route(/\/api\/bank(\?.*)?$/, (route) => route.request().url().includes("banks=") ? route.fallback() : route.fulfill({ json: status }));
    await page.route("**/api/banks/logo**", (route) => /Raiffeisen|Erste/.test(decodeURIComponent(route.request().url()))
      ? route.fulfill({ body: pixel, contentType: "image/png" }) : route.fulfill({ status: 404, body: "" }));
    await page.route("**/api/mail**", (route) => route.fulfill({ json: { connected: false, orders: [] } }));
    await page.goto("/login");
    await page.getByLabel("Benutzername", { exact: true }).fill("admin");
    await page.getByLabel("Passwort", { exact: true }).fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
  }

  for (const [width, theme] of [[375, "dark"], [1440, "light"]] as const) {
    test(`bank connections show logos, deep link and the add-bank search at ${width}px (${theme})`, async ({ page }) => {
      await prepare(page, width, theme);
      await signIn(page);
      await page.goto("/einstellungen#bankverbindung");
      const section = page.getByRole("region", { name: "Bankverbindung" });
      await expect(section).toBeVisible();
      const raiffeisen = section.getByRole("listitem").filter({ hasText: "Raiffeisenbank Kärnten" });
      await logoLoaded(raiffeisen);
      await expect(raiffeisen.getByText(/AT61 •••• 3201/)).toBeVisible();
      const trade = section.getByRole("listitem").filter({ hasText: "Trade Republic" });
      await expect(trade.locator("[data-bank-logo]")).toBeVisible();
      await expect(trade.locator("[data-bank-logo] img")).toHaveCount(0);
      await settled(page, theme);
      await axe(page);

      await section.getByRole("button", { name: "Bank hinzufügen" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Bank hinzufügen" });
      const list = dialog.getByRole("listbox", { name: "Banken" });
      await logoLoaded(list.getByRole("option", { name: "Raiffeisenbank Kärnten" }));
      await dialog.getByRole("combobox", { name: "Bank auswählen" }).fill("erste");
      await expect(list.getByRole("option", { name: "Erste Bank und Sparkassen" })).toBeVisible();
      await expect(list.getByRole("option", { name: "Volksbank Wien" })).toHaveCount(0);
      await axe(page, '[role="dialog"]');
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  }
});
