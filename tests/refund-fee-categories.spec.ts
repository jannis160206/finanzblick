import { expect, test } from "@playwright/test";
import { calculateDashboard } from "../src/lib/calc";
import { createSeed } from "../src/lib/seed";
import type { AppState } from "../src/lib/types";

test("refunds and returned-debit fees can be assigned separately without turning refunds into income", async ({ page }) => {
  const state = createSeed();
  state.settings.asOf = "2026-09-17";
  state.settings.baselineDate = "2026-09-01";
  state.fixedReceipts = [];
  state.transactions = [
    { id: "refund", description: "Unbekannte Erstattung", amount: 50 },
    { id: "fee", description: "Unbekanntes Entgelt", amount: -5.5 },
  ].map((row) => ({ ...row, date: "2026-09-10", bank: "Revolut", pocket: null, category: "Prüfen", includeInPlan: false }));
  await page.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await page.addInitScript((state) => {
    if (!localStorage.getItem("finanzdashboard.v1")) localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
  }, state);
  await page.goto("/umsaetze");
  await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
  const dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
  for (const [description, category] of [
    ["Unbekannte Erstattung", "Rückerstattungen"],
    ["Unbekanntes Entgelt", "Rücklastschriftgebühren"],
  ]) {
    const section = dialog.getByRole("region", { name: `Buchung prüfen: ${description}`, exact: true });
    await section.getByLabel("Kategorie", { exact: true }).selectOption(category);
    await section.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
    await expect(section).toHaveCount(0);
  }
  await expect(dialog).toHaveCount(0);
  await page.reload();
  for (const [description, category] of [
    ["Unbekannte Erstattung", "Rückerstattungen"],
    ["Unbekanntes Entgelt", "Rücklastschriftgebühren"],
  ]) {
    await page.getByLabel("Kategorie filtern", { exact: true }).selectOption(category);
    await expect(page.getByRole("cell", { name: description, exact: true })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(1);
  }
  const stored: AppState = await page.evaluate(() => JSON.parse(localStorage.getItem("finanzdashboard.v1")!));
  expect(stored.transactions).toHaveLength(2);
  expect(stored.transactions.map((row) => row.amount)).toEqual([50, -5.5]);
  expect(stored.transactions.map((row) => row.category)).toEqual(["Rückerstattungen", "Rücklastschriftgebühren"]);
  expect(calculateDashboard(stored).current).toMatchObject({ received: 0, salaryReceived: 0, actualSpending: -44.5 });
});
