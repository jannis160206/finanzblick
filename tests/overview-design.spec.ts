import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { createEmptyAccountState } from "../src/lib/account-state";
import { calculateDashboard, monthsForYear } from "../src/lib/calc";
import { currency, monthLabel } from "../src/lib/format";
import { initializeMotorcycleGoal } from "../src/lib/goals";
import { monthlyVariableBudget } from "../src/lib/variable-budgets";
import { appStateSchema, plannedOneOffSchema, type AppState } from "../src/lib/types";

test.skip(process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1", "Requires an isolated account-mode test database.");
test.use({ timezoneId: "Europe/Vienna" });

function fixture() {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-01";
  state.settings.balances = { Sparkonto: 1800, Urlaub: 1300, Notgroschen: 4400, Motorrad: 0 };
  const months = [...monthsForYear(2026), ...monthsForYear(2027)];
  state.financeRows = [
    { id: "salary", kind: "income", label: "Gehalt", values: Object.fromEntries(months.map((month) => [month, 3000])) },
    { id: "rent", kind: "fixed", label: "Wohnen", values: Object.fromEntries(months.map((month) => [month, 600])) },
  ];
  state.transactions = [
    { id: "grocery", date: "2026-10-05", description: "BILLA", amount: -42, bank: "Raiffeisen", pocket: null, category: "Lebensmittel", categoryOverride: true, includeInPlan: false },
    { id: "shopping", date: "2026-10-06", description: "IKEA", amount: -180, bank: "Amex", pocket: "Amex", category: "Shopping", categoryOverride: true, includeInPlan: false, sharedWithRaphael: true },
  ];
  state.savingsGoals = [{ id: "bike", name: "Motorrad", pocket: "Motorrad", target: 5400, date: "2027-04-01" }];
  state.bikeOnlyGoalApplied = false;
  state.plannedOneOffs = [plannedOneOffSchema.parse({ id: "schrank", name: "Schrank", date: "2026-10-10", amount: 400, sharedWithRaphael: true })];
  return initializeMotorcycleGoal(state, 0);
}

async function unlock(page: Page) {
  const privacy = page.getByRole("button", { name: /^Sicherheitsmodus (aktivieren|deaktivieren)$/ });
  await expect(privacy).toBeEnabled();
  if (await privacy.getAttribute("aria-pressed") === "true") await privacy.click();
  await expect(page.getByRole("heading", { name: "Übersicht", exact: true })).toBeVisible();
}

async function snapshot(page: Page) {
  const session = await (await page.request.get("/api/auth/session")).json();
  const headers = { Origin: new URL(page.url()).origin, "X-Finanzblick-Account": session.user.id };
  const response = await page.request.get("/api/finance", { headers });
  expect(response.status()).toBe(200);
  const data = await response.json();
  return { state: appStateSchema.parse(data.state), revision: data.revision, headers };
}

async function open(page: Page, state: AppState) {
  await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
  await page.goto("/login");
  await page.getByLabel("Benutzername", { exact: true }).fill("admin");
  await page.getByLabel("Passwort", { exact: true }).fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
  const original = await snapshot(page);
  const response = await page.request.put("/api/finance", { headers: original.headers, data: { state, revision: original.revision } });
  expect(response.status()).toBe(200);
  await page.reload();
  await unlock(page);
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
  return snapshot(page);
}

async function capture(page: Page, name: string) {
  if (!process.env.FINANZBLICK_OVERVIEW_ARTIFACTS) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByRole("heading", { name: "Übersicht", exact: true })).toBeInViewport();
  await page.screenshot({ path: join(process.env.FINANZBLICK_OVERVIEW_ARTIFACTS, name), fullPage: true });
}

