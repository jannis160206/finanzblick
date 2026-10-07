import { expect, test, type Page } from "@playwright/test";
import { createEmptyAccountState } from "../src/lib/account-state";
import { calculateDashboard } from "../src/lib/calc";
import { currency } from "../src/lib/format";
import { monthlyVariableBudget } from "../src/lib/variable-budgets";
import { appStateSchema, type Transaction } from "../src/lib/types";

test.skip(process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1", "Requires an isolated account-mode test database.");
test.use({ timezoneId: "Europe/Vienna" });

const booking = (patch: Partial<Transaction>): Transaction => ({
  id: "saving", date: "2026-10-01", bank: "Revolut", pocket: "Sparen",
  description: "Um EUR Sparen von EUR einzustecken", amount: 300,
  category: "Transfer intern", includeInPlan: false, ...patch,
});
async function snapshot(page: Page) {
  const session = await (await page.request.get("/api/auth/session")).json();
  const headers = { Origin: new URL(page.url()).origin, "X-Finanzblick-Account": session.user.id };
  const response = await page.request.get("/api/finance", { headers });
  expect(response.status()).toBe(200);
  const data = await response.json();
  return { headers, revision: data.revision, state: appStateSchema.parse(data.state) };
}
async function unlock(page: Page) {
  const privacy = page.getByRole("button", { name: /^Sicherheitsmodus (aktivieren|deaktivieren)$/ });
  await expect(privacy).toBeEnabled();
  if (await privacy.getAttribute("aria-pressed") === "true") await privacy.click();
}
async function reload(page: Page) {
  await page.reload();
  await unlock(page);
  await expect(page.getByRole("heading", { name: "Übersicht", exact: true })).toBeVisible();
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
}

for (const width of [1440, 390]) {
  test(`savings checkmark requires the main-account route and shows the actual sum at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
    await page.goto("/login");
    await page.getByLabel("Benutzername", { exact: true }).fill("admin");
    await page.getByLabel("Passwort", { exact: true }).fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
    const initial = await snapshot(page);
    const state = createEmptyAccountState();
    state.settings.asOf = "2026-10-07";
    state.settings.baselineDate = "2026-09-11";
    state.financeRows = [{ id: "salary", kind: "income", label: "Gehalt", values: {
      "2026-10": monthlyVariableBudget("2026-10").total + 301.4,
    } }];
    state.transactions = [
      booking({ id: "vacation", pocket: "Urlaub 2026", amount: -300, description: "Auszahlung bei Pocket" }),
      booking({}), booking({ id: "round-1", amount: 0.1 }), booking({ id: "round-2", amount: 0.1 }), booking({ id: "round-3", amount: 0.2 }),
    ];
    expect((await page.request.put("/api/finance", { headers: initial.headers, data: { state, revision: initial.revision } })).status()).toBe(200);
    await reload(page);
    const savings = page.locator('[data-funding-pot="Sparkonto"]');
    await expect(savings.getByText("Sparempfehlung", { exact: true })).toBeVisible();
    await expect(savings).toContainText(currency(301.4));
    await expect(savings.getByLabel("Sparkonto überwiesen")).toHaveCount(0);
    await expect(savings).not.toHaveClass(/border-primary/);
    for (const [amount, total] of [[100, 100], [200, 300]] as const) {
      const saved = await snapshot(page);
      if (amount === 100) {
        saved.state.transactions.push(
          booking({ id: `main-${amount}`, date: "2026-10-06", pocket: "Persönliches Konto", amount: -amount }),
          booking({ id: `credit-${amount}`, date: "2026-10-06", amount }),
        );
        expect((await page.request.put("/api/finance", { headers: saved.headers, data: { state: saved.state, revision: saved.revision } })).status()).toBe(200);
        await reload(page);
      } else {
        await page.goto("/umsaetze");
        await unlock(page);
        const csv = "Revolut\nPersönliches Konto (EUR)\nDatum;Beschreibung;Geld ein-/ausgezahlt\n06.10.2026;Um EUR Sparen von EUR einzustecken;-200,00\nSparen (EUR)\nDatum;Beschreibung;Geld ein-/ausgezahlt\n06.10.2026;Um EUR Sparen von EUR einzustecken;200,00";
        for (let repeat = 0; repeat < 2; repeat++) {
          await page.getByLabel("Kontoauszüge auswählen").setInputFiles({
            name: "sparkonto.csv", mimeType: "text/csv", buffer: Buffer.from(csv),
          });
          await expect(page.getByLabel("Importstatus")).toBeVisible();
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect.poll(async () => (await snapshot(page)).state.transactions.length).toBe(saved.state.transactions.length + 2);
        }
        await page.goto("/");
        await unlock(page);
        await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
      }
      await expect(savings.getByText("Überwiesen", { exact: true })).toBeVisible();
      await expect(savings.getByLabel("Sparkonto überwiesen")).toBeVisible();
      await expect(savings).toContainText(currency(total));
      await expect(savings).not.toContainText(currency(301.4));
      await expect(savings).toHaveClass(/border-primary/);
      const result = await snapshot(page);
      expect(result.state.financeRows).toEqual(saved.state.financeRows);
      expect(result.state.settings).toEqual(saved.state.settings);
      expect(result.state.savingsGoals).toEqual(saved.state.savingsGoals);
      expect(calculateDashboard(result.state).actual.Sparkonto).toBeCloseTo(300.4 + total, 2);
    }
    for (const viewport of width === 390 ? [390, 320] : [1440, 1024]) {
      await page.setViewportSize({ width: viewport, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    }
  });
}
