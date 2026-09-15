import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState, Transaction } from "../src/lib/types";

const storageKey = "finanzdashboard.v1";
const newCategories = [
  "Entertainment", "Sport & Fitness", "Bildung", "Haustiere", "Wohnen & Haushalt",
] as const;
const merchants = ["Cineplexx", "Fitinn", "Udemy", "Fressnapf", "IKEA"];
const statement = {
  name: "Kategorien.csv",
  mimeType: "text/csv",
  buffer: Buffer.from([
    "Buchungsdatum;Verwendungszweck/Text;Valuta;Betrag",
    ...[...merchants, "Kulturhaus Probe"].map((name, index) =>
      `10.09.2026;${name};10.09.2026;-${12 + index},00`),
  ].join("\n")),
};

async function saved(page: Page): Promise<AppState> {
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible();
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey);
}

async function groupedOptions(select: Locator) {
  await expect(select).toBeVisible();
  await expect(select).toBeEnabled();
  expect(await select.locator("optgroup").evaluateAll((groups) =>
    groups.map((group) => group.getAttribute("label")),
  )).toEqual([
    "Alltag", "Freizeit & Leben", "Wohnen & Mobilität", "Verträge & Gebühren",
    "Einnahmen", "Sonstiges & Umbuchungen",
  ]);
  for (const [group, categories] of [
    ["Alltag", ["Drogerie", "Körperpflege"]],
    ["Freizeit & Leben", [...newCategories.slice(0, 4), "Geschenke & Spenden"]],
    ["Wohnen & Mobilität", ["Wohnen & Haushalt"]],
    ["Verträge & Gebühren", ["Abonnements", "Versicherungen", "Telefon & Internet", "Bankgebühren"]],
  ] as const) {
    for (const category of categories) {
      const option = select.locator(`optgroup[label="${group}"] option[value="${category}"]`);
      await expect(option).toHaveCount(1);
      await expect(option).toHaveJSProperty("disabled", false);
    }
  }
  const values = await select.locator("option").evaluateAll((options) => options.map((option) => option.getAttribute("value")));
  expect(new Set(values).size).toBe(values.length);
  for (const legacy of ["Spotify", "PayPal Abo", "Vollkasko", "Haftpflicht", "Apple Care", "Handyvertrag", "AMEX Monatsgebühr", "Barber"])
    expect(values).not.toContain(legacy);
}

