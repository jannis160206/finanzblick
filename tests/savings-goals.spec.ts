import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { emptyPockets, type AppState } from "../src/lib/types";

const key = "finanzdashboard.v1";
async function stored(page: Page): Promise<AppState> {
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible();
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}
async function importTransfers(page: Page, text: string) {
  await page.goto("/umsaetze");
  await stored(page);
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles({
    name: "sparziele.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(text),
  });
  await page.getByRole("button", { name: "Uploadstatus", exact: true }).click();
  const upload = page.getByRole("dialog", { name: "Uploadstatus", exact: true });
  await expect(upload.getByLabel("Importstatus")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(upload).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await stored(page);
}
test.beforeEach(async ({ page }) => {
  const state = createSeed();
  state.settings = { ...state.settings, baselineDate: "2026-09-01", asOf: "2026-09-14", balances: emptyPockets() };
  state.months = {};
  state.transactions = [];
  // Leave 1,000 available for saving after each month's mandatory variable budgets.
  state.financeRows = [{ id: "salary", label: "Gehalt", kind: "income", values: { "2026-09": 1917, "2026-10": 1911.5 } }];
  state.savingsGoals = [{ id: "motorcycle", name: "Motorrad", pocket: "Motorrad", target: 8500, date: "2027-03-01" }];
  await page.clock.setFixedTime(new Date("2026-09-14T12:00:00Z"));
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
});

test("goals follow deadline order and removing the last goal preserves the ledger", async ({ page }) => {
  await page.goto("/einstellungen");
  const before = await stored(page);
  await page.getByRole("button", { name: "Sparziel hinzufügen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Kamera");
  await dialog.getByLabel("Zielbetrag", { exact: true }).fill("300");
  await dialog.getByLabel("Zieldatum").fill("2026-10-01");
  for (const step of ["Startkapital", "Konten", "Verteilung"]) {
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    await expect(dialog.getByRole("group", { name: step, exact: true })).toBeVisible();
  }
  // Deadline order is the allocation without a plan, so this goal keeps the classic behavior.
  await dialog.getByRole("switch", { name: /Automatisch planen/ }).click();
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
  await dialog.getByRole("button", { name: "Sparziel anlegen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await stored(page);
  await page.goto("/");
  const funding = page.getByRole("region", { name: "Pocket-Verteilung diesen Monat" });
  await expect(funding).toContainText(/Sparkonto.*180,00.*Kamera.*300,00.*Motorrad.*520,00/);
  await page.goto("/einstellungen");
  await page.getByRole("button", { name: "Kamera bearbeiten" }).click();
  await dialog.getByLabel("Zielbetrag", { exact: true }).fill("400");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await stored(page);
  await page.reload();
  await expect(page.getByRole("article", { name: "Sparziel Kamera", exact: true })).toContainText("400,00");
  for (const name of ["Kamera", "Motorrad"]) {
    const goal = page.getByRole("article", { name: `Sparziel ${name}`, exact: true });
    await goal.getByLabel(`${name} Menü`).click();
    await page.getByRole("menuitem", { name: "Entfernen", exact: true }).click();
    await dialog.getByRole("button", { name: "Entfernen", exact: true }).click();
    await expect(goal).toHaveCount(0);
  }
  const after = await stored(page);
  expect(after.savingsGoals).toEqual([]);
  expect(after.transactions).toEqual(before.transactions);
  expect(after.settings.balances).toEqual(before.settings.balances);
  await page.reload();
  await expect(page.getByRole("region", { name: "Sparziele", exact: true })).toContainText("Kein offenes Sparziel");
  await page.goto("/");
  await expect(funding).toContainText(/Sparkonto.*180,00.*Urlaub.*820,00/);
  await expect(funding).not.toContainText("Motorrad");
});

for (const incoming of ["174,60", "185,40"]) {
  test(`only imported transfers mark the 180 euro rate done at ${incoming}`, async ({ page }) => {
    await page.goto("/");
    await stored(page);
    await expect(page.getByLabel("Sparkonto überwiesen", { exact: true })).toHaveCount(0);
    const csv = `Revolut\nPersönliches Konto (EUR)\nDatum;Beschreibung;Geld ein-/ausgezahlt\n14.09.2026;Um EUR Sparen von EUR einzustecken;-${incoming}\nSparen (EUR)\nDatum;Beschreibung;Geld ein-/ausgezahlt\n14.09.2026;Um EUR Sparen einzustecken;${incoming}\nMotorrad (EUR)\nDatum;Beschreibung;Geld ein-/ausgezahlt\n14.09.2026;Um EUR Motorrad einzustecken;820,00`;
    await importTransfers(page, csv);
    expect((await stored(page)).transactions).toHaveLength(3);
    await page.goto("/");
    await expect(page.getByLabel("Sparkonto überwiesen", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Motorrad überwiesen", { exact: true })).toBeVisible();
    await importTransfers(page, csv);
    expect((await stored(page)).transactions).toHaveLength(3);
    await page.goto("/");
    await page.clock.setFixedTime(new Date("2026-10-14T12:00:00Z"));
    await page.reload();
    await expect(page.getByLabel("Sparkonto überwiesen", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Motorrad überwiesen", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Pocket-Verteilung diesen Monat" })).toContainText(/Sparkonto.*180,00.*Motorrad.*820,00/);
  });
}

test("an imported completed goal stays finished after a later withdrawal", async ({ page }) => {
  await page.goto("/einstellungen");
  await stored(page);
  await page.getByRole("button", { name: "Sparziel hinzufügen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Kamera");
  await dialog.getByLabel("Zielbetrag", { exact: true }).fill("820");
  await dialog.getByLabel("Zieldatum").fill("2026-09-30");
  for (const step of ["Startkapital", "Konten", "Verteilung"]) {
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    await expect(dialog.getByRole("group", { name: step, exact: true })).toBeVisible();
  }
  // Deadline order is the allocation without a plan, so this goal keeps the classic behavior.
  await dialog.getByRole("switch", { name: /Automatisch planen/ }).click();
  await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
  await dialog.getByRole("button", { name: "Sparziel anlegen", exact: true }).click();
  await stored(page);
  await importTransfers(page, "Revolut\nKamera (EUR)\nDatum;Beschreibung;Geld ein-/ausgezahlt;Guthaben\n14.09.2026;Um EUR Kamera einzustecken;820,00;820,00");
  expect((await stored(page)).savingsGoals?.find((goal) => goal.name === "Kamera")?.completedAt).toBe("2026-09-14");
  await page.goto("/");
  await expect(page.getByLabel("Kamera überwiesen", { exact: true })).toBeVisible();
  await page.clock.setFixedTime(new Date("2026-10-14T12:00:00Z"));
  await importTransfers(page, "Revolut\nKamera (EUR)\nDatum;Beschreibung;Geld ein-/ausgezahlt;Guthaben\n01.10.2026;Auszahlung bei Pocket;-820,00;0,00");
  await page.goto("/");
  const funding = page.getByRole("region", { name: "Pocket-Verteilung diesen Monat" });
  await expect(funding).not.toContainText("Kamera");
  await expect(funding).toContainText(/Sparkonto.*180,00.*Motorrad.*820,00/);
  await page.goto("/einstellungen");
  await expect(page.getByRole("article", { name: "Sparziel Kamera", exact: true })).toContainText("Ziel erreicht");
});
