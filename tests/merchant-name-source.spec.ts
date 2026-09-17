import { expect, test } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState } from "../src/lib/types";

test("named merchant replaces POS noise in an existing booking without duplicating bank facts", async ({ page }) => {
  const source = "POS 3,50 AT D1 09.09. 11:53 Kartenfolge-Nr.: 1";
  const state = createSeed();
  state.transactions = [{
    id: "legacy-named-merchant", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
    date: "2026-09-10", description: source, amount: -3.5,
    category: "Prüfen", includeInPlan: false,
  }];
  state.fixedReceipts = [];
  await page.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await page.addInitScript((state) => {
    if (!localStorage.getItem("finanzdashboard.v1")) localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
  }, state);
  await page.goto("/umsaetze");
  const file = {
    name: "Raiffeisen-Test.csv", mimeType: "text/csv",
    buffer: Buffer.from(`Raiffeisen\nBuchungsdatum;Buchungstext;Betrag;Zahlungsreferenz;Händler Name\n10.09.2026;${source};-3,50;Beleg TEST-350;BILLA`),
  };
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles(file);
  await expect(page.getByRole("cell", { name: "BILLA", exact: true })).toBeVisible();
  const read = () => page.evaluate(() => JSON.parse(localStorage.getItem("finanzdashboard.v1")!) as AppState);
  await expect.poll(async () => (await read()).transactions).toMatchObject([{
    ...state.transactions[0], description: "BILLA", rawDescription: source,
    category: "Mittagessen", includeInPlan: true,
  }]);
  await page.getByRole("button", { name: "Zuordnung ändern: BILLA", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Zuordnung ändern", exact: true });
  await expect(dialog.getByRole("region", { name: "Originalbuchung" })).toContainText("BILLA");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(page.getByText("0 neu, 1 Duplikate ignoriert", { exact: true })).toHaveCount(0);
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles(file);
  await expect(page.getByText("0 neu, 1 Duplikate ignoriert", { exact: true })).toBeVisible();
  expect((await read()).transactions).toHaveLength(1);
});
