import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { currency } from "../src/lib/format";
import type { Transaction } from "../src/lib/types";

const storageKey = "finanzdashboard.v1";
const booking = (patch: Partial<Transaction>): Transaction => ({
  id: "test", date: "2026-09-12", description: "Test", amount: -5,
  bank: "Raiffeisen", pocket: null, category: "Prüfen", includeInPlan: true, ...patch,
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-15T12:00:00Z"));
  const state = createSeed();
  state.settings.asOf = "2026-09-15";
  state.settings.baselineDate = "2026-09-01";
  state.transactions = [
    booking({ id: "grocery", description: "BILLA", amount: -42, time: "18:00:00", rawDescription: "Kartenzahlung BILLA", rawDetails: ["Filiale Teststadt"], bankReference: "TEST-REF-42" }),
    booking({ id: "pending", description: "Kulturhaus Teststadt", amount: -27, pocket: "Raiffeisen Giro" }),
    booking({ id: "lunch", description: "BIPA", bank: "Revolut", pocket: "Mittagessen" }),
    booking({ id: "refund", description: "Erstattung Test", amount: 10, pocket: "Hauptkonto", category: "Rückerstattungen", categoryOverride: true }),
    booking({ id: "old", date: "2026-08-12", description: "Historischer Laden", amount: -18, bank: "Revolut", category: "Bildung", categoryOverride: true }),
  ];
  state.reviewQueue = [];
  state.fixedReceipts = [];
  state.merchantRules = [];
  await page.addInitScript(({ storageKey, state }) => {
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(state));
  }, { storageKey, state });
});

async function ledger(page: Page) {
  await page.goto("/umsaetze");
  await unlock(page);
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
  await expect(page.getByLabel("Buchungen", { exact: true }).locator("tbody tr")).toHaveCount(4);
}

async function unlock(page: Page) {
  const privacy = page.getByRole("button", { name: /^Sicherheitsmodus (deaktivieren|aktivieren)$/ });
  await expect(privacy).toBeEnabled();
  if (await privacy.getAttribute("aria-pressed") === "true") await privacy.click();
}

test("row review indications and explanations preserve every matching ledger row and sum", async ({ page }) => {
  await ledger(page);
  const rows = page.getByLabel("Buchungen", { exact: true }).locator("tbody tr");
  const total = page.getByText("Summe", { exact: false }).filter({ has: page.locator("strong") });
  const pending = rows.filter({ hasText: "Kulturhaus Teststadt" });
  await expect(page.getByRole("group", { name: "Zuordnungsstatus filtern" })).toHaveCount(0);
  await expect(total).toContainText(currency(-64));
  await expect(pending.getByText("Prüfung offen", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Zuordnungsdetails: Kulturhaus Teststadt", exact: true }).click();
  await expect(page.getByText("Kategorie noch offen oder widersprüchlich.", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(4);
  await expect(total).toContainText(currency(-64));
  await page.getByRole("button", { name: "Zuordnung prüfen", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
  await review.getByLabel("Kategorie", { exact: true }).selectOption("Entertainment");
  await review.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(rows.getByText("Prüfung offen", { exact: true })).toHaveCount(0);
  await expect(pending.getByText("Geprüft", { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(4);
  await expect(total).toContainText(currency(-64));
  await page.reload();
  await unlock(page);
  await expect(page.getByRole("group", { name: "Zuordnungsstatus filtern" })).toHaveCount(0);
  await expect(rows).toHaveCount(4);
  await expect(pending.getByText("Geprüft", { exact: true })).toBeVisible();
  await expect(total).toContainText(currency(-64));
});

test("one Raiffeisen account filter includes every legacy alias after reload", async ({ page }) => {
  await ledger(page);
  const account = page.getByLabel("Konto/Pocket filtern", { exact: true });
  const options = await account.locator("option").allTextContents();
  const raiffeisen = options.filter((option) => /Raiffeisen/i.test(option));
  expect(raiffeisen).toEqual(["Raiffeisen · Girokonto"]);
  await account.selectOption({ label: "Raiffeisen · Girokonto" });
  const rows = page.getByLabel("Buchungen", { exact: true }).locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "BILLA" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Erstattung Test" })).toHaveCount(1);
  await page.reload();
  await unlock(page);
  await page.getByLabel("Konto/Pocket filtern", { exact: true }).selectOption({ label: "Raiffeisen · Girokonto" });
  await expect(rows).toHaveCount(3);
});

test("keeps the original design and only adds ledger status in light, dark and mobile", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await unlock(page);
  await expect(page.getByRole("heading", { name: "Übersicht", exact: true })).toBeVisible();
  await expect(page.locator(".metric-card, .review-notice, .ledger-toolbar")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Offene Zuordnungen" })).toHaveCount(0);
  await expect(page.getByText("Ersparnisse gesamt", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/clarity-overview-light.png", fullPage: true });
  await page.getByRole("button", { name: "Farbschema wechseln", exact: true }).click();
  await page.screenshot({ path: "test-results/clarity-overview-dark.png", fullPage: true });
  await page.getByRole("link", { name: "Kontoauszüge importieren", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Summen der gefilterten Umsätze" })).toHaveCount(0);
  await expect(page.locator("thead th")).toHaveText(["Datum", "Beschreibung", "Kategorie", "Betrag", "Konto/Pocket"]);
  await page.screenshot({ path: "test-results/clarity-ledger-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("group", { name: "Zuordnungsstatus filtern" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zuordnung prüfen", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Uploadstatus", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/clarity-ledger-mobile.png", fullPage: true });
  expect(errors).toEqual([]);
});
