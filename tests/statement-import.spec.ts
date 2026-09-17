import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { type AppState, type Transaction } from "../src/lib/types";

const fixturePath = (name: string) =>
  path.join(process.cwd(), "src/lib/import/fixtures", `${name}.csv`);
const key = "finanzdashboard.v1";
async function ledger(page: Page) {
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  return page.evaluate(
    (storageKey) => JSON.parse(localStorage.getItem(storageKey)!),
    key,
  );
}
async function dropFiles(page: Page, names: string[]) {
  const files = names.map((name) => ({
    name: `${name}.csv`,
    content: readFileSync(fixturePath(name), "utf8"),
  }));
  const transfer = await page.evaluateHandle((entries) => {
    const data = new DataTransfer();
    entries.forEach((entry) =>
      data.items.add(
        new File([entry.content], entry.name, { type: "text/csv" }),
      ),
    );
    return data;
  }, files);
  await page
    .getByRole("region", { name: "Kontoauszüge importieren" })
    .dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-11T12:00:00Z"));
});

async function seed(page: Page, state = createSeed()) {
  await page.goto("/umsaetze");
  await ledger(page);
  await page.evaluate(
    ({ key, state }) => {
      const raw = JSON.stringify(state);
      localStorage.setItem(key, raw);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: raw }));
    },
    { key, state },
  );
  await expect
    .poll(async () =>
      (await ledger(page)).financeRows.filter((row: AppState["financeRows"][number]) => row.kind === "variable").map((row: AppState["financeRows"][number]) => row.label),
    )
    .toEqual(["Lebensmittel & Haushalt", "Mittagessen", "Tanken", "Freizeit", "Ausgehen", "Geschenke & Spenden", "Giro Puffer"]);
  await page.reload();
  await ledger(page);
}
const csv = (rows: string) => ({
  name: "Test.csv",
  mimeType: "text/csv",
  buffer: Buffer.from(
    `Buchungsdatum;Verwendungszweck/Text;Valuta;Betrag\n${rows}`,
  ),
});

