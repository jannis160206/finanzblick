import { expect, test, type Page } from "@playwright/test";
import { reconcileSharedHoliday } from "../src/lib/shared-holiday";
import { createSeed } from "../src/lib/seed";
import type { AppState, Transaction } from "../src/lib/types";

// Nur synthetische Daten.
const key = "finanzdashboard.v1";
const row = (id: string, date: string, amount: number, description: string, patch: Partial<Transaction> = {}): Transaction => ({
  id, date, amount, description, bank: "Amex", pocket: "Amex", category: "Restaurants", includeInPlan: true,
  categoryOverride: true, manualCategory: true, reviewed: true, ...patch,
});

async function stored(page: Page): Promise<AppState> {
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toHaveCount(1);
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}

for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
  test(`asks which purchase a credit refunds and shows the own cost after it at ${width}px (${theme})`, async ({ page }, testInfo) => {
    const state = createSeed();
    state.settings.asOf = "2026-11-17";
    state.settings.baselineDate = "2026-09-01";
    state.fixedReceipts = [];
    state.reviewQueue = [];
    state.transactions = [
      row("trattoria", "2026-10-30", -48, "Trattoria Sole"),
      row("sushi", "2026-10-25", -68.9, "Sushi Bar Mond"),
      row("gourmet", "2026-11-02", 48, "Gourmet Gutschrift", { category: "Rückerstattungen", reviewed: false, manualCategory: false }),
      row("baumarkt", "2026-09-21", -64.2, "Baumarkt Nord", { bank: "Raiffeisen", pocket: "Raiffeisen Giro", category: "Wohnen & Haushalt" }),
      row("baumarkt-back", "2026-10-02", 24.8, "Baumarkt Nord", { bank: "Raiffeisen", pocket: "Raiffeisen Giro", category: "Rückerstattungen",
        reviewed: false, manualCategory: false }),
    ];
    await page.setViewportSize({ width, height: width < 768 ? 812 : 1000 });
    await page.clock.setFixedTime(new Date("2026-11-17T09:00:00Z"));
    await page.addInitScript(({ key, state, theme }) => {
      localStorage.setItem("theme", theme);
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
    }, { key, state, theme });
    await page.goto("/umsaetze");
    expect((await stored(page)).reviewQueue?.length).toBe(2);
    await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
    const dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });

    // The Amex benefit credit: the restaurant with the same amount is suggested, another one can be picked from the list.
    const gourmet = dialog.getByRole("region", { name: "Gutschrift prüfen: Gourmet Gutschrift", exact: true });
    await expect(gourmet.getByText(/^Eigenanteil/)).toHaveText("Eigenanteil 0,00 €");
    await expect(gourmet).toContainText("War das eine Rückerstattung für Trattoria Sole vom");
    const merchant = dialog.getByRole("region", { name: "Gutschrift prüfen: Baumarkt Nord", exact: true });
    await expect(merchant.getByText(/^Eigenanteil/)).toHaveText("Eigenanteil 39,40 €");
    await expect(merchant.getByLabel("Erkannte Buchung: Baumarkt Nord")).toBeVisible();
    // The dialog's opening animation is over before the picture.
    await gourmet.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: testInfo.outputPath(`refund-review-${width}-${theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    await gourmet.getByRole("button", { name: "Andere Buchung wählen" }).click();
    await gourmet.getByRole("radio", { name: /^Sushi Bar Mond/ }).check();
    await expect(gourmet.getByText(/^Eigenanteil/)).toHaveText("Eigenanteil 20,90 €");
    await gourmet.getByRole("button", { name: "Rückerstattung übernehmen" }).click();
    await expect(gourmet).toHaveCount(0);

    // "Keine Rückerstattung": reviewed like any booking and never asked again.
    await merchant.getByRole("button", { name: "Keine Rückerstattung" }).click();
    const booking = dialog.getByRole("region", { name: "Buchung prüfen: Baumarkt Nord", exact: true });
    await booking.getByLabel("Kategorie", { exact: true }).selectOption("Einkommen");
    await booking.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const saved = await stored(page);
    expect(saved.reviewQueue ?? []).toEqual([]);
    expect(saved.transactions.find((item) => item.id === "gourmet")).toMatchObject({ category: "Rückerstattungen", sharedRefundFor: "sushi" });
    expect(saved.transactions.find((item) => item.id === "baumarkt-back")).toMatchObject({ category: "Einkommen", sharedRefundUnlinked: true });
    // The refund now lowers the restaurant it was for.
    expect(reconcileSharedHoliday(saved.transactions).bookings.find((item) => item.id === "gourmet")).toMatchObject({
      category: "Restaurants", holidayRefundFor: "sushi" });
    // Reloading rebuilds the review list: answered credits are not asked again.
    await page.reload();
    expect((await stored(page)).reviewQueue ?? []).toEqual([]);
  });
}
