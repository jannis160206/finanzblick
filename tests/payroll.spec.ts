import { expect, test } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState, Transaction } from "../src/lib/types";

test("payroll restores without recurring-amount prompts and reimports without duplicates", async ({ page }) => {
  const key = "finanzdashboard.v1";
  const state = createSeed();
  const salary = { id: "salary", label: "Nettogehalt", kind: "income" as const, values: {
    "2026-01": 2442.56, "2026-02": 2442.56, "2026-03": 3475.38, "2026-04": 2442.56, "2026-12": 4000,
  } };
  state.financeRows = [salary, { id: "on-call", label: "Rufbereitschaft", kind: "income", values: { "2026-01": 250 } }];
  const bookings: Transaction[] = [
    ["2026-01-12", 548.16, "12/2025"], ["2026-01-29", 2450.29, "1/2026"],
    ["2026-02-25", 3475.38, "2/2026"], ["2026-03-30", 2450.29, "3/2026"],
  ].map(([date, amount, period], index) => ({ id: `payroll-${index}`, date: String(date), amount: Number(amount),
    bank: "Raiffeisen", pocket: "Raiffeisen Giro", description: `TTS TeamTalentSolutions GmbH – Gehalt ${period}`,
    category: "Gehalt", includeInPlan: false,
  }));
  state.reviewQueue = bookings.map((booking) => ({ kind: "fixed", id: booking.id, change: {
    id: booking.id, category: "Gehalt", month: booking.date.slice(0, 7), previous: 2442.56,
    amount: booking.amount, bookings: [booking], rowId: salary.id,
  } }));
  await page.clock.setFixedTime(new Date("2026-09-14T12:00:00Z"));
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  const saved = (): Promise<AppState> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
  await page.goto("/umsaetze");
  await expect.poll(async () => (await saved()).reviewQueue).toEqual([]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await saved()).transactions).toHaveLength(4);
  expect((await saved()).transactions.find((row) => row.id === "payroll-0")?.category).toBe("Rufbereitschaft");
  expect((await saved()).financeRows.find((row) => row.id === salary.id)).toEqual(salary);
  const csv = "Raiffeisen\nBuchungsdatum;Buchungstext;Valuta;Betrag\n" + bookings.map((row) => {
    const date = row.date.split("-").reverse().join(".");
    return `${date};${row.description};${date};${row.amount.toFixed(2).replace(".", ",")}`;
  }).join("\n");
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles({ name: "payroll.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByText("0 neu, 4 Duplikate ignoriert", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible();
  expect((await saved()).transactions).toHaveLength(4);
  expect((await saved()).reviewQueue).toEqual([]);
  expect((await saved()).financeRows.find((row) => row.id === salary.id)).toEqual(salary);
});