for (const width of [1440, 390]) {
  test(`planning cards separate savings labels and monthly one-offs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = fixture();
    state.plannedOneOffs = [
      plannedOneOffSchema.parse({ id: "licence", name: "Führerschein", date: "2026-10-20", amount: 780, pocket: "Sparkonto" }),
      plannedOneOffSchema.parse({ id: "office", name: "Büro Austattung", date: "2026-11-01", amount: 191.48 }),
      plannedOneOffSchema.parse({ id: "cabinet", name: "Schrank", date: "2026-11-02", amount: 410.56, sharedWithRaphael: true }),
    ];
    const before = await open(page, state);
    const dashboard = calculateDashboard(before.state);
    const savings = page.locator('[data-funding-pot="Sparkonto"]');
    await expect(savings.getByText("Sparkonto", { exact: true })).toBeVisible();
    await expect(savings.getByText("Sparempfehlung", { exact: true })).toBeVisible();
    await expect(savings).toContainText(currency(dashboard.monthlyFunding.find((row) => row.id === "savings")!.amount));
    expect(dashboard.monthlyFunding.find((row) => row.id === "savings")!.amount).toBe(dashboard.current.surplus);
    await expect(savings).toContainText(currency(dashboard.current.surplus));
    await expect(savings.getByLabel("Sparkonto überwiesen")).toHaveCount(0);
    const label = await savings.getByText("Sparkonto", { exact: true }).boundingBox();
    const caption = await savings.getByText("Sparempfehlung", { exact: true }).boundingBox();
    expect(caption!.x).toBeGreaterThan(label!.x + 20);
    const planned = page.getByRole("region", { name: "Geplante Ausgaben", exact: true });
    await expect(planned.getByRole("list", { name: "Geplant Oktober 2026" }).getByRole("listitem")).toHaveText("Führerschein 780 €");
    await expect(planned.getByRole("list", { name: "Geplant November 2026" }).getByRole("listitem")).toHaveText([
      "Büro Austattung 191,48 €", "Schrank 205,28 €",
    ]);
    await expect(planned).not.toContainText("410,56");
    for (const size of width === 390 ? [390, 320] : [1440, 1024]) {
      await page.setViewportSize({ width: size, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    }
    await page.setViewportSize({ width, height: 1000 });
    await capture(page, `overview-planning-${width}-dark.png`);
    await page.getByRole("button", { name: "Farbschema wechseln" }).click();
    await expect(page.locator("html")).toHaveClass(/light/);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await capture(page, `overview-planning-${width}-light.png`);
    await page.getByRole("button", { name: "Geplante Ausgaben", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Abbrechen", exact: true }).click();
    expect((await snapshot(page)).state).toEqual(before.state);
  });

  test(`modern overview preserves financial values and actions at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    const before = await open(page, fixture());
    const dashboard = calculateDashboard(before.state);
    for (const [label, value] of [
      ["Überschuss · Plan", dashboard.current.surplus], ["Einnahmen · Plan", dashboard.current.salaryPlan],
      ["Ausgaben · Ist", dashboard.current.actualSpending], ["Ersparnisse gesamt", dashboard.totalAssets],
    ] as const) {
      await expect(page.getByRole("region", { name: label, exact: true })).toContainText(currency(value));
    }
    await expect(page.getByRole("list", { name: "Geplant Oktober 2026" }).getByRole("listitem")).toHaveText("Schrank 200 €");
    await expect(page.getByRole("progressbar", { name: "Motorradziel" })).toHaveAttribute("aria-valuenow", String(dashboard.countdown.progress));
    const forecast = page.getByRole("region", { name: "Monatsprognose" });
    await expect(forecast.getByRole("article")).toHaveCount(3);
    for (const row of dashboard.ninetyDays) await expect(forecast.getByRole("article", { name: `Prognose ${monthLabel(row.month)}` })).toContainText(currency(row.remaining));
    await expect(page.getByRole("img", { name: "Aktuelle Ausgaben nach Kategorie" }).locator("svg")).toBeVisible();
    await expect(page.getByRole("img", { name: "Prognose des gesamten Pocket-Vermögens" }).locator("svg")).toBeVisible();
    await expect(page.getByRole("img", { name: "Einnahmen, Fixkosten und variable Ausgaben pro Monat" })).toHaveCount(0);
    await page.locator("summary", { hasText: "Einnahmen & Ausgaben" }).click();
    await expect(page.getByRole("img", { name: "Einnahmen, Fixkosten und variable Ausgaben pro Monat" }).locator("svg")).toBeVisible();
    await page.getByRole("button", { name: "Sicherheitsmodus aktivieren", exact: true }).click();
    await expect(page.getByRole("region", { name: "Sichtschutz" })).toBeVisible();
    await expect(page.locator('[aria-label="Prognose des gesamten Pocket-Vermögens"] svg')).toHaveCount(0);
    await unlock(page);
    await expect(page.getByRole("img", { name: "Einnahmen, Fixkosten und variable Ausgaben pro Monat" }).locator("svg")).toBeVisible();
    await page.locator("summary", { hasText: "Einnahmen & Ausgaben" }).click();
    await page.getByRole("button", { name: "Geplante Ausgaben", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Abbrechen", exact: true }).click();
    for (const size of width === 390 ? [390, 320] : [1440, 1024]) {
      await page.setViewportSize({ width: size, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    }
    await page.setViewportSize({ width, height: 1000 });
    await capture(page, `overview-${width}-dark.png`);
    await page.getByRole("button", { name: "Farbschema wechseln" }).click();
    await expect(page.locator("html")).toHaveClass(/light/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await capture(page, `overview-${width}-light.png`);
    const after = await snapshot(page);
    expect(after.state).toEqual(before.state);
    expect(after.revision).toBe(before.revision);
    await page.getByRole("link", { name: "Kontoauszüge importieren", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("empty mobile account stays readable without fake goals or funding", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-07";
  const before = await open(page, state);
  await expect(page.getByText("Noch keine Ausgaben", { exact: true })).toBeVisible();
  await expect(page.getByText("Noch kein Sparziel", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Prognose des gesamten Pocket-Vermögens" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Monatsplan ergänzen" })).toBeVisible();
  await expect(page.getByLabel("Motorrad-Finanzierung")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Pocket-Verteilung diesen Monat" })).toHaveCount(0);
  await expect(page.getByText(/DEIN FINANZCOCKPIT|Ist · alle vier Pockets|Ohne Umbuchungen|NOCH BIS ZUM KAUF/)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await capture(page, "overview-empty-320.png");
  expect((await snapshot(page)).state).toEqual(before.state);
});

test("negative surplus keeps its amount and warning on a compact screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = fixture();
  state.financeRows = [];
  const before = await open(page, state);
  const dashboard = calculateDashboard(before.state);
  expect(dashboard.current.surplus).toBeLessThan(0);
  await expect(page.getByRole("region", { name: "Überschuss · Plan" })).toContainText(currency(dashboard.current.surplus));
  await expect(page.getByRole("region", { name: "Überschuss · Plan" })).toHaveClass(/border-destructive/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await capture(page, "overview-negative-390.png");
  expect((await snapshot(page)).state).toEqual(before.state);
});

test("a planned purchase cannot create a savings recommendation when the real surplus is negative", async ({ page }) => {
  const state = fixture();
  state.financeRows = [{ id: "salary", label: "Gehalt", kind: "income", values: {
    "2026-10": monthlyVariableBudget("2026-10").total + 301.4,
  } }];
  state.transactions = [];
  state.savingsGoals = [];
  state.plannedOneOffs = [plannedOneOffSchema.parse({
    id: "licence", name: "Führerschein", date: "2026-10-20", amount: 780, pocket: "Sparkonto",
  })];
  const before = await open(page, state);
  await expect(page.getByRole("region", { name: "Überschuss · Plan" })).toContainText(currency(-478.6));
  await expect(page.locator('[data-funding-pot="Sparkonto"]')).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Geplant Oktober 2026" }).getByRole("listitem")).toHaveText("Führerschein 780 €");
  expect((await snapshot(page)).state).toEqual(before.state);
});
