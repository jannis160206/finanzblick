import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState } from "../src/lib/types";

const key = "finanzdashboard.v1";
async function stored(page: Page): Promise<AppState> {
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}
test.beforeEach(async ({ page }) => {
  const state = createSeed();
  state.settings.baselineDate = "2026-09-01";
  state.settings.balances.Notgroschen = 5000;
  await page.clock.setFixedTime(new Date("2026-09-12T12:00:00Z"));
  await page.addInitScript(
    ({ key, state }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify(state));
    },
    { key, state },
  );
});
const file = (text: string) => ({
  name: "test.csv",
  mimeType: "text/csv",
  buffer: Buffer.from(text),
});

test("review survives reload, permits another file and bulk-assigns a merchant", async ({
  page,
}) => {
  await page.goto("/umsaetze");
  await stored(page);
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(
      file(
        "Revolut\nLebensmittel (EUR)\nDatum,Beschreibung,Betrag\n11.09.2026,Neuer Laden,-10\n12.09.2026,Neuer Laden,-15",
      ),
    );
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Art", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Später prüfen" }).first().click();
  expect((await stored(page)).reviewQueue).toHaveLength(2);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^Zuordnung prüfen/ }),
  ).toBeVisible();
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(
      file(
        "Revolut\nLebensmittel (EUR)\nDatum,Beschreibung,Betrag\n12.09.2026,BIPA,-5",
      ),
    );
  await expect(
    page.getByText("1 neu, 0 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
  await dialog
    .getByLabel("Kategorie", { exact: true })
    .first()
    .selectOption("Shopping");
  await dialog
    .getByRole("button", { name: "Zuordnung übernehmen" })
    .first()
    .click();
  await expect(dialog).toHaveCount(0);
  const state = await stored(page);
  expect(state.transactions).toHaveLength(3);
  expect(state.reviewQueue).toEqual([]);
  expect(
    state.transactions
      .filter((row) => row.description === "Neuer Laden")
      .every((row) => row.category === "Shopping"),
  ).toBe(true);
  await expect(page.getByLabel("Importstatus")).toContainText(
    "Übernommen 3 · offen 0 · nicht lesbar 0",
  );
  await expect(page.locator("thead th")).toHaveText([
    "Datum",
    "Beschreibung",
    "Kategorie",
    "Betrag",
    "Konto/Pocket",
  ]);
  await expect(page.getByLabel("Datum von")).not.toBeVisible();
  await expect(page.getByLabel("Zeilen pro Seite")).toHaveCount(0);
});

test("months and budget details are read-only unless exceptions are explicitly opened", async ({
  page,
}) => {
  await page.goto("/monate");
  await stored(page);
  await expect(page.locator(".month-grid input")).toHaveCount(0);
  await expect(
    page.getByText("Gesamtbudget ersetzen", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Plan bearbeiten" }).click();
  await expect(page.locator(".month-grid input").first()).toBeVisible();
  await expect(
    page.getByText("Gesamtbudget ersetzen", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Lebensmittel & Haushalt September 2026", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Jahr befüllen|Zwölf Werte ersetzen/ }),
  ).toHaveCount(0);
  await page.goto("/plan");
  await expect(
    page.getByRole("heading", { name: "Alltagsbudget", exact: true }),
  ).toBeVisible();
  await expect(page.locator("table")).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Urlaub", exact: true })).not.toBeVisible();
  await expect(page.getByText("Budgetberechnung", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Umsätze ansehen" }),
  ).toBeVisible();
  await expect(page.getByText(/Abweichende Monatsbudgets/)).toHaveCount(0);
});

test("settings contain only rare controls and save actions only appear after changes", async ({
  page,
}) => {
  await page.goto("/einstellungen");
  await stored(page);
  for (const label of [
    "Auswertungsstichtag",
    "Datum der Ist-Basis",
    "Verzinsung ab",
    "Sparverteilung ab",
  ])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Einstellungen speichern" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Motorrad bearbeiten" }).click();
  const goal = page.getByRole("dialog");
  await goal.getByLabel("Betrag", { exact: true }).fill("9000");
  await goal.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(goal).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Einstellungen speichern" }),
  ).toHaveCount(0);
  expect((await stored(page)).settings.bikeTarget).toBe(9000);
  await page.goto("/");
  await expect(
    page.getByText("Ersparnisse gesamt", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Einnahmen · Plan", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Monatsprognose" }).getByText("Rest nach Zielraten", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/Round-up/)).toHaveCount(0);
});