test("legacy categories migrate and grouped choices work in review, filters, budgets and reimport", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.clock.setFixedTime(new Date("2026-09-15T12:00:00Z"));
  const state = createSeed();
  state.settings.asOf = "2026-09-15";
  state.settings.baselineDate = "2026-09-01";
  state.transactions = ([
    ["legacy-spotify", "Spotify Premium", "Spotify"],
    ["legacy-paypal", "PayPal Software Subscription", "PayPal Abo"],
  ] as const).map(([id, description, category]): Transaction => ({
    id, description, category, date: "2026-09-02", amount: -10,
    bank: "Raiffeisen", pocket: "Raiffeisen Giro", includeInPlan: false,
  }));
  state.financeRows = (["Spotify", "PayPal Abo"] as const).map((label, index) => ({
    id: `contract-${index}`, kind: "fixed", label, planCategory: label,
    values: { "2026-09": 10, "2026-10": 10 },
  }));
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: storageKey, state });

  await test.step("legacy storage loads as subscriptions, not provider categories", async () => {
    await page.goto("/umsaetze");
    const migrated = await saved(page);
    expect(migrated.transactions).toEqual(state.transactions.map((row) => ({ ...row, category: "Abonnements" })));
    expect(migrated.financeRows.filter((row) => row.kind === "fixed")).toEqual(
      state.financeRows.map((row) => ({ ...row, planCategory: "Abonnements" })),
    );
    const filter = page.getByLabel("Kategorie filtern");
    await groupedOptions(filter);
    await filter.selectOption("Abonnements");
    await expect(page.locator("tbody tr")).toHaveCount(2);
    for (const row of state.transactions)
      await expect(page.getByRole("cell", { name: row.description, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Zuordnung ändern: Spotify Premium", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await groupedOptions(dialog.getByLabel("Kategorie", { exact: true }));
    await expect(dialog.getByLabel("Kategorie", { exact: true })).toHaveValue("Abonnements");
    await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await filter.selectOption("");
  });

  await test.step("new bookings and the review selector use the new categories", async () => {
    await page.getByLabel("Kontoauszüge auswählen").setInputFiles(statement);
    const dialog = page.getByRole("dialog");
    const review = dialog.getByRole("region", { name: "Buchung prüfen: Kulturhaus Probe", exact: true });
    const select = review.getByLabel("Kategorie", { exact: true });
    await groupedOptions(select);
    await expect(select.locator('option[value="Prüfen"]')).toHaveJSProperty("disabled", true);
    await expect(review.getByRole("button", { name: "Zuordnung übernehmen", exact: true })).toBeDisabled();
    for (const category of newCategories) {
      await select.selectOption(category);
      await expect(select).toHaveValue(category);
      await expect(review.getByRole("button", { name: "Zuordnung übernehmen", exact: true })).toBeEnabled();
    }
    await select.selectOption("Entertainment");
    await review.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const imported = await saved(page);
    expect(imported.transactions).toHaveLength(8);
    for (const [index, description] of merchants.entries())
      expect(imported.transactions.find((row) => row.description === description)).toMatchObject({
        category: newCategories[index], date: "2026-09-10", amount: -(12 + index),
      });
    expect(imported.transactions.find((row) => row.description === "Kulturhaus Probe")).toMatchObject({
      category: "Entertainment", categoryOverride: true,
    });
    expect(imported.reviewQueue ?? []).toEqual([]);
  });

  await test.step("each new category filters actual bookings and edits persist", async () => {
    const filter = page.getByLabel("Kategorie filtern");
    for (const [index, category] of newCategories.entries()) {
      await filter.selectOption(category);
      await expect(filter).toHaveValue(category);
      await expect(page.locator("tbody tr")).toHaveCount(index === 0 ? 2 : 1);
      await expect(page.getByRole("cell", { name: merchants[index], exact: true })).toBeVisible();
    }
    await filter.selectOption("Entertainment");
    await page.getByRole("button", { name: "Zuordnung ändern: Cineplexx", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Bildung");
    await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await saved(page);
    await page.reload();
    await page.getByLabel("Kategorie filtern").selectOption("Bildung");
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await expect(page.getByRole("cell", { name: "Cineplexx", exact: true })).toBeVisible();
  });

  await test.step("fixed-cost category links persist without adding variable budget lines", async () => {
    await page.goto("/monate");
    await page.getByRole("button", { name: "Ausnahmebearbeitung", exact: true }).click();
    for (const label of ["Spotify", "PayPal Abo"]) {
      await page.getByRole("button", { name: `${label} bearbeiten`, exact: true }).click();
      await expect(page.getByLabel("Kategorie / Planverknüpfung", { exact: true })).toHaveValue("Abonnements");
      await page.getByRole("dialog").getByRole("button", { name: "Abbrechen", exact: true }).click();
    }
    for (const category of newCategories) {
      await page.getByRole("button", { name: "Position", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const link = dialog.getByLabel("Kategorie / Planverknüpfung", { exact: true });
      await groupedOptions(link);
      await dialog.getByLabel("Bezeichnung", { exact: true }).fill(`Budget ${category}`);
      const kind = dialog.getByLabel("Bereich", { exact: true });
      await expect(kind.locator('option[value="variable"]')).toHaveCount(0);
      await kind.selectOption("fixed");
      await link.selectOption(category);
      await expect(link).toHaveValue(category);
      await dialog.getByRole("button", { name: "Position speichern", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    expect((await saved(page)).financeRows.filter((row) => row.kind === "variable")).toHaveLength(7);
    await page.reload();
    await page.getByRole("button", { name: "Ausnahmebearbeitung", exact: true }).click();
    for (const category of newCategories) {
      await page.getByRole("button", { name: `Budget ${category} bearbeiten`, exact: true }).click();
      await expect(page.getByLabel("Kategorie / Planverknüpfung", { exact: true })).toHaveValue(category);
      await expect(page.getByRole("dialog").getByLabel("Bereich", { exact: true })).toHaveValue("fixed");
      await page.getByRole("dialog").getByRole("button", { name: "Abbrechen", exact: true }).click();
    }
  });

  await test.step("Excel restore and statement reimport retain categories without duplicates", async () => {
    const before = await saved(page);
    await page.goto("/einstellungen");
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportieren", exact: true }).click();
    const download = await downloading;
    await page.getByLabel("Excel-Datei auswählen").setInputFiles({
      name: "Kategorien-Sicherung.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: await readFile((await download.path())!),
    });
    await page.getByRole("button", {
      name: "Sicherung wiederherstellen und aktuelle Daten ersetzen", exact: true,
    }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const restored = await saved(page);
    expect(restored.transactions).toEqual(before.transactions);
    expect(restored.financeRows).toEqual(before.financeRows);
    expect(restored.merchantRules).toEqual(before.merchantRules);
    await page.goto("/umsaetze");
    await page.getByLabel("Kontoauszüge auswählen").setInputFiles(statement);
    await expect(page.getByText("0 neu, 6 Duplikate ignoriert", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const reimported = await saved(page);
    expect(reimported.transactions).toEqual(before.transactions);
    expect(reimported.reviewQueue ?? []).toEqual([]);
    await page.getByLabel("Kategorie filtern").selectOption("Bildung");
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await page.getByLabel("Kategorie filtern").selectOption("Entertainment");
    await expect(page.getByRole("cell", { name: "Kulturhaus Probe", exact: true })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(1);
  });
  expect(errors).toEqual([]);
});
