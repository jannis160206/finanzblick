import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState, Transaction } from "../src/lib/types";

const key = "finanzdashboard.v1";
const booking: Transaction = {
  id: "design-booking", date: "2026-09-12", description: "Beispielkauf",
  amount: -89.9, bank: "Revolut", pocket: null, category: "Shopping",
  categoryOverride: true, includeInPlan: true,
};
const detailedCategories = [
  "Restaurants", "Lieferdienste", "Cafés & Snacks", "Shopping", "Guthabenkarten", "Porto & Versand",
  "Bildung", "Weiterbildung", "Urlaub", "Miete", "Energie & Nebenkosten",
  "Möbel & Einrichtung", "Reparaturen & Instandhaltung", "Tanken",
  "Öffentliche Verkehrsmittel", "Parken & Maut", "Fahrzeugwartung",
  "Rückerstattungen", "Rücklastschriftgebühren",
];

async function seed(page: Page, transactions = [booking]) {
  const state = createSeed();
  state.transactions = transactions;
  state.fixedReceipts = [];
  state.settings.asOf = "2026-09-17";
  state.settings.baselineDate = "2026-09-01";
  await page.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  await page.goto("/umsaetze");
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zuordnung ändern: Beispielkauf", exact: true })).toBeVisible();
}

const stored = (page: Page): Promise<AppState> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);