test("TR settings deduplicate and sort rates without overwriting newer balances and dates", async ({
  page,
}) => {
  await page.goto("/einstellungen");
  const initial = await stored(page);
  await expect(page.getByLabel("Zinssatz p.a.", { exact: true })).toHaveValue("2.25");
  await page.getByLabel("TR Kontostand", { exact: true }).fill("5500");
  await page.getByLabel("TR Standdatum").fill("2026-09-12");
  await page.getByLabel("Zinssatz p.a.", { exact: true }).fill("3.5");

  // Another tab updates hidden fields while this form still has old defaults.
  await page.clock.setFixedTime(new Date("2026-09-13T12:00:00Z"));
  const latestSettings = {
    ...initial.settings,
    asOf: "2026-09-13",
    baselineDate: "2026-09-10",
    balances: { Notgroschen: 6123.45, Urlaub: 2100, Sparkonto: 3200, Motorrad: 400 },
    interestRates: [
      { date: "2026-01-01", rate: 0.0225 },
      { date: "2026-06-01", rate: 0.0275 },
      { date: "2026-09-12", rate: 0.03 },
      { date: "2026-09-13", rate: 0.04 },
    ],
  };
  await page.evaluate(
    ({ key, state }) => {
      localStorage.setItem(key, JSON.stringify(state));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue: JSON.stringify(state),
        }),
      );
    },
    { key, state: { ...initial, settings: latestSettings, trBalances: [{ date: "2026-09-13", balance: 6123.45 }] } },
  );
  await expect
    .poll(async () => (await stored(page)).settings)
    .toMatchObject(latestSettings);
  await expect(page.getByLabel("Zinssatz p.a.", { exact: true })).toHaveValue(
    "3.5",
  );

  await page.getByRole("button", { name: "Trade Republic speichern" }).click();
  await expect(
    page.getByRole("button", { name: "Trade Republic speichern" }),
  ).toHaveCount(0);
  const expectedSettings = {
    ...latestSettings,
    interestRates: [
      { date: "2026-01-01", rate: 0.0225 },
      { date: "2026-06-01", rate: 0.0275 },
      { date: "2026-09-12", rate: 0.035 },
      { date: "2026-09-13", rate: 0.04 },
    ],
  };
  expect((await stored(page)).settings).toEqual(expectedSettings);
  await page.reload();
  const restored = await stored(page);
  expect(restored.settings).toEqual(expectedSettings);
  expect(restored.trBalances).toEqual(expect.arrayContaining([
    { date: "2026-09-12", balance: 5500 },
    { date: "2026-09-13", balance: 6123.45 },
  ]));
  expect(restored.trBalances).toHaveLength(2);
  await expect(page.getByLabel("TR Standdatum")).toHaveValue("2026-09-13");
  await expect(page.getByLabel("TR Kontostand", { exact: true })).toHaveValue("6123.45");
  await expect(page.getByLabel("Zinssatz p.a.", { exact: true })).toHaveValue("4");
  await expect(
    page.getByRole("button", { name: "Trade Republic speichern" }),
  ).toHaveCount(0);
});

test("TR manual balance wins across reload and Revolut names remain read-only and separate", async ({
  page,
}) => {
  await page.goto("/umsaetze");
  await stored(page);
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(
      file(
        "Revolut\nZeitraum,01.09.2026 bis 12.09.2026\nNotgroschen (EUR)\nSchlussguthaben,10\nMittagessen (EUR)\nSchlussguthaben,20\nLebensmittel (EUR)\nSchlussguthaben,30\nEntertainment & Haushalt (EUR)\nSchlussguthaben,40\nTanken (EUR)\nSchlussguthaben,50",
      ),
    );
  await expect(page.getByLabel("Importstatus")).toBeVisible();
  await page.goto("/pockets");
  await expect(page.getByLabel("Notgroschen Kontostand")).toContainText(
    "5.000,00",
  );
  const everyday = page.getByRole("region", { name: "Revolut Alltagspockets" });
  await expect(everyday).toContainText("Entertainment & Haushalt");
  await expect(everyday).toContainText("40,00");
  await expect(everyday.locator("input, select, form")).toHaveCount(0);
  await expect(page.locator("form:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Kontostand aktualisieren", exact: true }).click();
  await page.getByLabel("TR Kontostand", { exact: true }).fill("6.123,45");
  await page.getByLabel("TR Kontostand", { exact: true }).press("Tab");
  await page.getByLabel("TR Standdatum").fill("2026-09-12");
  await page.getByRole("button", { name: "Kontostand speichern" }).click();
  await expect(page.getByLabel("Notgroschen Kontostand")).toContainText(
    "6.123,45",
  );
  expect((await stored(page)).trBalances).toEqual([
    { date: "2026-09-12", balance: 6123.45 },
  ]);
  await page.clock.setFixedTime(new Date("2026-10-12T12:00:00Z"));
  await page.reload();
  await expect(page.getByLabel("Notgroschen Kontostand")).toContainText(
    "6.123,45",
  );
  await expect(page.locator("form:visible")).toHaveCount(0);
});
