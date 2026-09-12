import { test, expect } from "@playwright/test";
import { type AppState } from "../src/lib/types";

test("reload repairs legacy miscellaneous inflation without resetting bookings or overrides", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-09-12T12:00:00Z"));
  await page.goto("/");
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  const reference: AppState = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("finanzdashboard.v1")!),
  );
  expect(
    reference.transactions.some(
      (row) => row.sourceCategory === "AMEX Abrechnung (Sammel)",
    ),
  ).toBe(true);
  const legacy: AppState = {
    ...reference,
    transactions: reference.transactions.map((row) => ({
      ...row,
      sourceCategory: undefined,
      category:
        row.category === "Spotify" ||
        row.category === "AMEX Monatsgebühr" ||
        row.sourceCategory === "AMEX Abrechnung (Sammel)"
          ? "Sonstiges"
          : row.category,
    })),
    financeRows: reference.financeRows.map((row) =>
      row.id === "auto-Sonstiges"
        ? {
            ...row,
            values: { ...row.values, "2026-09": 2000.89 },
            overrides: { ...row.overrides, "2026-10": 123 },
          }
        : row,
    ),
  };
  await page.addInitScript((state) => {
    if (sessionStorage.getItem("legacy-plan-test")) return;
    localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
    sessionStorage.setItem("legacy-plan-test", "done");
  }, legacy);
  await page.reload();
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  const repaired: AppState = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("finanzdashboard.v1")!),
  );
  const miscellaneous = repaired.financeRows.find(
    (row) => row.id === "auto-Sonstiges",
  )!;
  expect(miscellaneous.values["2026-09"]).toBe(71.06);
  expect(miscellaneous.values["2026-10"]).toBe(123);
  expect(miscellaneous.overrides?.["2026-10"]).toBe(123);
  expect(repaired.transactions.map((row) => [row.id, row.amount])).toEqual(
    reference.transactions.map((row) => [row.id, row.amount]),
  );
  expect(
    repaired.transactions.filter(
      (row) => row.sourceCategory === "AMEX Abrechnung (Sammel)",
    ).length,
  ).toBeGreaterThan(0);
  const surplus = page
    .locator("section")
    .filter({ has: page.getByText("Überschuss · Plan", { exact: true }) });
  await expect(surplus).toContainText("1.233,32");
  await page.reload();
  await expect(surplus).toContainText("1.233,32");
});
