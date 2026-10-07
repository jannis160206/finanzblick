import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createEmptyAccountState } from "../src/lib/account-state";
import { appStateSchema, type AppState } from "../src/lib/types";

test.skip(
  process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1",
  "Requires an isolated account database.",
);
test.use({ timezoneId: "Europe/Vienna" });

function fixture() {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-01";
  state.transactions = Array.from({ length: 28 }, (_, index) => ({
    id: `purchase-${index}`,
    date: "2026-10-06",
    description: `Händler ${index}`,
    amount: -(index + 1),
    bank: "Amex",
    pocket: "Amex",
    category: "Shopping" as const,
    categoryOverride: true,
    manualCategory: true,
    reviewed: true,
    includeInPlan: true,
  }));
  state.transactions[0] = {
    ...state.transactions[0],
    merchantAlias: "Möbel Müller",
    amount: -200,
    sharedWithRaphael: true,
  };
  state.transactions.push({
    id: "repayment",
    date: "2026-10-07",
    description: "Raphael Piber",
    amount: 100,
    bank: "Revolut",
    pocket: null,
    category: "Transfer",
    categoryOverride: true,
    manualCategory: true,
    reviewed: true,
    includeInPlan: false,
  });
  state.transactions.push({
    id: "historic",
    date: "2026-09-06",
    description: "Historischer Kauf",
    amount: -50,
    bank: "Amex",
    pocket: "Amex",
    category: "Shopping",
    categoryOverride: true,
    manualCategory: true,
    reviewed: true,
    includeInPlan: true,
  });
  return appStateSchema.parse(state);
}

async function snapshot(page: Page) {
  const session = await (await page.request.get("/api/auth/session")).json();
  const headers = {
    Origin: new URL(page.url()).origin,
    "X-Finanzblick-Account": session.user.id,
  };
  const response = await page.request.get("/api/finance", { headers });
  expect(response.status()).toBe(200);
  const data = await response.json();
  return {
    state: appStateSchema.parse(data.state),
    revision: data.revision,
    headers,
  };
}

async function unlock(page: Page) {
  const button = page.getByRole("button", {
    name: /^Sicherheitsmodus (aktivieren|deaktivieren)$/,
  });
  await expect(button).toBeEnabled();
  if ((await button.getAttribute("aria-pressed")) === "true")
    await button.click();
  await expect(
    page.getByRole("heading", { name: "Umsätze", exact: true }),
  ).toBeVisible();
}

async function open(page: Page, state: AppState) {
  await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
  await page.goto("/login");
  await page.getByLabel("Benutzername", { exact: true }).fill("admin");
  await page
    .getByLabel("Passwort", { exact: true })
    .fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByText("Synchronisiert", { exact: true }),
  ).toBeAttached();
  const original = await snapshot(page);
  const response = await page.request.put("/api/finance", {
    headers: original.headers,
    data: { state, revision: original.revision },
  });
  expect(response.status()).toBe(200);
  await page.goto("/umsaetze");
  await page.reload();
  await unlock(page);
  await expect(
    page.getByText("Synchronisiert", { exact: true }),
  ).toBeAttached();
  return snapshot(page);
}

async function blueColor(page: Page, shade: 400 | 600) {
  return page.evaluate((value) => {
    const sample = document.createElement("span");
    sample.style.color = `var(--color-blue-${value})`;
    document.body.append(sample);
    const color = getComputedStyle(sample).color;
    sample.remove();
    return color;
  }, shade);
}

