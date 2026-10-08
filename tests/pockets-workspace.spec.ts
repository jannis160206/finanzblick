import { expect, test, type Page } from "@playwright/test";
import { calculateDashboard, sum } from "../src/lib/calc";
import { currency, monthLabel } from "../src/lib/format";
import { appStateSchema, pocketNames, type AppState } from "../src/lib/types";
import { pocketFixture } from "./fixtures/pocket-state";

test.skip(
  process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1",
  "Requires an isolated account database.",
);
test.use({ timezoneId: "Europe/Vienna" });

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
    page.getByRole("heading", { name: "Deine Pockets", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Synchronisiert", { exact: true }),
  ).toBeAttached();
}
async function open(page: Page, state = pocketFixture()) {
  await page.clock.setFixedTime(new Date("2026-10-08T10:00:00Z"));
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
  await page.goto("/pockets");
  await page.reload();
  await unlock(page);
  return (await snapshot(page)).state;
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

for (const width of [1440, 390, 320]) {
  test(`pocket balances, clear provenance and read-only details fit ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const initial = await open(page);
    const dashboard = calculateDashboard(initial);
    for (const pocket of pocketNames)
      await expect(
        page.getByLabel(`${pocket} Kontostand`, { exact: true }),
      ).toHaveText(currency(dashboard.actual[pocket]));
    const total = sum(pocketNames.map((pocket) => dashboard.actual[pocket]));
    await expect(page.getByLabel("Reserven gesamt")).toContainText(
      currency(total),
    );
    expect(dashboard.totalAssets).toBe(total + 2445);
    await expect(
      page.getByRole("article", { name: "Motorrad Pocket" }),
    ).toContainText(currency(0));
    const everyday = page.getByRole("region", {
      name: "Revolut Alltagspockets",
    });
    await expect(
      everyday.getByText("Entertainment & Haushalt", { exact: true }),
    ).toBeVisible();
    await expect(
      everyday.getByText(currency(0), { exact: true }),
    ).toBeVisible();
    await expect(
      everyday.getByText("Ohne Auszugssaldo: Tanken", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Pocket-Prognose", exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("table", { name: "Round-ups", exact: true }),
    ).not.toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`pockets-${width}-dark.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Farbschema wechseln", exact: true })
      .click();
    await expect(page.locator("html")).toHaveClass(/light/);
    await page.screenshot({
      path: testInfo.outputPath(`pockets-${width}-light.png`),
      fullPage: true,
    });
    await page.getByText("Verlauf & Prognose", { exact: true }).click();
    await expect(page.getByLabel("Prognose-Pocket")).toHaveValue(
      width < 768 ? "Sparkonto" : "all",
    );
    await expect(
      page
        .getByRole("table", { name: "Pocket-Prognose" })
        .getByRole("columnheader"),
    ).toHaveCount(width < 768 ? 2 : 5);
    await page.getByLabel("Prognosejahr").selectOption("2027");
    await page.getByLabel("Prognose-Pocket").selectOption("Motorrad");
    const forecast = page.getByRole("table", { name: "Pocket-Prognose" });
    const expected = dashboard.timeline.filter(
      (row) => row.available && row.month.startsWith("2027"),
    );
    await expect(forecast.getByRole("row")).toHaveCount(expected.length + 1);
    for (const row of expected) {
      const tableRow = forecast
        .getByRole("row")
        .filter({
          has: page.getByRole("rowheader", {
            name: monthLabel(row.month, true),
            exact: true,
          }),
        });
      await expect(tableRow.getByRole("cell")).toHaveText(
        currency(row.end.Motorrad),
      );
    }
    await page.getByText("Round-ups", { exact: true }).click();
    await expect(
      page.getByText(`2026 · ${currency(0.85)}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Round-ups" }).getByRole("row"),
    ).toHaveCount(3);
    await page.getByLabel("Round-up Jahr").selectOption("2027");
    await expect(
      page.getByText("Keine Round-ups für 2027 gebucht.", { exact: true }),
    ).toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`pockets-${width}-details.png`),
      fullPage: true,
    });
    expect((await snapshot(page)).state).toEqual(initial);
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`TR confirmation, cancellation, validation and reload work at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const initial = await open(page);
    const edit = page.getByRole("button", {
      name: "Kontostand aktualisieren",
      exact: true,
    });
    await edit.click();
    let dialog = page.getByRole("dialog", {
      name: "Kontostand aktualisieren",
      exact: true,
    });
    await dialog.getByLabel("TR Kontostand", { exact: true }).fill("6.123,45");
    expect((await snapshot(page)).state).toEqual(initial);
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(edit).toBeFocused();
    await edit.click();
    dialog = page.getByRole("dialog", {
      name: "Kontostand aktualisieren",
      exact: true,
    });
    const amount = dialog.getByLabel("TR Kontostand", { exact: true });
    await amount.fill("1,234");
    await expect(
      dialog.getByRole("button", { name: "Kontostand speichern" }),
    ).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText("Gültigen Betrag");
    await amount.fill("6.123,45");
    await dialog.getByLabel("TR Standdatum").fill("2026-10-09");
    await expect(
      dialog.getByRole("button", { name: "Kontostand speichern" }),
    ).toBeDisabled();
    await expect(dialog.getByRole("alert")).toContainText("Gültiges Datum");
    expect((await snapshot(page)).state).toEqual(initial);
    await dialog.getByLabel("TR Standdatum").fill("2026-10-08");
    await page.screenshot({
      path: testInfo.outputPath(`tr-dialog-${width}.png`),
    });
    await amount.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(edit).toBeFocused();
    await expect
      .poll(
        async () =>
          (await snapshot(page)).state.trBalances?.find(
            (row) => row.date === "2026-10-08",
          )?.balance,
      )
      .toBe(6123.45);
    await expect(
      page.getByLabel("Notgroschen Kontostand", { exact: true }),
    ).toHaveText(currency(6123.45));
    const saved = (await snapshot(page)).state;
    expect(saved.settings).toEqual(initial.settings);
    expect(saved.transactions).toEqual(initial.transactions);
    expect(saved.financeRows).toEqual(initial.financeRows);
    expect(saved.savingsGoals).toEqual(initial.savingsGoals);
    expect(saved.pocketSnapshots).toEqual(initial.pocketSnapshots);
    await page.reload();
    await unlock(page);
    await expect(
      page.getByLabel("Notgroschen Kontostand", { exact: true }),
    ).toHaveText(currency(6123.45));
    await noOverflow(page);
  });
}

test("maximum balances remain fully readable without horizontal page overflow at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  const state: AppState = pocketFixture();
  state.settings.balances = {
    Notgroschen: 1000000000,
    Urlaub: 1000000000,
    Sparkonto: 1000000000,
    Motorrad: 1000000000,
  };
  state.trBalances = [{ date: "2026-10-02", balance: 1000000000 }];
  state.pocketSnapshots = [
    {
      pocket: "Sparkonto",
      bank: "Revolut",
      date: "2026-10-03",
      balance: 1000000000,
    },
  ];
  state.savingsGoals = [];
  const initial = await open(page, state);
  const dashboard = calculateDashboard(initial);
  for (const pocket of pocketNames)
    await expect(
      page.getByLabel(`${pocket} Kontostand`, { exact: true }),
    ).toHaveText(currency(dashboard.actual[pocket]));
  await noOverflow(page);
});
