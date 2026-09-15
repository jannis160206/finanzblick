import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState, Transaction } from "../src/lib/types";

const key = "finanzdashboard.v1";
const row = (id: string, description: string, amount: number, date = "2026-09-05", category: Transaction["category"] = "Lebensmittel"): Transaction =>
  ({ id, description, amount, date, category, includeInPlan: true, categoryOverride: true, bank: "Revolut", pocket: null });
const readState = (page: Page): Promise<AppState> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
async function seed(page: Page, transactions: Transaction[]) {
  const state = createSeed();
  state.transactions = transactions;
  state.financeRows = [];
  state.settings.asOf = "2026-09-15";
  await page.clock.setFixedTime(new Date("2026-09-15T12:00:00Z"));
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  await page.goto("/umsaetze");
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeAttached();
  await expect.poll(async () => (await readState(page)).financeRows.filter((row) => row.kind === "variable").length).toBe(7);
}

test("choose several charges; import Raphael payment; mark the other paid without losing history", async ({ page }) => {
  await seed(page, [row("billa", "BILLA", -100), row("sakura", "Sakura", -80, "2026-09-04", "Ausgehen"), row("flight", "Swiss", -400)]);
  const control = page.getByRole("button", { name: "Geteilt", exact: true });
  await expect(control.locator("span")).toHaveCount(0);
  await control.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Geteilte Buchungen suchen").fill("billa");
  await dialog.getByLabel("Geteilt Monat", { exact: true }).fill("2026-08");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByLabel("Geteilt Monat", { exact: true }).fill("2026-09");
  await dialog.getByLabel("Geteilt Gesamtbetrag").fill("100,00");
  await dialog.getByRole("checkbox", { name: "Teilen: BILLA 2026-09-05" }).check();
  await dialog.getByLabel("Geteilt Gesamtbetrag").fill("");
  await dialog.getByLabel("Geteilte Buchungen suchen").fill("Sakura");
  await dialog.getByRole("checkbox", { name: "Teilen: Sakura 2026-09-04" }).check();
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await control.click();
  await expect(dialog.getByText("Offen", { exact: true })).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(control.getByLabel("2 offene Teilungen")).toBeVisible();
  await expect(page.getByLabel("Offene geteilte Kosten")).toContainText("Meine Hälfte 50,00");
  await expect(page.getByRole("row").filter({ hasText: "Swiss" })).not.toContainText("Meine Hälfte");
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles({ name: "repayment.csv", mimeType: "text/csv",
    buffer: Buffer.from("Revolut\nDatum,Beschreibung,Betrag\n2026-09-12,Raphael,50") });
  await expect(control.getByLabel("1 offene Teilungen")).toBeVisible();
  await expect(page.getByLabel("Offene geteilte Kosten")).not.toContainText("BILLA");
  await expect(page.getByRole("row").filter({ hasText: "Raphael" })).toContainText("kein Einkommen");
  await control.click();
  await expect(dialog.getByText("Bezahlt", { exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "Als bezahlt markieren: Sakura" }).click();
  await expect(dialog.getByText("Bezahlt", { exact: true })).toHaveCount(2);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(control.locator("span")).toHaveCount(0);
  await expect(page.getByLabel("Offene geteilte Kosten")).toHaveCount(0);
  await expect.poll(async () => (await readState(page)).transactions.find((item) => item.id === "sakura")?.sharedPaidManually).toBe(true);
  await page.reload();
  await expect(control.locator("span")).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "BILLA" })).toContainText(/50,00.*Gesamt 100,00.*Bezahlt/);
  await expect(page.locator("strong").filter({ hasText: "490,00" })).toBeVisible();
  expect((await readState(page)).transactions.filter((item) => ["billa", "sakura", "flight"].includes(item.id)).map((item) => item.amount)).toEqual([-100, -80, -400]);
});

