import { expect, test } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState } from "../src/lib/types";

test("strict budgets survive load and import, while saved vacation changes only lunch and actual categorization", async ({ page }) => {
  const key = "finanzdashboard.v1";
  const state = createSeed();
  state.financeRows = [
    { id: "income", label: "Gehalt", kind: "income", values: { "2026-10": 4000 } },
    { id: "lease", label: "Leasing", kind: "fixed", values: { "2026-10": 300 } },
    { id: "food", label: "Lebensmittel", planCategory: "Lebensmittel", kind: "variable", values: { "2026-10": 600 }, overrides: { "2026-10": 900 } },
    ...["AMEX", "Amex-Rate", "Amex Rückzahlung", "Klarna", "Sonstiges", "Gesundheit", "Drogerie", "Shopping", "Wohnen & Haushalt"].map((label) => ({ id: label, label, kind: "variable" as const, values: { "2026-10": 600 } })),
  ];
  await page.clock.setFixedTime(new Date("2026-09-15T12:00:00Z"));
  await page.addInitScript(({ key, state }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state)); }, { key, state });
  const stored = (): Promise<AppState> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
  await page.goto("/monate");
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible();
  for (const [label, value] of [["Lebensmittel & Haushalt", "250,00"], ["Mittagessen", "111,50"], ["Tanken", "180,00"], ["Freizeit", "20,00"], ["Ausgehen", "250,00"], ["Geschenke & Spenden", "0,00"], ["Giro Puffer", "100,00"]])
    await expect(page.getByLabel(`${label} Oktober 2026`, { exact: true })).toHaveText(value);
  for (const label of ["AMEX", "Amex-Rate", "Amex Rückzahlung", "Klarna", "Sonstiges", "Gesundheit", "Drogerie", "Shopping", "Wohnen & Haushalt", "G2A"])
    await expect(page.getByRole("row").filter({ has: page.getByText(label, { exact: true }) })).toHaveCount(0);
  await expect(page.getByLabel("Geschenke & Spenden November 2026", { exact: true })).toHaveText("100,00");
  await expect(page.getByLabel("Geschenke & Spenden Dezember 2026", { exact: true })).toHaveText("1.000,00");
  await page.getByRole("button", { name: "2027", exact: true }).click();
  await expect(page.getByLabel("Geschenke & Spenden Jänner 2027", { exact: true })).toHaveText("50,00");
  await page.goto("/plan");
  await expect(page.getByText("Lebensmittel & Haushalt", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Automatisch aus deinen Umsätzen", { exact: false })).toHaveCount(0);
  await page.goto("/umsaetze");
  await page.getByRole("button", { name: "Urlaub", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Von", { exact: true }).fill("2026-10-05");
  await page.getByRole("dialog").getByLabel("Bis", { exact: true }).fill("2026-10-09");
  await page.getByRole("button", { name: "Zeitraum speichern" }).click();
  await page.getByRole("button", { name: "Fertig", exact: true }).click();
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles({ name: "expenses.csv", mimeType: "text/csv", buffer: Buffer.from("Revolut\nDatum,Beschreibung,Betrag\n2026-09-13,BILLA,-600\n2026-09-13,dm,-500") });
  await expect.poll(async () => (await stored()).transactions.length).toBe(2);
  await page.goto("/monate");
  await expect(page.getByLabel("Mittagessen Oktober 2026", { exact: true })).toHaveText("85,00");
  await expect(page.getByLabel("Lebensmittel & Haushalt Oktober 2026", { exact: true })).toHaveText("250,00");
  await page.getByRole("button", { name: "Ausnahmebearbeitung" }).click();
  await expect(page.getByRole("textbox", { name: "Lebensmittel & Haushalt Oktober 2026", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Leasing Oktober 2026", exact: true })).toHaveValue("300,00");
  await page.reload();
  const saved = await stored();
  expect(saved.financeRows.filter((row) => row.kind === "variable")).toHaveLength(7);
  expect(saved.financeRows.filter((row) => row.kind !== "variable")).toEqual(state.financeRows.slice(0, 2));
});
