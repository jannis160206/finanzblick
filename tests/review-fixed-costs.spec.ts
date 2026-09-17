import { expect, test, type Page } from "@playwright/test";
import { actualBookings, calculateDashboard } from "../src/lib/calc";
import { createSeed } from "../src/lib/seed";
import type { AppState, Transaction } from "../src/lib/types";

const key = "finanzdashboard.v1";
const statement = {
  name: "Vertragspruefung.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("Buchungsdatum;Verwendungszweck/Text;Valuta;Betrag\n10.09.2026;Komet Tarif;10.09.2026;-19,99\n10.09.2026;Arktis Tarif;10.09.2026;-29,99"),
};
async function saved(page: Page): Promise<AppState> {
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toHaveCount(1);
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}
async function seed(page: Page, transactions: Transaction[] = []) {
  const state = createSeed();
  state.settings.asOf = "2026-09-17";
  state.settings.baselineDate = "2026-09-01";
  state.transactions = transactions;
  state.fixedReceipts = [];
  await page.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  await page.goto("/umsaetze");
  return saved(page);
}

test("reviewed phone payments stay ordinary unless marked fixed, persist and remain editable", async ({ page }) => {
  const before = await seed(page);
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles(statement);
  const dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
  const ordinary = dialog.getByRole("region", { name: "Buchung prüfen: Komet Tarif", exact: true });
  const fixed = dialog.getByRole("region", { name: "Buchung prüfen: Arktis Tarif", exact: true });
  await ordinary.getByLabel("Kategorie", { exact: true }).selectOption("Telefon & Internet");
  await expect(ordinary.getByRole("checkbox", { name: "Als Fixkosten markieren" })).not.toBeChecked();
  await ordinary.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
  await expect(ordinary).toHaveCount(0);
  await fixed.getByLabel("Kategorie", { exact: true }).selectOption("Telefon & Internet");
  const checkbox = fixed.getByRole("checkbox", { name: "Als Fixkosten markieren" });
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await expect(fixed).toContainText("Es wird kein neuer Planbetrag angelegt.");
  await fixed.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let state = await saved(page);
  expect(state.transactions).toHaveLength(2);
  expect(state.transactions.find((row) => row.description === "Komet Tarif")).toMatchObject({
    category: "Telefon & Internet", fixedCost: false, includeInPlan: true, amount: -19.99, date: "2026-09-10",
  });
  expect(state.transactions.find((row) => row.description === "Arktis Tarif")).toMatchObject({
    category: "Telefon & Internet", fixedCost: true, includeInPlan: false, amount: -29.99, date: "2026-09-10",
  });
  expect(state.financeRows).toEqual(before.financeRows);
  expect(actualBookings(state)).toHaveLength(2);
  expect(calculateDashboard(state).current.actualSpending).toBe(49.98);
  await page.reload();
  expect((await saved(page)).transactions).toEqual(state.transactions);
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles(statement);
  await expect(page.getByText("0 neu, 2 Duplikate ignoriert", { exact: true })).toBeVisible();
  expect((await saved(page)).transactions).toEqual(state.transactions);
  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Arktis Tarif", exact: true }) });
  await expect(row.getByText("Fixkosten", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Zuordnung ändern: Arktis Tarif", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Zuordnung ändern", exact: true });
  await expect(edit.getByRole("checkbox", { name: "Als Fixkosten markieren" })).toBeChecked();
  await edit.getByRole("checkbox", { name: "Als Fixkosten markieren" }).uncheck();
  await edit.getByRole("button", { name: "Abbrechen", exact: true }).click();
  expect((await saved(page)).transactions).toEqual(state.transactions);
  await row.getByRole("button", { name: "Zuordnung ändern: Arktis Tarif", exact: true }).click();
  await edit.getByRole("checkbox", { name: "Als Fixkosten markieren" }).uncheck();
  await edit.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
  await expect(edit).toHaveCount(0);
  state = await saved(page);
  expect(state.transactions.find((row) => row.description === "Arktis Tarif")).toMatchObject({ fixedCost: false, includeInPlan: true });
  expect(state.financeRows).toEqual(before.financeRows);
  expect(actualBookings(state)).toHaveLength(2);
  expect(calculateDashboard(state).current.actualSpending).toBe(49.98);
  await expect(row.getByText("Fixkosten", { exact: true })).toHaveCount(0);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }, { width: 844, height: 390 }]) {
  test(`fixed-cost review option fits and saves a ledger review at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const original: Transaction = {
      id: "review-fixed-layout", date: "2026-09-10", description: "Komet Tarif",
      amount: -19.99, category: "Prüfen", bank: "Revolut", pocket: null, includeInPlan: false,
    };
    const before = await seed(page, [original]);
    await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
    const dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
    await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Telefon & Internet");
    const checkbox = dialog.getByRole("checkbox", { name: "Als Fixkosten markieren" });
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    const marker = checkbox.locator("..");
    expect((await marker.boundingBox())!.height).toBeLessThanOrEqual(44);
    await expect(marker).toHaveCSS("border-top-width", "0px");
    await expect(marker.locator("svg")).toHaveCount(0);
    const button = dialog.getByRole("button", { name: "Zuordnung übernehmen", exact: true });
    await button.scrollIntoViewIfNeeded();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.width).toBeLessThanOrEqual(720);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await expect(dialog.getByRole("button", { name: "Prüfung schließen", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("fixed-cost-choice.png") });
    await button.click();
    await expect(dialog).toHaveCount(0);
    const state = await saved(page);
    expect(state.transactions).toEqual([{
      ...original, category: "Telefon & Internet", categoryOverride: true, fixedCost: true,
    }]);
    expect(state.financeRows).toEqual(before.financeRows);
    expect(actualBookings(state)).toHaveLength(1);
  });
}
