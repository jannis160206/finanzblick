import { expect, test, type Page } from "@playwright/test";
import { createEmptyAccountState } from "../src/lib/account-state";
import { calculateDashboard, monthsForYear } from "../src/lib/calc";
import { currency, monthLabel, number } from "../src/lib/format";
import { appStateSchema } from "../src/lib/types";

test.skip(
  process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1",
  "Requires an isolated account database.",
);
test.use({ timezoneId: "Europe/Vienna" });

const subscription =
  "Geräteabo · Versicherung für die komplette Büroausstattung";
function fixture() {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-01";
  const months = [...monthsForYear(2026), ...monthsForYear(2027)];
  state.financeRows = [
    {
      id: "salary",
      label: "Gehalt",
      kind: "income",
      values: Object.fromEntries(months.map((month) => [month, 3000])),
    },
    {
      id: "rent",
      label: "Miete",
      kind: "fixed",
      values: Object.fromEntries(months.map((month) => [month, 500])),
    },
    {
      id: "subscription",
      label: subscription,
      kind: "fixed",
      values: { "2026-10": 30 },
    },
    {
      id: "budget-food",
      label: "Lebensmittel & Haushalt",
      kind: "variable",
      values: { "2026-08": 100 },
      overrides: { "2026-08": 100 },
    },
  ];
  state.plannedOneOffs = [
    {
      id: "cabinet",
      name: "Schrank",
      date: "2026-10-10",
      amount: 400,
      pocket: "Giro",
      installments: 1,
      sharedWithRaphael: true,
    },
    {
      id: "license",
      name: "Führerschein",
      date: "2026-10-20",
      amount: 780,
      pocket: "Sparkonto",
      installments: 1,
    },
  ];
  state.transactions = [
    {
      id: "amex",
      bank: "Amex",
      pocket: "Amex",
      date: "2026-10-05",
      description: "Amazon Bestellung",
      amount: -120,
      category: "Shopping",
      includeInPlan: false,
      reviewed: true,
    },
  ];
  state.accountSnapshots = [
    { bank: "Revolut", name: "Amex", date: "2026-09-30", balance: 30 },
  ];
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
    page.getByRole("heading", { name: "Monate", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Synchronisiert", { exact: true }),
  ).toBeAttached();
}
async function open(page: Page) {
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
    data: { state: fixture(), revision: original.revision },
  });
  expect(response.status()).toBe(200);
  await page.goto("/monate");
  await page.reload();
  await unlock(page);
  return (await snapshot(page)).state;
}
async function noPageOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
function row(page: Page, label: string) {
  return page
    .getByRole("table", { name: "Monatsplanung" })
    .getByRole("row", { name: new RegExp(`^${label} `) });
}

