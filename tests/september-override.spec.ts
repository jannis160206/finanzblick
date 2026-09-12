import { test, expect, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { type AppState } from "../src/lib/types";

const key = "finanzdashboard.v1";
async function stored(page: Page): Promise<AppState> {
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}

test("the confirmed stale September override repairs itself on load exactly once", async ({
  page,
}) => {
  const state = createSeed();
  state.settings.asOf = "2026-09-12";
  state.transactions = ["05", "06", "07", "08"].map((month) => ({
    id: month,
    date: `2026-${month}-03`,
    bank: "Raiffeisen",
    pocket: null,
    description: "Anderer Einkauf",
    category: "Sonstiges",
    amount: -71.06,
    includeInPlan: true,
  }));
  state.financeRows = [
    {
      id: "income",
      kind: "income",
      label: "Gehalt",
      values: { "2026-09": 2818.26 },
    },
    {
      id: "fixed",
      kind: "fixed",
      label: "Fixkosten",
      values: { "2026-09": 596.16 },
    },
    {
      id: "other",
      kind: "variable",
      label: "Weitere variable Ausgaben",
      values: { "2026-09": 961.37 },
    },
    {
      id: "auto-Sonstiges",
      kind: "variable",
      label: "Sonstiges",
      planCategory: "Sonstiges",
      values: { "2026-09": 2027.75 },
      overrides: { "2026-09": 2027.75, "2026-10": 123 },
    },
  ];
  await page.clock.setFixedTime(new Date("2026-09-12T12:00:00Z"));
  await page.addInitScript(
    ({ key, state }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify(state));
    },
    { key, state },
  );
  await page.goto("/");
  const surplus = page
    .locator("section")
    .filter({ has: page.getByText("Überschuss · Plan", { exact: true }) });
  await expect(surplus).toContainText("1.189,67");
  const saved = await stored(page);
  const repaired = saved.financeRows.find(
    (row) => row.id === "auto-Sonstiges",
  )!;
  expect(repaired.values["2026-09"]).toBe(71.06);
  expect(repaired.overrides?.["2026-09"]).toBeNull();
  expect(repaired.overrides?.["2026-10"]).toBe(123);
  expect(saved.transactions).toEqual(state.transactions);
  await page.reload();
  await expect(surplus).toContainText("1.189,67");
  await page.goto("/monate");
  await page.getByRole("button", { name: "Ausnahmebearbeitung" }).click();
  const cell = page.getByRole("textbox", {
    name: "Sonstiges September 2026",
    exact: true,
  });
  await expect(cell).toHaveValue("71,06");
  await cell.fill("2027,75");
  await cell.press("Enter");
  await stored(page);
  await page.reload();
  await page.getByRole("button", { name: "Ausnahmebearbeitung" }).click();
  await expect(cell).toHaveValue("2.027,75");
});
