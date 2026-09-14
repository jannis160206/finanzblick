import { test, expect } from "@playwright/test";
import { createSeed } from "../src/lib/seed";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-11T12:00:00Z"));
});

test("all six screens render without runtime errors and theme persists", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  for (const [route, title] of [
    ["/", "Übersicht"],
    ["/umsaetze", "Umsätze"],
    ["/monate", "Monate"],
    ["/pockets", "Deine Pockets"],
    ["/plan", "Alltagsbudget"],
    ["/einstellungen", "Einstellungen"],
  ]) {
    await page.goto(route);
    await expect(
      page.getByRole("heading", { level: 1, name: title, exact: true }),
    ).toBeVisible();
  }
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Farbschema wechseln" }).click();
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/light/);
  expect(errors).toEqual([]);
});

test("Dark Reader opt-out protects SSR icons before hydration", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    // Model the extension's document-start mutations and documented lock check.
    const applyExtensionStyles = () => {
      if (document.querySelector('meta[name="darkreader-lock"]')) return;
      document.querySelectorAll<SVGElement>("svg[stroke]").forEach((svg) => {
        svg.setAttribute("data-darkreader-inline-stroke", "");
        svg.style.setProperty("--darkreader-inline-stroke", "currentColor");
      });
    };
    new MutationObserver(applyExtensionStyles).observe(document, {
      childList: true,
      subtree: true,
    });
    applyExtensionStyles();
  });
  const response = await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Übersicht", exact: true }),
  ).toBeVisible();
  await expect(page.locator("aside svg").first()).toBeVisible();
  await expect(page.locator("svg[data-darkreader-inline-stroke]")).toHaveCount(
    0,
  );
  const html = await response!.text();
  const lockIndex = html.indexOf('name="darkreader-lock"');
  expect(lockIndex).toBeGreaterThan(html.indexOf("<head>"));
  expect(lockIndex).toBeLessThan(html.indexOf("</head>"));
  expect(lockIndex).toBeLessThan(html.indexOf("<svg"));
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Farbschema wechseln" }).click();
  await expect(page.locator("html")).toHaveClass(/light/);
  expect(errors).toEqual([]);
});

