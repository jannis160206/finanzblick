import { test, expect } from "@playwright/test";
import { type AppState } from "../src/lib/types";

test("reload removes legacy miscellaneous budgets without resetting bank facts or fixed rows", async ({
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
  expect(reference.financeRows.find(
    (row) => row.id === "auto-Sonstiges",
  )).toBeUndefined();
  const surplus = page
    .locator("section")
    .filter({ has: page.getByText("Überschuss · Plan", { exact: true }) });
  await expect(surplus).toBeVisible();
  const expectedSurplus = await surplus.innerText();
  const legacy: AppState = {
    ...reference,
    transactions: reference.transactions.map((row) => ({
      ...row,
      sourceCategory: undefined,
      category:
        row.category === "Abonnements" ||
        row.category === "Bankgebühren" ||
        row.sourceCategory === "AMEX Abrechnung (Sammel)"
          ? "Sonstiges"
          : row.category,
    })),
    financeRows: [...reference.financeRows, {
      id: "auto-Sonstiges", label: "Sonstiges", kind: "variable", planCategory: "Sonstiges",
      values: { "2026-09": 2000.89, "2026-10": 123 }, overrides: { "2026-10": 123 },
    }],
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
  );
  expect(miscellaneous).toBeUndefined();
  expect(repaired.financeRows.filter((row) => row.kind === "variable")).toHaveLength(7);
  expect(repaired.financeRows.filter((row) => row.kind !== "variable")).toEqual(reference.financeRows.filter((row) => row.kind !== "variable"));
  expect(repaired.transactions.map((row) => [row.id, row.amount])).toEqual(
    reference.transactions.map((row) => [row.id, row.amount]),
  );
  expect(
    repaired.transactions.filter(
      (row) => row.sourceCategory === "AMEX Abrechnung (Sammel)",
    ).length,
  ).toBeGreaterThan(0);
  await expect(surplus).toHaveText(expectedSurplus, { useInnerText: true });
  await page.reload();
  await expect(surplus).toHaveText(expectedSurplus, { useInnerText: true });
});
