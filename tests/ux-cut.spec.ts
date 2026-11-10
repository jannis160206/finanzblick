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
  const dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Art", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Prüfung schließen", exact: true }).click();
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
  await expect.poll(async () => (await stored(page)).transactions.length).toBe(3);
  if (await dialog.isVisible())
    await dialog.getByRole("button", { name: "Prüfung schließen", exact: true }).click();
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
  await page.getByRole("button", { name: "Uploadstatus", exact: true }).click();
  const upload = page.getByRole("dialog", { name: "Uploadstatus", exact: true });
  await expect(upload.getByLabel("Importstatus")).toContainText(
    "Übernommen 3 · offen 0 · nicht lesbar 0",
  );
  await page.keyboard.press("Escape");
  await expect(upload).toHaveCount(0);
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
  await goal.getByLabel("Zielbetrag", { exact: true }).fill("9000");
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

test("Trade Republic on the savings page is read-only and follows the stored data", async ({
  page,
}) => {
  await page.goto("/sparen");
  const initial = await stored(page);
  const card = page.getByRole("region", { name: "Trade Republic", exact: true });
  await expect(card).toContainText("2,25 %");
  await expect(card).toContainText("zuletzt gespeichert");
  await expect(card.getByRole("link", { name: "Trade Republic unter Banken & Verbindungen verbinden" }))
    .toHaveAttribute("href", "/einstellungen#bankverbindung");
  await expect(card.locator("input, select, form")).toHaveCount(0);
  await expect(page.getByLabel("TR Kontostand", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Zinssatz p.a.", { exact: true })).toHaveCount(0);

  // A bank sync in another tab delivers the balance; the card follows without any input.
  const latest = {
    ...initial,
    settings: { ...initial.settings, interestRates: [{ date: "2026-01-01", rate: 0.0225 }, { date: "2026-09-01", rate: 0.04 }] },
    trBalances: [{ date: "2026-09-10", balance: 6123.45 }],
  };
  await page.evaluate(
    ({ key, state }) => {
      localStorage.setItem(key, JSON.stringify(state));
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(state) }));
    },
    { key, state: latest },
  );
  await expect(card).toContainText("6.123,45");
  await expect(card).toContainText("4 %");
  await expect(card.getByRole("link")).toHaveCount(0);
  await page.reload();
  expect((await stored(page)).trBalances).toEqual(latest.trBalances);
  await expect(card).toContainText("6.123,45");
});

test("Trade Republic has no manual balance entry and Revolut names remain read-only and separate", async ({
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
  await page.getByRole("button", { name: "Uploadstatus", exact: true }).click();
  const upload = page.getByRole("dialog", { name: "Uploadstatus", exact: true });
  await expect(upload.getByLabel("Importstatus")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(upload).toHaveCount(0);
  await page.goto("/pockets");
  await expect(page.getByLabel("Notgroschen Kontostand")).toContainText(
    "5.000,00",
  );
  const everyday = page.getByRole("region", { name: "Revolut Alltagspockets" });
  await expect(everyday).toContainText("Entertainment & Haushalt");
  await expect(everyday).toContainText("40,00");
  await expect(everyday.locator("input, select, form")).toHaveCount(0);
  await expect(page.locator("form:visible")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Kontostand aktualisieren", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("TR Kontostand", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Notgroschen Kontostand")).toContainText(
    "5.000,00",
  );
  await expect(page.locator("form:visible")).toHaveCount(0);
});