test("mobile navigation is a left drawer, keyboard focus returns and layouts fit", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  const trigger = page.getByRole("button", { name: "Navigation öffnen" });
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Finanzblick", exact: true });
  await expect(drawer).toHaveAttribute("data-variant", "navigation");
  await expect.poll(async () => Math.round((await drawer.boundingBox())!.x)).toBe(0);
  expect((await drawer.boundingBox())!.height).toBe(844);
  await expect(drawer.getByRole("link", { name: "Einstellungen", exact: true })).toBeInViewport();
  await expect(drawer.getByRole("link", { name: "Umsätze", exact: true })).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: testInfo.outputPath("mobile-navigation.png") });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await drawer.getByRole("link", { name: "Einstellungen", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Einstellungen", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("category search, draft discard and save preserve bank facts in the new inspector-style form", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seed(page);
  const trigger = page.getByRole("button", { name: "Zuordnung ändern: Beispielkauf", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Zuordnung ändern", exact: true });
  await expect(dialog.getByRole("region", { name: "Originalbuchung" })).toContainText("89,90");
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  const select = dialog.getByLabel("Kategorie", { exact: true });
  await expect(select.locator("option")).toHaveCount(43);
  for (const legacy of ["Ausgehen", "Kleidung & Schuhe", "Elektronik", "Bücher", "Unterkunft", "Flugreisen"])
    await expect(select.locator(`option[value="${legacy}"]`)).toHaveCount(0);
  for (const category of detailedCategories) {
    await select.selectOption(category);
    await expect(select).toHaveValue(category);
  }
  await dialog.getByRole("button", { name: "Kategorie durchsuchen", exact: true }).click();
  const search = page.getByRole("combobox", { name: "Kategorien suchen" });
  await search.fill("porto");
  await expect(page.getByRole("option", { name: "Porto & Versand", exact: true }).filter({ visible: true })).toHaveCount(1);
  await search.press("Enter");
  await expect(page.getByRole("dialog", { name: "Kategoriesuche", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Kategorie", { exact: true })).toHaveValue("Porto & Versand");
  await page.screenshot({ path: testInfo.outputPath("category-dialog.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await stored(page)).transactions[0]).toMatchObject(booking);
  await trigger.click();
  await dialog.getByRole("button", { name: "Kategorie durchsuchen", exact: true }).click();
  await search.fill("nichts-passendes");
  await expect(page.getByRole("status")).toContainText("Keine passende Kategorie");
  await search.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Kategorie durchsuchen", exact: true })).toBeFocused();
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Porto & Versand");
  await dialog.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await stored(page)).transactions[0].category).toBe("Porto & Versand");
  const saved = (await stored(page)).transactions[0];
  expect(saved).toMatchObject({ ...booking, category: "Porto & Versand" });
  await page.reload();
  await page.getByLabel("Kategorie filtern").selectOption("Porto & Versand");
  await expect(page.getByRole("cell", { name: "Beispielkauf", exact: true })).toBeVisible();
  await page.goto("/plan");
  await page.getByText("Budgetberechnung", { exact: true }).click();
  const budget = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Giro Puffer", exact: true }) });
  await expect(budget.getByRole("cell").nth(1)).toContainText("100,00");
  await expect(budget.getByRole("cell").nth(2)).toContainText("89,90");
  expect(errors).toEqual([]);
});

test("sharing uses the same bounded work surface with persistent actions and discard behavior", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, [booking, ...Array.from({ length: 60 }, (_, index) => ({
    ...booking, id: `share-${index}`, description: `Gemeinsamer Einkauf ${index}`,
  }))]);
  const trigger = page.getByRole("button", { name: "Geteilt", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Geteilt", exact: true });
  const body = dialog.getByLabel("Buchungslisten", { exact: true });
  const save = dialog.getByRole("button", { name: "Speichern", exact: true });
  const close = dialog.getByRole("button", { name: "Geteilt schließen", exact: true });
  await dialog.getByRole("checkbox").first().check();
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(save).toBeInViewport();
  await expect(close).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("shared-mobile.png") });
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await stored(page)).transactions.some((row) => row.sharedWithRaphael)).toBe(false);
  await trigger.click();
  await expect(dialog.getByRole("checkbox").first()).not.toBeChecked();
  await dialog.getByRole("checkbox").first().check();
  await save.click();
  await expect.poll(async () => (await stored(page)).transactions.filter((row) => row.sharedWithRaphael).length).toBe(1);
  await trigger.click();
  await dialog.getByRole("tab", { name: /^Offen/ }).click();
  await expect(dialog.getByRole("button", { name: /^Als bezahlt markieren:/ })).toHaveCount(1);
  await close.click();
});

test("action menu separates deletion and filter popover does not move the table", async ({ page }) => {
  await seed(page);
  const trigger = page.getByRole("button", { name: "Weitere Aktionen: Beispielkauf", exact: true });
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("separator")).toBeVisible();
  await page.getByRole("menuitem", { name: "Löschen: Beispielkauf", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Umsatz löschen?", exact: true });
  await expect(dialog).toHaveAttribute("data-variant", "confirmation");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  const before = (await page.getByRole("table").boundingBox())!.y;
  await page.getByRole("button", { name: "Weitere Filter", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Weitere Filter", exact: true })).toBeVisible();
  expect((await page.getByRole("table").boundingBox())!.y).toBe(before);
  await page.getByLabel("Datum von", { exact: true }).fill("2026-09-13");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Keine Umsätze gefunden", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Zurücksetzen", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Beispielkauf", exact: true })).toBeVisible();
});

test("goal and planning dialogs validate inputs, preserve drafts until save and restore focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await page.goto("/einstellungen");
  const add = page.getByRole("button", { name: "Sparziel hinzufügen", exact: true });
  await add.click();
  let dialog = page.getByRole("dialog", { name: "Sparziel hinzufügen", exact: true });
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await dialog.getByLabel("Name", { exact: true }).fill("Formziel");
  await dialog.getByLabel("Betrag", { exact: true }).fill("123.456");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Nachkommastellen");
  await dialog.getByLabel("Betrag", { exact: true }).fill("1200");
  await dialog.getByLabel("Bis-Datum", { exact: true }).fill("2027-01-01");
  await expect(dialog.getByRole("button", { name: "Speichern", exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("goal-mobile.png") });
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  await expect.poll(async () => (await stored(page)).savingsGoals?.find((goal) => goal.name === "Formziel")?.target).toBe(1200);
  await page.getByRole("button", { name: "Formziel Menü", exact: true }).click();
  await page.getByRole("menuitem", { name: "Bearbeiten", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Sparziel bearbeiten", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Formziel Plus");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  const menu = page.getByRole("button", { name: "Formziel Plus Menü", exact: true });
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole("menuitem", { name: "Entfernen", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Sparziel entfernen?", exact: true });
  await dialog.getByRole("button", { name: "Entfernen", exact: true }).click();
  await expect(add).toBeFocused();
  expect((await stored(page)).transactions[0]).toMatchObject(booking);

  await page.goto("/monate");
  await page.getByRole("button", { name: "Plan bearbeiten", exact: true }).click();
  const addPosition = page.getByRole("button", { name: "Position hinzufügen", exact: true });
  await addPosition.click();
  dialog = page.getByRole("dialog", { name: "Position hinzufügen", exact: true });
  await dialog.getByRole("button", { name: "Position speichern", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByLabel("Bezeichnung", { exact: true }).fill("Beispielmiete");
  await dialog.getByLabel("Bereich", { exact: true }).selectOption("fixed");
  await dialog.getByLabel("Kategorie / Planverknüpfung", { exact: true }).selectOption("Miete");
  await dialog.getByRole("button", { name: "Position speichern", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(addPosition).toBeFocused();
  await expect.poll(async () => (await stored(page)).financeRows.find((row) => row.label === "Beispielmiete")?.planCategory).toBe("Miete");
  expect((await stored(page)).financeRows.filter((row) => row.kind === "variable")).toHaveLength(7);
});

test("long work dialogs keep actions visible on desktop, phone and short landscape screens", async ({ page }, testInfo) => {
  await seed(page, [
    booking,
    ...Array.from({ length: 35 }, (_, index): Transaction => ({
      ...booking, id: `review-${index}`, description: `Unbekannter Beispielhaendler ${index}`,
      category: "Prüfen", categoryOverride: false,
    })),
  ]);
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
    const dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
    await expect(dialog).toHaveAttribute("data-variant", "work");
    const body = dialog.locator('[data-slot="dialog-body"]');
    const close = dialog.getByRole("button", { name: "Prüfung schließen", exact: true });
    await expect(close).toBeInViewport();
    await expect(dialog.getByRole("heading", { name: "Kontoauszüge prüfen" })).toBeInViewport();
    expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(close).toBeInViewport();
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(Math.min(viewport.width - 32, 720) + 1);
    expect(box.height).toBeLessThanOrEqual(Math.min(viewport.height * 0.8, 720) + 1);
    await page.screenshot({ path: testInfo.outputPath(`review-${viewport.width}.png`) });
    await close.click();
  }
});