test("headerless Raiffeisen drop auto-saves, dedupes and has no manual creation UI", async ({
  page,
}) => {
  await seed(page);
  await dropFiles(page, ["raiffeisen-real"]);
  await expect(
    page.getByText("3 neu, 0 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  expect((await ledger(page)).transactions).toHaveLength(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await dropFiles(page, ["raiffeisen-real"]);
  await expect(
    page.getByText("0 neu, 3 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  expect((await ledger(page)).transactions).toHaveLength(3);
  await page.goto("/umsaetze?neu=1");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Umsatz erfassen" }),
  ).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByText("Umsatz erfassen", { exact: true })).toHaveCount(
    0,
  );
});

test("unknown merchants use locked facts and category only; invalid amounts remain in status", async ({
  page,
}) => {
  await seed(page);
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(
      csv(
        "03.09.2026;BIPA;03.09.2026;-4,00\n03.09.2026;Unbekannter Händler;03.09.2026;-7,00\n04.09.2026;Mensa ohne Betrag;04.09.2026;",
      ),
    );
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    page.getByText("1 neu, 0 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  expect((await ledger(page)).transactions).toHaveLength(1);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByText(/Im Plan|Plan-Kat|Nur „Prüfen“/)).toHaveCount(
    0,
  );
  const unknown = dialog.getByRole("region", {
    name: "Buchung prüfen: Unbekannter Händler",
    exact: true,
  });
  await expect(unknown.locator(".editable")).toHaveCount(0);
  await expect(unknown.getByRole("combobox")).toHaveCount(1);
  for (const field of ["Datum", "Text", "Betrag", "Konto/Pocket"])
    await expect(unknown.getByLabel(field, { exact: true })).toHaveJSProperty(
      "readOnly",
      true,
    );
  await expect(unknown.getByLabel("Konto/Pocket", { exact: true })).toHaveValue(
    "Raiffeisen · Raiffeisen Giro",
  );
  const category = unknown.getByLabel("Kategorie", { exact: true });
  await expect(unknown.getByLabel("Art", { exact: true })).toHaveCount(0);
  expect(await category.locator("option").allTextContents()).toEqual(
    expect.arrayContaining(["Freizeit", "Telefon & Internet", "Versicherungen", "Shopping"]),
  );
  await expect(category).toHaveValue("Prüfen");
  await unknown
    .getByLabel("Kategorie", { exact: true })
    .selectOption("Shopping");
  await unknown
    .getByRole("button", { name: "Zuordnung übernehmen", exact: true })
    .click();
  await expect(unknown).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  const after = await ledger(page);
  expect(after.transactions).toHaveLength(2);
  expect(
    after.transactions.find(
      (row: Transaction) => row.description === "Unbekannter Händler",
    ),
  ).toMatchObject({
    category: "Shopping",
    pocket: "Raiffeisen Giro",
    includeInPlan: true,
    categoryOverride: true,
  });
  expect(
    after.transactions.find(
      (row: Transaction) => row.description === "Mensa ohne Betrag",
    ),
  ).toBeUndefined();
});

for (const accept of [true, false])
  test(`fixed changes share review and ${accept ? "Ja" : "Nein"} never duplicates salary or leasing`, async ({
    page,
  }) => {
    const state = createSeed();
    state.financeRows = [
      {
        id: "lease",
        label: "Leasing",
        kind: "fixed",
        values: { "2026-08": 289.52, "2026-09": 289.52, "2026-10": 289.52 },
      },
      {
        id: "salary",
        label: "Nettogehalt",
        kind: "income",
        values: { "2026-09": 2576.43 },
      },
    ];
    await seed(page, state);
    const input = csv(
      "03.09.2026;Porsche Bank;03.09.2026;-300,00\n03.09.2026;Gehalt;03.09.2026;2576,43\n03.09.2026;Noch unbekannt;03.09.2026;-9,00",
    );
    await page.getByLabel("Kontoauszüge auswählen").setInputFiles(input);
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText(/Leasing bisher 289,52.*Auszug 300,00/),
    ).toBeVisible();
    await expect(
      dialog.getByRole("region", { name: "Buchung prüfen: Noch unbekannt" }),
    ).toBeVisible();
    await dialog
      .getByRole("button", {
        name: accept
          ? "Neuen Dauerbetrag übernehmen"
          : "Bisherigen Dauerbetrag behalten",
        exact: true,
      })
      .click();
    await dialog
      .getByRole("button", { name: "Später prüfen", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const after = await ledger(page);
    expect(after.transactions).toHaveLength(0);
    const lease = after.financeRows.find(
      (row: { id: string }) => row.id === "lease",
    );
    expect(lease.values["2026-08"]).toBe(289.52);
    expect(lease.values["2026-09"]).toBe(accept ? 300 : 289.52);
    expect(lease.values["2026-10"]).toBe(accept ? 300 : 289.52);
    if (accept) expect(lease.values["2027-12"]).toBe(300);
    await page.reload();
    await ledger(page);
    await page
      .getByLabel("Kontoauszüge auswählen")
      .setInputFiles(
        csv(
          "03.09.2026;Porsche Bank;03.09.2026;-300,00\n03.09.2026;Gehalt;03.09.2026;2576,43",
        ),
      );
    await expect(
      page.getByText("0 neu, 2 Duplikate ignoriert", { exact: true }),
    ).toBeVisible();
    await expect(dialog).toHaveCount(0);
  });

test("Amex auto-saves clear rows; invalid files notify without joining merchant review", async ({
  page,
}) => {
  await seed(page);
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles([
    {
      name: "unbekannt.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("foo;bar\n1;2"),
    },
    {
      name: "amex.csv",
      mimeType: "text/csv",
      buffer: readFileSync(fixturePath("amex")),
    },
  ]);
  const dialog = page.getByRole("dialog");
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: /Dateityp nicht erkannt/ }),
  ).toBeVisible();
  await expect(dialog.getByText(/Dateityp nicht erkannt/)).toHaveCount(0);
  await expect(dialog.getByLabel("Konto/Pocket", { exact: true })).toHaveValue(
    "Amex · AMEX Jannis",
  );
  await expect(
    dialog.getByLabel("Konto/Pocket", { exact: true }),
  ).toHaveJSProperty("readOnly", true);
  await expect(
    page.getByText("2 neu, 0 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const saved = await ledger(page);
  expect(saved.transactions).toHaveLength(2);
  expect(
    saved.transactions.find((row: Transaction) => row.description === "Sakura")
      .pocket,
  ).toBe("AMEX Raphael");
  expect(
    saved.transactions.find(
      (row: Transaction) => row.description === "Pizzeria, Zentrum",
    ).pocket,
  ).toBe("AMEX Jannis");
  await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
  await expect(dialog).toBeVisible();
});

test("a second tab's booking is deduped again before saving an unsure row", async ({
  page,
  context,
}) => {
  await seed(page);
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(csv("03.09.2026;Unbekannt;03.09.2026;-10,00"));
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    page.getByText("0 neu, 0 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  const otherTab = await context.newPage();
  await otherTab.goto("/umsaetze");
  await ledger(otherTab);
  await otherTab.evaluate((storageKey) => {
    const state = JSON.parse(localStorage.getItem(storageKey)!);
    state.transactions.push({
      id: "other-tab-booking",
      date: "2026-09-03",
      bank: "Raiffeisen",
      pocket: "Raiffeisen Giro",
      description: "Unbekannt",
      category: "Shopping",
      categoryOverride: true,
      amount: -10,
      includeInPlan: true,
    });
    localStorage.setItem(storageKey, JSON.stringify(state));
  }, key);
  await expect(
    page.getByRole("cell", {
      name: "Unbekannt",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(1);
  // A confirmed twin from another tab resolves this stale review immediately.
  await expect(dialog).toHaveCount(0);
  const state = await ledger(page);
  expect(
    state.transactions.filter(
      (row: { date: string; description: string; bank: string }) =>
        row.date === "2026-09-03" &&
        row.bank === "Raiffeisen" &&
        row.description === "Unbekannt",
    ),
  ).toHaveLength(1);
  await otherTab.close();
});

test("reload advances the plan and pocket split without visiting plan", async ({
  page,
}) => {
  const state = createSeed();
  state.settings.baselineDate = "2026-09-01";
  state.settings.asOf = "2026-09-11";
  state.settings.allocationStart = "2026-10-01";
  state.financeRows = [
    {
      id: "salary",
      label: "Gehalt",
      kind: "income",
      values: { "2026-10": 2000 },
    },
    {
      id: "food",
      label: "Lebensmittel",
      kind: "variable",
      planCategory: "Lebensmittel",
      values: { "2026-10": 999 },
    },
    {
      id: "lunch",
      label: "Mittagessen",
      kind: "variable",
      planCategory: "Mittagessen",
      values: {},
      overrides: { "2026-10": 33 },
    },
  ];
  state.transactions = ["05", "06", "07", "08"].map((month) => ({
    id: month,
    date: `2026-${month}-02`,
    bank: "Raiffeisen",
    description: "BILLA",
    pocket: null,
    amount: -100,
    category: "Lebensmittel",
    includeInPlan: true,
  }));
  await seed(page, state);
  await page.clock.setFixedTime(new Date("2026-10-01T12:00:00Z"));
  await page.goto("/");
  const after: AppState = await ledger(page);
  expect(after.settings.asOf).toBe("2026-10-01");
  expect(
    after.financeRows.find((row) => row.id === "food")!.values["2026-10"],
  ).toBe(250);
  expect(
    after.financeRows.find((row) => row.id === "lunch")!.values["2026-10"],
  ).toBe(111.5);
  expect(after.financeRows.find((row) => row.id === "lunch")!.overrides).toBeUndefined();
  expect(after.financeRows.filter((row) => row.kind === "variable")).toHaveLength(7);
  const split = page.getByRole("region", {
    name: "Pocket-Verteilung diesen Monat",
  });
  await expect(split).toContainText("Diesen Monat:");
  // 2,000 income - 911.50 mandatory October budgets - 180 savings floor.
  await expect(split).toContainText(/Motorrad.*908,50/);
  await expect(split).toContainText(/Sparkonto.*180,00/);
  await expect(split).not.toContainText(/Urlaub|Notgroschen/);
  await page.goto("/umsaetze");
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(csv("05.09.2026;BILLA;05.09.2026;-100,00"));
  await expect(
    page.getByText("1 neu, 0 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  await page.goto("/");
  // Additional September spending must not alter October budgets or savings.
  await expect(split).toContainText(/Motorrad.*908,50/);
  await expect(split).toContainText(/Sparkonto.*180,00/);
});

test("zero allocations and matching Apple Care never open extra UI", async ({
  page,
}) => {
  const state = createSeed();
  state.financeRows.push({
    id: "apple",
    kind: "fixed",
    label: "Apple Care",
    values: { "2026-09": 14.99 },
  });
  await seed(page, state);
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(
      csv(
        "03.09.2026;Apple Care;03.09.2026;-14,99\n04.09.2026;AppleCare+;04.09.2026;-15,04",
      ),
    );
  await expect(
    page.getByText("0 neu, 2 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await ledger(page)).transactions).toHaveLength(0);
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Pocket-Verteilung diesen Monat" }),
  ).toHaveCount(0);
  await page.reload();
  await ledger(page);
  await expect(
    page.getByRole("region", { name: "Pocket-Verteilung diesen Monat" }),
  ).toHaveCount(0);
});

test("all Revolut statement pockets are locked including personal accounts", async ({
  page,
}) => {
  await seed(page);
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles({
    name: "revolut.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Revolut\nMittagessen (EUR)\nDatum,Beschreibung,Geld ausgezahlt,Geld eingezahlt\n03.09.2026,Unbekannt im Pocket,7,\nPersönliches Konto (EUR)\nDatum,Beschreibung,Geld ausgezahlt,Geld eingezahlt\n04.09.2026,Unbekannt persönlich,8,",
    ),
  });
  const dialog = page.getByRole("dialog");
  const locked = dialog.getByRole("region", {
    name: "Buchung prüfen: Unbekannt im Pocket",
    exact: true,
  });
  await expect(locked.getByLabel("Konto/Pocket", { exact: true })).toHaveValue(
    "Revolut · Mittagessen",
  );
  await expect(
    locked.getByLabel("Konto/Pocket", { exact: true }),
  ).toHaveJSProperty("readOnly", true);
  await locked
    .getByLabel("Kategorie", { exact: true })
    .selectOption("Versicherungen");
  await locked
    .getByRole("button", { name: "Zuordnung übernehmen", exact: true })
    .click();
  await expect(locked).toHaveCount(0);
  const personal = dialog.getByRole("region", {
    name: "Buchung prüfen: Unbekannt persönlich",
    exact: true,
  });
  await expect(
    personal.getByLabel("Konto/Pocket", { exact: true }),
  ).toHaveValue("Revolut · Persönliches Konto");
  await expect(
    personal.getByLabel("Konto/Pocket", { exact: true }),
  ).toHaveJSProperty("readOnly", true);
  await personal
    .getByLabel("Kategorie", { exact: true })
    .selectOption("Shopping");
  await personal
    .getByRole("button", { name: "Zuordnung übernehmen", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const saved = await ledger(page);
  expect(saved.transactions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        description: "Unbekannt im Pocket",
        category: "Versicherungen",
        pocket: "Mittagessen",
        includeInPlan: false,
      }),
      expect.objectContaining({
        description: "Unbekannt persönlich",
        category: "Shopping",
        pocket: "Persönliches Konto",
      }),
    ]),
  );
});

test("only unreadable rows produce a toast, not a review popup", async ({
  page,
}) => {
  await seed(page);
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(csv("03.09.2026;BIPA;03.09.2026;unlesbar"));
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: /Ungültiger oder fehlender Betrag/ }),
  ).toBeVisible();
  await expect(
    page.getByText("0 neu, 0 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await ledger(page)).transactions).toHaveLength(0);
});

const exampleFolder = path.join(process.cwd(), "import-example");
for (const source of ["Raiffeisen", "Revolut", "Amex"])
  test(`original ${source} sample imports in the browser`, async ({ page }) => {
    const names = existsSync(exampleFolder) ? readdirSync(exampleFolder) : [];
    const name = names.find((name) =>
      source === "Amex"
        ? /\.pdf$/i.test(name)
        : source === "Raiffeisen"
          ? /^Umsatzliste.*\.csv$/i.test(name)
          : /^consolidated.*\.csv$/i.test(name),
    );
    test.skip(!name, "Private Beispieldatei lokal nicht vorhanden");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const initial = createSeed();
    if (source === "Revolut") {
      initial.settings.balances.Sparkonto = 12;
      initial.settings.balances.Urlaub = 13;
      initial.settings.balances.Motorrad = 14;
    }
    await seed(page, initial);
    await page
      .getByLabel("Kontoauszüge auswählen")
      .setInputFiles(path.join(exampleFolder, name!));
    await expect(
      page.getByText(/\d+ neu, \d+ Duplikate ignoriert/),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByText(
        /Dateityp nicht erkannt|PDF-Datei konnte nicht gelesen werden/,
      ),
    ).toHaveCount(0);
    const saved: AppState = await ledger(page);
    expect(
      saved.transactions.filter((row) => row.bank === source).length,
    ).toBeGreaterThan(0);
    if (source === "Revolut") {
      expect(saved.pocketSnapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pocket: "Sparkonto",
            date: "2026-09-11",
            balance: 1782.59,
          }),
          expect.objectContaining({ pocket: "Urlaub", balance: 1312.06 }),
          expect.objectContaining({ pocket: "Motorrad", balance: 0 }),
        ]),
      );
      expect(saved.pocketSnapshots).toHaveLength(3);
      await page.goto("/pockets");
      await expect(page.getByLabel("Sparkonto Kontostand")).toContainText(
        /1\.782,59/,
      );
      await expect(page.getByLabel("Urlaub Kontostand")).toContainText(
        /1\.312,06/,
      );
      await expect(page.getByLabel("Motorrad Kontostand")).toContainText(
        /0,00/,
      );
      await expect(page.locator("form:visible")).toHaveCount(0);
      await page.reload();
      await expect(page.getByLabel("Sparkonto Kontostand")).toContainText(
        /1\.782,59/,
      );
      expect((await ledger(page)).transactions).toHaveLength(
        saved.transactions.length,
      );
    }
    if (source === "Amex") {
      expect(
        saved.transactions.some(
          (row) => row.date === "2026-07-13" && row.amount === -13.76,
        ),
      ).toBe(true);
      const worker = await page.request.get("/api/pdf-worker");
      expect(worker.ok()).toBe(true);
      expect(worker.headers()["content-type"]).toContain("javascript");
    }
    expect(errors).toEqual([]);
  });

test("merchant category choices survive reload and auto-save the next statement", async ({
  page,
}) => {
  await seed(page);
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(
      csv("03.09.2026;Mein Händler Referenz 123456;03.09.2026;-12,00"),
    );
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Kategorie", { exact: true })
    .selectOption("Shopping");
  await dialog
    .getByRole("button", { name: "Zuordnung übernehmen", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect((await ledger(page)).merchantRules).toHaveLength(1);
  await page.reload();
  await ledger(page);
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(
      csv("04.09.2026;Mein Händler Referenz 789012;04.09.2026;-15,00"),
    );
  await expect(
    page.getByText("1 neu, 0 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  const saved = await ledger(page);
  expect(saved.transactions).toHaveLength(2);
  expect(
    saved.transactions.every((row: Transaction) => row.category === "Shopping"),
  ).toBe(true);
});

test("matching fixed receipts dismiss the quiet missing-cost hint without adding a booking", async ({
  page,
}) => {
  const state = createSeed();
  state.financeRows = [
    {
      id: "insurance",
      kind: "fixed",
      label: "Haftpflicht",
      values: { "2026-09": 48.88, "2026-10": 48.88 },
    },
  ];
  await seed(page, state);
  await page.goto("/");
  await expect(page.getByLabel("Auszugsstatus")).toContainText(
    "1 Fixkosten ohne Auszugsbeleg",
  );
  await page.goto("/umsaetze");
  await page
    .getByLabel("Kontoauszüge auswählen")
    .setInputFiles(csv("03.09.2026;Allianz;03.09.2026;-48,88"));
  await expect(
    page.getByText("0 neu, 1 Duplikate ignoriert", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const saved = await ledger(page);
  expect(saved.transactions).toHaveLength(0);
  expect(saved.fixedReceipts).toHaveLength(1);
  await page.goto("/");
  await expect(page.getByLabel("Auszugsstatus")).not.toContainText(
    "Fixkosten ohne Auszugsbeleg",
  );
  await page.reload();
  await ledger(page);
  await expect(page.getByLabel("Auszugsstatus")).not.toContainText(
    "Fixkosten ohne Auszugsbeleg",
  );
  await page.clock.setFixedTime(new Date("2026-10-06T12:00:00Z"));
  await page.reload();
  await expect(page.getByLabel("Auszugsstatus")).toContainText(
    "1 Fixkosten ohne Auszugsbeleg",
  );
});