test("save several short holiday ranges; retain recurring BILLA and fixed costs; delete and reload", async ({ page }) => {
  await seed(page, [row("home", "BILLA", -100, "2026-06-20"), row("home-trip", "BILLA", -100),
    row("foreign-july", "Mercado extranjero", -400, "2026-07-05"), row("foreign-sep", "Mercado extranjero", -400),
    row("fixed", "A1 Telekom", -30, "2026-09-05", "Telefon & Internet")]);
  await page.getByRole("button", { name: "Urlaub", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Von", { exact: true }).fill("2026-07-01");
  await dialog.getByLabel("Bis", { exact: true }).fill("2026-07-26");
  await dialog.getByRole("button", { name: "Zeitraum speichern" }).click();
  await expect(dialog.getByRole("alert")).toContainText("25 Tagen");
  await dialog.getByLabel("Bis", { exact: true }).fill("2026-07-10");
  await dialog.getByRole("button", { name: "Zeitraum speichern" }).click();
  await dialog.getByLabel("Von", { exact: true }).fill("2026-09-01");
  await dialog.getByLabel("Bis", { exact: true }).fill("2026-09-10");
  await dialog.getByRole("button", { name: "Zeitraum speichern" }).click();
  await expect(dialog.getByLabel("Aktive Urlaubszeiträume").getByRole("button")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Fertig" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Mercado extranjero" })).toContainText("Urlaub");
  await expect(page.getByRole("row").filter({ hasText: "BILLA" })).toContainText("Lebensmittel");
  await expect(page.getByRole("row").filter({ hasText: "A1 Telekom" })).toContainText("Telefon & Internet");
  await expect.poll(async () => (await readState(page)).holidayRanges?.length).toBe(2);
  await page.reload();
  await expect(page.getByLabel("Aktive Urlaubszeiträume").getByRole("button")).toHaveCount(2);
  await expect(page.getByRole("row").filter({ hasText: "Mercado extranjero" })).toContainText("Urlaub");
  await page.getByRole("button", { name: "Urlaub löschen: 2026-09-01 bis 2026-09-10" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Mercado extranjero" })).toContainText("Lebensmittel");
  await expect.poll(async () => (await readState(page)).holidayRanges?.length).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Urlaub", exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
});

test("sharing modal stays within a laptop screen with visible close and save controls; cancel discards changes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seed(page, Array.from({ length: 150 }, (_, i) => row(`row-${i}`, `Einkauf ${i}`, -20)));
  const control = page.getByRole("button", { name: "Geteilt", exact: true });
  await control.click();
  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: "Geteilt schließen" });
  const save = dialog.getByRole("button", { name: "Speichern", exact: true });
  await expect(close).toBeInViewport();
  await expect(save).toBeInViewport();
  expect(await dialog.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(720 * 0.8 + 1);
  const list = dialog.getByLabel("Buchungslisten", { exact: true });
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(close).toBeInViewport();
  await expect(save).toBeInViewport();
  await expect(dialog.getByLabel("Geteilte Buchungen suchen")).toBeInViewport();
  await dialog.getByRole("checkbox").first().check();
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  expect((await readState(page)).transactions.some((row) => row.sharedWithRaphael)).toBe(false);
  await control.click();
  await expect(dialog.getByRole("checkbox").first()).not.toBeChecked();
  await close.click();
  await expect(dialog).toHaveCount(0);
  await control.click();
  await dialog.getByRole("checkbox").first().check();
  await save.click();
  await expect(control.getByLabel("1 offene Teilungen")).toBeVisible();
});

test("mobile sharing discards unsaved paid status on cancel, close and Escape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, [{ ...row("shared", "BILLA", -100), sharedWithRaphael: true }]);
  const control = page.getByRole("button", { name: "Geteilt", exact: true });
  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: "Geteilt schließen" });
  const save = dialog.getByRole("button", { name: "Speichern", exact: true });
  for (const action of ["cancel", "close", "escape"]) {
    await control.click();
    await expect(close).toBeInViewport();
    await expect(save).toBeInViewport();
    expect(await dialog.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
    await dialog.getByRole("button", { name: "Als bezahlt markieren: BILLA" }).click();
    await expect(dialog.getByText("Bezahlt", { exact: true })).toBeVisible();
    expect((await readState(page)).transactions[0].sharedPaidManually).not.toBe(true);
    if (action === "cancel") await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
    else if (action === "close") await close.click();
    else await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(control.getByLabel("1 offene Teilungen")).toBeVisible();
    expect((await readState(page)).transactions[0].sharedPaidManually).not.toBe(true);
  }
  await control.click();
  await dialog.getByRole("button", { name: "Als bezahlt markieren: BILLA" }).click();
  await save.click();
  await expect(control.getByLabel("1 offene Teilungen")).toHaveCount(0);
  await expect.poll(async () => (await readState(page)).transactions[0].sharedPaidManually).toBe(true);
  await page.reload();
  await control.click();
  await expect(dialog.getByText("Bezahlt", { exact: true })).toBeVisible();
});
