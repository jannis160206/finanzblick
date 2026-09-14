import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState, Transaction } from "../src/lib/types";

const key = "finanzdashboard.v1";
const row = (id: string, description: string, amount = -8, date = "2026-09-13"): Transaction => ({
  id, description, amount, date, bank: "Revolut", pocket: null, category: "Sonstiges", includeInPlan: true,
});
async function seed(page: Page, transactions: Transaction[]) {
  const state = createSeed();
  state.settings.asOf = "2026-09-14";
  state.transactions = transactions;
  await page.clock.setFixedTime(new Date("2026-09-14T12:00:00Z"));
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  await page.goto("/umsaetze");
  await saved(page);
}
async function saved(page: Page): Promise<AppState> {
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible();
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}

test("small review control and nav share a persisted exact count, then hide zero badges", async ({ page }) => {
  const transactions = [row("one", "Neuer Laden"), row("two", "Neuer Laden", -12),
    { ...row("empty", "Weiterer Laden"), category: "Prüfen" as const },
    row("bipa", "bIpA"), row("hotspot", "HOTSPOT"), row("mensa", "Mensa")];
  await seed(page, transactions);
  const control = page.getByRole("button", { name: /^Zuordnung prüfen/ });
  const nav = page.locator("aside").getByRole("link", { name: /^Umsätze/ });
  await expect(control).toHaveCSS("width", "36px");
  await expect(control).toHaveCSS("height", "36px");
  await expect(control).not.toContainText("Zuordnung prüfen");
  await expect(control.getByLabel("3 offene Zuordnungen")).toBeVisible();
  await expect(nav.getByLabel("3 offene Zuordnungen")).toBeVisible();
  await expect(page.getByRole("button", { name: /Einträge prüfen/ })).toHaveCount(0);
  await control.click();
  const dialog = page.getByRole("dialog");
  for (const name of ["Datum", "Text", "Betrag", "Konto/Pocket"])
    await expect(dialog.getByLabel(name, { exact: true }).first()).toHaveJSProperty("readOnly", true);
  await dialog.getByRole("button", { name: "Später prüfen" }).first().click();
  await saved(page);
  await page.reload();
  await expect(control.getByLabel("3 offene Zuordnungen")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await expect(dialog.getByRole("link", { name: /^Umsätze/ }).getByLabel("3 offene Zuordnungen")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await control.click();
  await dialog.getByLabel("Kategorie", { exact: true }).first().selectOption("Shopping");
  await dialog.getByRole("button", { name: "Zuordnung übernehmen" }).first().click();
  await expect(dialog.getByRole("region", { name: /^Buchung prüfen:/ })).toHaveCount(1);
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Gesundheit");
  await dialog.getByRole("button", { name: "Zuordnung übernehmen" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(control.locator("span")).toHaveCount(0);
  await expect(nav.locator("span")).toHaveCount(0);
  const state = await saved(page);
  expect(state.reviewQueue).toEqual([]);
  expect(state.transactions.slice(0, 2).map((item) => item.category)).toEqual(["Shopping", "Shopping"]);
  expect(state.transactions.map(({ id, amount, date, description, bank, pocket }) => ({ id, amount, date, description, bank, pocket })))
    .toEqual(transactions.map(({ id, amount, date, description, bank, pocket }) => ({ id, amount, date, description, bank, pocket })));
  await page.reload();
  await expect(control.locator("span")).toHaveCount(0);
});

test("September footer includes August payroll, half travel spend and no repayment income", async ({ page }) => {
  await seed(page, [row("salary", "Gehalt", 3000, "2026-08-28"), row("travel", "Swiss", -400, "2026-09-03"),
    row("lunch", "BIPA", -8), row("repay", "Überweisung Piber Raphael Urlaub", 203, "2026-09-11"),
    { ...row("internal", "Transfer intern", -100), category: "Transfer intern" }]);
  await expect(page.getByLabel("Monat filtern")).toHaveValue("2026-09");
  await expect(page.getByText("4 Treffer", { exact: true })).toBeVisible();
  await expect(page.locator("strong").filter({ hasText: "2.792,00" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Swiss" })).toContainText(/400,00.*Eigenanteil 200,00.*Forderung ausgeglichen/);
  await expect(page.getByRole("row").filter({ hasText: "Piber Raphael" })).toContainText("kein Einkommen");
  await page.getByLabel("Monat filtern").selectOption("2026-08");
  await expect(page.getByText("0 Treffer", { exact: true })).toBeVisible();
  await page.getByLabel("Monat filtern").selectOption("2026-09");
  await page.getByText("Weitere Filter", { exact: true }).click();
  await page.getByLabel("Transfers anzeigen").check();
  await expect(page.getByText("5 Treffer", { exact: true })).toBeVisible();
  await expect(page.locator("strong").filter({ hasText: "2.692,00" })).toBeVisible();
});

test("backup exists only in Settings and no Excel-skip banner appears", async ({ page }) => {
  await seed(page, []);
  for (const url of ["/", "/umsaetze", "/monate", "/pockets", "/plan"]) {
    await page.goto(url);
    await expect(page.getByText("Sicherung", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Excel-Datei auswählen")).toHaveCount(0);
    await expect(page.getByText(/ungültige Excel-Zeilen|Originaldatei ist unverändert/)).toHaveCount(0);
  }
  await page.goto("/einstellungen");
  await expect(page.getByRole("region", { name: "Sicherung", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Exportieren", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Wiederherstellen", exact: true })).toBeVisible();
  await expect(page.locator("header").getByText(/Sicherung|Exportieren|Wiederherstellen/)).toHaveCount(0);
});