test("transaction import, edit, persistence and delete", async ({ page }) => {
  await page.goto("/umsaetze");
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles({
    name: "Browserpruefung.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Buchungsdatum;Verwendungszweck/Text;Valuta;Betrag\n11.09.2026;Browserprüfung Einkauf;11.09.2026;-12,34",
    ),
  });
  const review = page.getByRole("dialog");
  const imported = review.getByRole("region", { name: "Buchung prüfen: Browserprüfung Einkauf", exact: true });
  await imported
    .getByLabel("Kategorie", { exact: true })
    .selectOption("Shopping");
  await imported
    .getByRole("button", { name: "Zuordnung übernehmen", exact: true })
    .click();
  await expect(imported).toHaveCount(0);
  await review.getByRole("button", { name: "Später prüfen" }).first().click();
  await page.getByLabel("Umsätze durchsuchen").fill("Browserprüfung");
  await expect(
    page.getByRole("cell", { name: "Browserprüfung Einkauf", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Zuordnung ändern: Browserprüfung Einkauf" })
    .click();
  await expect(
    page.getByLabel("Beschreibung", { exact: true }),
  ).toHaveJSProperty("readOnly", true);
  await page
    .getByLabel("Kategorie", { exact: true })
    .selectOption("Gesundheit");
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Umsätze durchsuchen").fill("Browserprüfung");
  await expect(
    page.getByRole("cell", { name: "Browserprüfung Einkauf", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Gesundheit", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Weitere Aktionen: Browserprüfung Einkauf").click();
  await page
    .getByRole("button", { name: "Löschen: Browserprüfung Einkauf" })
    .click();
  await page.getByRole("button", { name: "Endgültig löschen" }).click();
  await expect(
    page.getByText("Keine Umsätze gefunden", { exact: true }),
  ).toBeVisible();
});

test("month inputs update and survive reload", async ({ page }) => {
  await page.goto("/monate");
  await page.getByRole("button", { name: "Ausnahmebearbeitung" }).click();
  const input = page.getByRole("textbox", {
    name: "Nettogehalt September 2026",
    exact: true,
  });
  await input.fill("3.123,45");
  await input.press("Enter");
  await expect(input).toHaveValue("3.123,45");
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Ausnahmebearbeitung" }).click();
  await expect(input).toHaveValue("3.123,45");
});

test("transactions default to this month with transfers hidden but retained", async ({
  page,
}) => {
  const state = createSeed();
  state.settings.baselineDate = "2026-09-01";
  state.transactions = [
    {
      id: "food",
      date: "2026-09-03",
      description: "BIPA aktuell",
      amount: -7,
      category: "Mittagessen",
      pocket: "Raiffeisen Giro",
      bank: "Raiffeisen",
      includeInPlan: true,
    },
    {
      id: "old",
      date: "2026-08-03",
      description: "BIPA Vormonat",
      amount: -8,
      category: "Mittagessen",
      pocket: "Raiffeisen Giro",
      bank: "Raiffeisen",
      includeInPlan: true,
    },
    {
      id: "in",
      date: "2026-09-03",
      description: "Um EUR Sparen einzustecken",
      amount: 50,
      category: "Transfer intern",
      pocket: "Sparen",
      bank: "Revolut",
      includeInPlan: false,
    },
    {
      id: "out",
      date: "2026-09-03",
      description: "Gesendet von Revolut",
      amount: -50,
      category: "Sonstiges",
      pocket: "Raiffeisen Giro",
      bank: "Raiffeisen",
      includeInPlan: false,
    },
    {
      id: "round",
      date: "2026-09-03",
      description: "Auszahlung bei Pocket",
      amount: -1,
      category: "Transfer",
      pocket: "Mittagessen",
      bank: "Revolut",
      includeInPlan: false,
    },
  ];
  await page.addInitScript((state) => {
    if (!localStorage.getItem("finanzdashboard.v1"))
      localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
  }, state);
  await page.goto("/umsaetze");
  await expect(page.getByLabel("Monat filtern")).toHaveValue("2026-09");
  await expect(page.getByLabel("Transfers anzeigen")).not.toBeChecked();
  await expect(
    page.getByRole("cell", { name: "BIPA aktuell", exact: true }),
  ).toBeVisible();
  for (const description of [
    "BIPA Vormonat",
    "Um EUR Sparen einzustecken",
    "Gesendet von Revolut",
    "Auszahlung bei Pocket",
  ])
    await expect(
      page.getByRole("cell", { name: description, exact: true }),
    ).toHaveCount(0);
  await page.getByText("Weitere Filter", { exact: true }).click();
  await page.getByLabel("Transfers anzeigen").check();
  await expect(
    page.getByRole("cell", { name: "Um EUR Sparen einzustecken", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Gesendet von Revolut", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Auszahlung bei Pocket", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Monat filtern").selectOption("");
  await expect(
    page.getByRole("cell", { name: "BIPA Vormonat", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zurücksetzen" }).click();
  await expect(page.getByLabel("Monat filtern")).toHaveValue("2026-09");
  await expect(page.getByLabel("Transfers anzeigen")).not.toBeChecked();
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("finanzdashboard.v1")!).transactions
          .length,
    ),
  ).toBe(5);
  await page.goto("/pockets");
  const savings = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Sparkonto", exact: true }),
  });
  await expect(savings).toContainText("1.833,59");
});

test("months omit pocket chains and Revolut pots have no manual movement form", async ({
  page,
}) => {
  await page.goto("/monate");
  const grid = page.locator(".month-grid");
  await expect(grid).not.toContainText(
    /Sparrate|Entnahme|Endstand|Zinsen|Motorrad|Notgroschen|Sparkonto|Urlaub|Start/,
  );
  await expect(grid.getByText("Einnahmen", { exact: true })).toBeVisible();
  await expect(grid.getByText("Fixkosten", { exact: true })).toBeVisible();
  await expect(
    grid.getByText("Variable Ausgaben", { exact: true }),
  ).toBeVisible();
  await expect(grid.locator("input")).toHaveCount(0);
  await page.goto("/pockets");
  await expect(
    page.getByText(/Historische Startstände|01\.01\.2026|unabhängig/),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", {
      name: "Pocket-Bewegung",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.locator("form:visible")).toHaveCount(0);
  const savings = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Sparkonto", exact: true }),
  });
  await expect(savings).toContainText("1.782,59");
  for (const pocket of ["Sparkonto", "Urlaub", "Motorrad"])
    await expect(
      page.getByLabel(`${pocket} Kontostand`, { exact: true }),
    ).toBeVisible();
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(savings).toContainText("1.782,59");
  await expect(page.locator("form:visible")).toHaveCount(0);
});

test("Excel download reimports through preview", async ({ page }) => {
  await page.goto("/einstellungen");
  await expect(
    page.getByRole("heading", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportieren", exact: true }).click();
  const file = await downloading;
  const path = await file.path();
  expect(path).toBeTruthy();
  await page.getByLabel("Excel-Datei auswählen").setInputFiles({
    name: "Sicherung.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: await (await import("node:fs/promises")).readFile(path!),
  });
  await expect(
    page.getByRole("heading", {
      name: "Sicherung wiederherstellen",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Sicherung wiederherstellen und aktuelle Daten ersetzen",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Sicherung wiederherstellen",
      exact: true,
    }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Einstellungen", exact: true }),
  ).toBeVisible();
});

test("mobile navigation and layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Übersicht", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Pockets", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Deine Pockets", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