test("desktop annual comparison, complete filtered totals and metadata edits remain coherent", async ({
  page,
}, testInfo) => {
  const initial = await open(page);
  const grid = page.getByRole("table", { name: "Monatsplanung" });
  await expect(grid.locator("thead").getByRole("columnheader")).toHaveCount(13);
  const scroller = page.getByLabel(
    "Jahresraster horizontal und vertikal scrollen",
  );
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  const current = await grid
    .locator('thead th[data-current="true"]')
    .boundingBox();
  const bounds = await scroller.boundingBox();
  expect(current!.x).toBeGreaterThan(bounds!.x + 200);
  expect(current!.x + current!.width).toBeLessThanOrEqual(
    bounds!.x + bounds!.width,
  );
  for (const label of ["Einnahmen", "Fixkosten", "Variable Ausgaben"]) {
    const heading = await grid.getByText(label, { exact: true }).boundingBox();
    expect(heading!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(heading!.x + heading!.width).toBeLessThanOrEqual(
      bounds!.x + bounds!.width,
    );
  }
  await expect(
    row(page, "Geplante Einmalausgaben").getByRole("cell").nth(9),
  ).toHaveText(number(980));
  await noPageOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("months-desktop-dark.png"),
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.screenshot({
    path: testInfo.outputPath("months-desktop-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "2027", exact: true }).click();
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollLeft))
    .toBe(0);
  await expect(
    page.getByText("Geplante Einmalausgaben", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Aktueller Monat", exact: true })
    .click();
  await expect(grid.locator("thead").getByRole("columnheader")).toHaveCount(2);
  const forecast = calculateDashboard(initial).current;
  const surplus = page.getByRole("article", {
    name: `Überschuss ${monthLabel("2026-10")}`,
  });
  await expect(surplus).toContainText(currency(forecast.surplus));
  await page
    .getByRole("textbox", { name: "Positionen suchen" })
    .fill("gerateabo");
  await expect(grid.getByText(subscription, { exact: true })).toBeVisible();
  await expect(grid.getByText("Miete", { exact: true })).toHaveCount(0);
  await expect(surplus).toContainText(currency(forecast.surplus));
  await page.getByLabel("Planbereich filtern").selectOption("income");
  await expect(page.getByText("Keine Positionen gefunden")).toBeVisible();
  await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
  expect((await snapshot(page)).state).toEqual(initial);
  await page.getByRole("button", { name: "Plan bearbeiten" }).click();
  const edit = page.getByRole("button", {
    name: "Gehalt bearbeiten",
    exact: true,
  });
  await edit.click();
  await page
    .getByLabel("Bezeichnung", { exact: true })
    .fill("Verworfener Name");
  await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(edit).toBeFocused();
  expect((await snapshot(page)).state).toEqual(initial);
  const salary = page.getByRole("textbox", {
    name: "Gehalt Oktober 2026",
    exact: true,
  });
  await salary.fill("3333,50");
  await salary.press("Tab");
  await expect
    .poll(
      async () =>
        (await snapshot(page)).state.financeRows.find(
          (item) => item.id === "salary",
        )?.values["2026-10"],
    )
    .toBe(3333.5);
  await page.reload();
  await unlock(page);
  await page
    .getByRole("button", { name: "Aktueller Monat", exact: true })
    .click();
  await expect(
    page.getByLabel("Gehalt Oktober 2026", { exact: true }),
  ).toHaveText(number(3333.5));
  const saved = (await snapshot(page)).state;
  expect(saved.transactions).toEqual(initial.transactions);
  expect(saved.financeRows.filter((item) => item.kind === "variable")).toEqual(
    initial.financeRows.filter((item) => item.kind === "variable"),
  );
});

for (const width of [390, 320]) {
  test(`focused planning and historical editing fit ${width}px without changing automatic budgets`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const initial = await open(page);
    const grid = page.getByRole("table", { name: "Monatsplanung" });
    await expect(grid).toHaveAttribute("data-view", "month");
    await expect(grid.locator("thead").getByRole("columnheader")).toHaveCount(
      2,
    );
    await expect(page.getByLabel("Planungsmonat")).toHaveValue("2026-10");
    await expect(
      row(page, "Geplante Einmalausgaben").getByRole("cell"),
    ).toHaveText(number(980));
    await expect(row(page, "Amex offen").getByRole("cell")).toHaveText(
      number(90),
    );
    await noPageOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`months-${width}-dark.png`),
      fullPage: true,
    });
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    await page.screenshot({
      path: testInfo.outputPath(`months-${width}-light.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Plan bearbeiten" }).click();
    await expect(
      page.getByRole("button", { name: "Position hinzufügen", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", {
        name: "Lebensmittel & Haushalt Oktober 2026",
      }),
    ).toHaveCount(0);
    const longRow = row(page, subscription);
    const longInput = longRow.getByRole("textbox");
    const inputBounds = await longInput.boundingBox();
    const cellBounds = await longRow.getByRole("cell").boundingBox();
    expect(inputBounds!.width).toBeGreaterThan(50);
    expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(
      cellBounds!.x + cellBounds!.width,
    );
    await noPageOverflow(page);
    await page.getByLabel("Planungsmonat").selectOption("2026-08");
    const historical = page.getByRole("textbox", {
      name: "Lebensmittel & Haushalt August 2026",
    });
    await historical.fill("125,50");
    await historical.press("Tab");
    await expect
      .poll(
        async () =>
          (await snapshot(page)).state.financeRows.find(
            (item) => item.id === "budget-food",
          )?.overrides?.["2026-08"],
      )
      .toBe(125.5);
    await historical.fill("");
    await historical.press("Tab");
    await expect
      .poll(
        async () =>
          (await snapshot(page)).state.financeRows.find(
            (item) => item.id === "budget-food",
          )?.overrides?.["2026-08"],
      )
      .toBeNull();
    await expect(historical).toHaveAttribute("placeholder", "Auto");
    await page.getByLabel("Planungsmonat").selectOption("2027-01");
    await expect(
      page.getByRole("textbox", { name: /^Lebensmittel & Haushalt / }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Vorheriger Monat" }).click();
    await expect(page.getByLabel("Planungsmonat")).toHaveValue("2026-12");
    await page
      .getByRole("button", { name: "Aktueller Monat", exact: true })
      .click();
    await expect(page.getByLabel("Planungsmonat")).toHaveValue("2026-10");
    await noPageOverflow(page);
    const saved = (await snapshot(page)).state;
    expect(saved.transactions).toEqual(initial.transactions);
    expect(saved.plannedOneOffs).toEqual(initial.plannedOneOffs);
    expect(
      saved.financeRows.find((item) => item.id === "budget-food")?.values[
        "2026-10"
      ],
    ).toBe(250);
    expect(
      saved.financeRows.filter(
        (item) => item.kind === "variable" && item.id !== "budget-food",
      ),
    ).toEqual(
      initial.financeRows.filter(
        (item) => item.kind === "variable" && item.id !== "budget-food",
      ),
    );
  });
}