for (const width of [1440, 390]) {
  test(`fixed costs use a quiet blue recurring icon at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = fixture();
    state.transactions[0].fixedCost = true;
    const before = await open(page, state);
    const booking =
      width < 768
        ? page.getByRole("listitem", { name: "Buchung: Möbel Müller" })
        : page.getByRole("row").filter({ hasText: "Möbel Müller" });
    const icon = booking.getByRole("img", { name: "Wiederkehrende Fixkosten" });
    await expect(icon).toBeVisible();
    await expect(booking.getByText("Fixkosten", { exact: true })).toHaveCount(
      0,
    );
    await expect(icon.locator("svg.lucide-repeat")).toHaveCount(1);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(icon).toHaveCSS("color", await blueColor(page, 400));
    await page.screenshot({
      path: testInfo.outputPath(`recurring-icon-${width}-dark.png`),
      fullPage: true,
    });
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    await expect(icon).toHaveCSS("color", await blueColor(page, 600));
    expect((await snapshot(page)).state).toEqual(before.state);
  });

  test(`compact import feedback keeps every hint readable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = fixture();
    state.importStatus = {
      imported: 351,
      issues: [
        "WhatsApp Image 2026-10-06 at 09.43.24 (5).jpeg, Zeile 5: Amex-Screenshot: Betrag prüfen.",
      ],
    };
    state.reviewQueue = Array.from({ length: 370 }, (_, index) => ({
      kind: "booking" as const,
      id: `pending-${index}`,
      message: "Betrag offen.",
      draft: {
        id: `pending-${index}`,
        date: "2026-10-06",
        description: `Unklar ${index}`,
        amount: null,
        bank: "Amex",
        pocket: "Amex",
        category: "Prüfen" as const,
        includeInPlan: true,
      },
    }));
    const before = await open(page, state);
    const status = page.getByRole("region", {
      name: "Importstatus",
      exact: true,
    });
    await expect(status.getByText("351", { exact: true })).toBeVisible();
    await expect(status.getByText("370", { exact: true })).toBeVisible();
    const hints = status.getByRole("button", {
      name: "Importhinweise",
      exact: true,
    });
    await expect(hints).toContainText("1 Hinweis");
    await expect(hints).toHaveAttribute("aria-expanded", "false");
    await expect(status.getByRole("list")).toHaveCount(0);
    await hints.focus();
    await page.keyboard.press("Enter");
    await expect(hints).toHaveAttribute("aria-expanded", "true");
    const list = status.getByRole("list", {
      name: "Importhinweise",
      exact: true,
    });
    await expect(
      list.getByText("Betrag prüfen.", { exact: true }),
    ).toBeVisible();
    await expect(list.getByText("Zeile 5", { exact: true })).toBeVisible();
    await expect(
      list.getByText("WhatsApp Image 2026-10-06 at 09.43.24 (5).jpeg", {
        exact: true,
      }),
    ).toBeVisible();
    for (const size of width < 768 ? [390, 320] : [1440, 1024]) {
      await page.setViewportSize({ width: size, height: 1000 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        )
        .toBe(false);
    }
    await status.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`import-feedback-${width}-dark.png`),
    });
    await page
      .getByRole("button", { name: "Farbschema wechseln", exact: true })
      .click();
    await expect(page.locator("html")).toHaveClass(/light/);
    await page.screenshot({
      path: testInfo.outputPath(`import-feedback-${width}-light.png`),
    });
    await hints.click();
    await expect(status.getByRole("list")).toHaveCount(0);
    expect((await snapshot(page)).state).toEqual(before.state);
  });

  test(`search, filters, signed full-view export and responsive actions at ${width}px`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    const before = await open(page, fixture());
    const search = page.getByRole("textbox", { name: "Umsätze durchsuchen" });
    await search.fill("amex muller");
    const booking =
      width < 768
        ? page.getByRole("listitem", { name: "Buchung: Möbel Müller" })
        : page.getByRole("row").filter({ hasText: "Möbel Müller" });
    await expect(booking).toContainText("100,00");
    await expect(booking).toContainText("Gesamt 200,00");
    await page
      .getByLabel("Kategorie filtern", { exact: true })
      .selectOption("Shopping");
    await page
      .getByRole("button", {
        name: "Filter entfernen: Suche: amex muller",
        exact: true,
      })
      .click();
    await expect(search).toHaveValue("");
    await expect(
      page.getByLabel("Kategorie filtern", { exact: true }),
    ).toHaveValue("Shopping");
    await page
      .getByRole("button", { name: "Filter entfernen: Shopping", exact: true })
      .click();
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Ansicht exportieren", exact: true })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/Umsaetze_2026-10.*\.csv$/);
    const csv = await readFile((await download.path())!, "utf8");
    expect(csv.match(/"purchase-\d+"/g)).toHaveLength(28);
    expect(csv).not.toContain('"historic"');
    expect(csv).toContain('"-200,00";"-100,00"');
    expect(csv).toContain("kein Einkommen");
    const edit = booking.getByRole("button", {
      name: "Zuordnung ändern: Händler 0",
      exact: true,
    });
    await edit.click();
    const dialog = page.getByRole("dialog", {
      name: "Zuordnung ändern",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Kategorie", { exact: true })
      .selectOption("Möbel & Einrichtung");
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await expect(edit).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`transactions-${width}-dark.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Farbschema wechseln" }).click();
    await expect(page.locator("html")).toHaveClass(/light/);
    for (const size of width < 768 ? [390, 320, 768] : [1440, 1024]) {
      await page.setViewportSize({ width: size, height: 1000 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        )
        .toBe(false);
    }
    await page.screenshot({
      path: testInfo.outputPath(`transactions-${width}-light.png`),
      fullPage: true,
    });
    expect((await snapshot(page)).state).toEqual(before.state);
    expect(errors).toEqual([]);
  });

  test(`batch preview, cancel, multi-page confirmation and persistence at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const before = await open(page, fixture());
    await page.getByLabel("Auswählen: Händler 0", { exact: true }).check();
    await page
      .getByRole("button", { name: "Nächste Seite", exact: true })
      .click();
    await page
      .getByRole("checkbox", {
        name: "Buchungen dieser Seite auswählen",
        exact: true,
      })
      .check();
    await page
      .getByRole("button", { name: "Auswahl zuordnen", exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "Auswahl zuordnen",
      exact: true,
    });
    await dialog
      .getByLabel("Kategorie für Auswahl", { exact: true })
      .selectOption("Möbel & Einrichtung");
    await expect(
      dialog
        .getByRole("list", { name: "Zuordnungsvorschau" })
        .getByRole("listitem"),
    ).toHaveCount(5);
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Auswahl zuordnen", exact: true }),
    ).toBeFocused();
    expect((await snapshot(page)).state).toEqual(before.state);
    await page
      .getByRole("button", { name: "Auswahl zuordnen", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Auswahl zuordnen",
      exact: true,
    });
    await dialog
      .getByLabel("Kategorie für Auswahl", { exact: true })
      .selectOption("Möbel & Einrichtung");
    await dialog
      .getByRole("button", { name: "Zuordnungen übernehmen", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Umsätze durchsuchen" }),
    ).toBeFocused();
    await expect(
      page.getByRole("group", { name: "Ausgewählte Buchungen" }),
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await snapshot(page)).state.transactions.filter(
            (row) => row.category === "Möbel & Einrichtung",
          ).length,
      )
      .toBe(5);
    const after = (await snapshot(page)).state;
    for (const original of before.state.transactions) {
      const saved = after.transactions.find((row) => row.id === original.id)!;
      const facts = Object.fromEntries(
        Object.entries(original).filter(([key]) => key !== "category"),
      );
      expect(saved).toMatchObject(facts);
    }
    expect(after.financeRows).toEqual(before.state.financeRows);
    expect(after.months).toEqual(before.state.months);
    expect(after.settings).toEqual(before.state.settings);
    await page.reload();
    await unlock(page);
    await page
      .getByLabel("Kategorie filtern", { exact: true })
      .selectOption("Möbel & Einrichtung");
    await expect(page.getByText("5 Treffer", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Geteilt", exact: true }).click();
    await page.getByRole("tab", { name: /^Offen/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Geteilt", exact: true }),
    ).toContainText("Keine offenen Teilungen");
  });
}

test("an externally deleted booking blocks the open editor instead of crashing", async ({
  page,
}) => {
  await open(page, fixture());
  await page
    .getByRole("button", { name: "Zuordnung ändern: Händler 0", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Zuordnung ändern",
    exact: true,
  });
  const latest = await snapshot(page);
  const state = {
    ...latest.state,
    transactions: latest.state.transactions.filter(
      (row) => row.id !== "purchase-0",
    ),
  };
  const response = await page.request.put("/api/finance", {
    headers: latest.headers,
    data: { state, revision: latest.revision },
  });
  expect(response.status()).toBe(200);
  await expect(dialog.getByRole("alert")).toContainText(
    "geändert oder gelöscht",
    { timeout: 25_000 },
  );
  await expect(
    dialog.getByRole("button", { name: "Zuordnung übernehmen", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Umsätze durchsuchen" }),
  ).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Umsätze", exact: true }),
  ).toBeVisible();
  expect(
    (await snapshot(page)).state.transactions.some(
      (row) => row.id === "purchase-0",
    ),
  ).toBe(false);
});
