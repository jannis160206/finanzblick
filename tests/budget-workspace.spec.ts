import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { appStateSchema, type AppState } from "../src/lib/types";
import { calculateDashboard, round, sum } from "../src/lib/calc";
import { currency } from "../src/lib/format";
import { budgetBooking, budgetFixture } from "./fixtures/budget-state";
import { syncPayrollBudget } from "../src/lib/payroll-budget";

test.skip(
  process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1",
  "Requires an isolated account database.",
);
test.use({ timezoneId: "Europe/Vienna" });

let cookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];
test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Benutzername", { exact: true }).fill("admin");
  await page
    .getByLabel("Passwort", { exact: true })
    .fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByText("Synchronisiert", { exact: true }),
  ).toBeAttached();
  cookies = await context.cookies();
  await context.close();
});

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
async function unlock(page: Page, heading = "Budget") {
  const security = page.getByRole("button", {
    name: /^Sicherheitsmodus (aktivieren|deaktivieren)$/,
  });
  await expect(security).toBeEnabled();
  if ((await security.getAttribute("aria-pressed")) === "true")
    await security.click();
  await expect(
    page.getByRole("heading", { name: heading, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Synchronisiert", { exact: true }),
  ).toBeAttached();
}
async function open(page: Page, fixture = budgetFixture()) {
  // Already in sync with the salary forecast, so the automatic budget changes nothing on load.
  const state = syncPayrollBudget(fixture).state;
  await page.clock.setFixedTime(new Date("2026-10-08T10:00:00Z"));
  await page.context().addCookies(cookies);
  await page.goto("/budget");
  await expect(
    page.getByText("Synchronisiert", { exact: true }),
  ).toBeAttached();
  const previous = await snapshot(page);
  const response = await page.request.put("/api/finance", {
    headers: previous.headers,
    data: { state, revision: previous.revision },
  });
  expect(response.status()).toBe(200);
  await page.goto("/budget");
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
async function summary(page: Page, state: AppState) {
  const plan = calculateDashboard(state).plan;
  const actual = round(sum(plan.rows.map((row) => row.actual)));
  const region = page.getByRole("region", { name: "Budgetübersicht" });
  await expect(region.getByLabel("Monatsbudget", { exact: true })).toHaveText(
    currency(plan.total),
  );
  await expect(region.getByLabel("Ist-Ausgaben", { exact: true })).toHaveText(
    currency(actual),
  );
  await expect(region.getByLabel("Budgetrest", { exact: true })).toHaveText(
    currency(round(plan.total - actual)),
  );
}

for (const width of [1440, 390, 320]) {
  test(`budget overview and read-only filters fit ${width}px in both themes`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = await open(page);
    await summary(page, state);
    await expect(page.getByRole("article")).toHaveCount(7);
    await expect(page.getByRole("table")).toHaveCount(0);
    const rows = calculateDashboard(state).plan.rows;
    for (const row of rows) {
      const card = page.getByRole("article", { name: row.label, exact: true });
      await expect(
        card.getByRole("heading", { name: row.label, exact: true }),
      ).toBeVisible();
      await expect(
        card.getByLabel(`${row.label} Plan`, { exact: true }),
      ).toHaveText(currency(row.total));
      await expect(
        card.getByLabel(`${row.label} Ist`, { exact: true }),
      ).toHaveText(currency(row.actual));
      const difference = round(row.total - row.actual);
      await expect(
        card.getByLabel(
          `${row.label} ${difference < 0 ? "Überschreitung" : "Restbudget"}`,
          { exact: true },
        ),
      ).toHaveText(currency(Math.abs(difference)));
    }
    await expect(
      page.getByRole("button", { name: "Urlaub", exact: true }),
    ).not.toBeVisible();
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`budget-${width}-dark.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Farbschema wechseln", exact: true })
      .click();
    await expect(page.locator("html")).toHaveClass(/light/);
    await page.screenshot({
      path: testInfo.outputPath(`budget-${width}-light.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Über Budget (2)" }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
    await summary(page, state);
    await page.getByRole("button", { name: "Alle (7)" }).click();
    await expect(page.getByRole("article")).toHaveCount(7);
    await expect(
      page.getByText("Budgetberechnung", { exact: true }),
    ).toHaveCount(0);
    expect((await snapshot(page)).state).toEqual(state);
    await page.reload();
    await unlock(page);
    await expect(
      page.getByRole("button", { name: "Alle (7)" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "Urlaub", exact: true }),
    ).not.toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`existing holiday confirmation updates model budgets and persists at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const initial = await open(page);
    await page.goto("/umsaetze");
    await unlock(page, "Umsätze");
    const trigger = page.getByRole("button", { name: "Urlaub", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Urlaubs-Zeiträume" });
    await dialog.getByLabel("Von", { exact: true }).fill("2026-10-05");
    await dialog.getByLabel("Bis", { exact: true }).fill("2026-10-09");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect((await snapshot(page)).state).toEqual(initial);
    await trigger.click();
    await dialog.getByRole("button", { name: "Zeitraum speichern" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Bitte Anfang und Ende",
    );
    expect((await snapshot(page)).state).toEqual(initial);
    await dialog.getByLabel("Von", { exact: true }).fill("2026-10-05");
    await dialog.getByLabel("Bis", { exact: true }).fill("2026-10-09");
    await dialog.getByRole("button", { name: "Zeitraum speichern" }).click();
    await dialog.getByRole("button", { name: "Fertig" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(
      page.getByText("Synchronisiert", { exact: true }),
    ).toBeAttached();
    await page.goto("/budget");
    await unlock(page);
    await expect(
      page.getByLabel("Mittagessen Plan", { exact: true }),
    ).toHaveText(currency(85));
    await expect(
      page.getByText("Synchronisiert", { exact: true }),
    ).toBeAttached();
    const saved = (await snapshot(page)).state;
    expect(saved.holidayRanges).toEqual([
      { from: "2026-10-05", to: "2026-10-09" },
    ]);
    expect(saved.transactions).toEqual(initial.transactions);
    expect(saved.savingsGoals).toEqual(initial.savingsGoals);
    expect(saved.trBalances).toEqual(initial.trBalances);
    expect(saved.financeRows.filter((row) => row.kind !== "variable")).toEqual(
      initial.financeRows.filter((row) => row.kind !== "variable"),
    );
    const oldRows = calculateDashboard(initial).plan.rows;
    const newRows = calculateDashboard(saved).plan.rows;
    expect(
      newRows.filter((row) => row.id !== "lunch").map((row) => row.total),
    ).toEqual(
      oldRows.filter((row) => row.id !== "lunch").map((row) => row.total),
    );
    await summary(page, saved);
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`budget-${width}-holiday-saved.png`),
      fullPage: true,
    });
    await page.reload();
    await unlock(page);
    await expect(
      page.getByLabel("Mittagessen Plan", { exact: true }),
    ).toHaveText(currency(85));
    await page.goto("/umsaetze");
    await unlock(page, "Umsätze");
    await trigger.click();
    await dialog
      .getByRole("button", {
        name: "Urlaub löschen: 2026-10-05 bis 2026-10-09",
      })
      .click();
    await dialog.getByRole("button", { name: "Fertig" }).click();
    await page.goto("/budget");
    await unlock(page);
    await expect(
      page.getByLabel("Mittagessen Plan", { exact: true }),
    ).toHaveText(currency(111.5));
    await summary(page, initial);
  });
}

test("large actual amounts and negative budget rests stay readable without page overflow at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const fixture = budgetFixture();
  fixture.transactions = [
    budgetBooking("maximum", "Lebensmittel", -1_000_000_000),
  ];
  const state = await open(page, fixture);
  await summary(page, state);
  await expect(
    page.getByLabel("Lebensmittel & Haushalt Ist", { exact: true }),
  ).toHaveText(currency(1_000_000_000));
  await expect(
    page.getByRole("progressbar", {
      name: "Lebensmittel & Haushalt Budgetverbrauch",
    }),
  ).toHaveAttribute("aria-valuenow", "100");
  await noOverflow(page);
  await page.getByRole("button", { name: "Über Budget (1)" }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await noOverflow(page);
});
