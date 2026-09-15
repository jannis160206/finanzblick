import { test, expect, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { type AppState } from "../src/lib/types";

const storageKey = "finanzdashboard.v1";
async function stored(page: Page): Promise<AppState> {
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    storageKey,
  );
}
test.beforeEach(async ({ page }) => {
  const state = createSeed();
  state.financeRows.push({ id: "food", label: "Lebensmittel", kind: "variable", planCategory: "Lebensmittel", values: { "2026-08": 100 } });
  state.transactions = ["05", "06", "07", "08"].map((month) => ({
    id: `history-${month}`,
    date: `2026-${month}-03`,
    bank: "Raiffeisen",
    pocket: null,
    description: "Anderer Einkauf",
    category: "Sonstiges",
    amount: -100,
    includeInPlan: true,
  }));
  await page.clock.setFixedTime(new Date("2026-09-12T12:00:00Z"));
  await page.addInitScript(
    ({ key, state }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify(state));
    },
    { key: storageKey, state },
  );
  await page.goto("/monate");
  await stored(page);
  await page.getByRole("button", { name: "Ausnahmebearbeitung" }).click();
});

test("focus and blur leave historical amounts untouched; editing and clearing still work", async ({
  page,
}) => {
  const input = page.getByRole("textbox", {
    name: "Lebensmittel & Haushalt August 2026",
    exact: true,
  });
  const heading = page.getByRole("heading", { name: "Monate", exact: true });
  await expect(input).toHaveValue("100,00");
  await input.focus();
  await heading.click();
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "food")!
      .overrides?.["2026-08"],
  ).toBeUndefined();
  await input.focus();
  await input.press("Enter");
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "food")!
      .overrides?.["2026-08"],
  ).toBeUndefined();
  await input.fill("140");
  await input.press("Enter");
  await expect(input).toHaveValue("140,00");
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "food")!
      .overrides?.["2026-08"],
  ).toBe(140);
  await input.fill("");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "food")!
      .overrides?.["2026-08"],
  ).toBeNull();
  await input.focus();
  await heading.click();
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "food")!
      .overrides?.["2026-08"],
  ).toBeNull();
  await input.fill("2000");
  await input.press("Escape");
  await heading.click();
  await expect(input).toHaveValue("");
  await page.reload();
  await page.getByRole("button", { name: "Ausnahmebearbeitung" }).click();
  await expect(input).toHaveValue("");
});

test("an untouched focused historical cell follows storage updates without changing future budgets", async ({
  page,
}) => {
  const input = page.getByRole("textbox", {
    name: "Lebensmittel & Haushalt August 2026",
    exact: true,
  });
  await expect(input).toHaveValue("100,00");
  await input.focus();
  await page.evaluate((key) => {
    const state: AppState = JSON.parse(localStorage.getItem(key)!);
    state.financeRows.find((row) => row.id === "food")!.values["2026-08"] = 180;
    const raw = JSON.stringify(state);
    localStorage.setItem(key, raw);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: raw }));
  }, storageKey);
  await expect(input).toHaveValue("180,00");
  await page.getByRole("heading", { name: "Monate", exact: true }).click();
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "food")!
      .overrides?.["2026-08"],
  ).toBeUndefined();
  await expect(page.getByLabel("Lebensmittel & Haushalt September 2026", { exact: true })).toHaveText("250,00");
  await expect(page.getByRole("textbox", { name: "Lebensmittel & Haushalt September 2026", exact: true })).toHaveCount(0);
});
