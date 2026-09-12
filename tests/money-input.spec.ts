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
});

test("focus and blur never turn an automatic amount into an override; editing and clearing still work", async ({
  page,
}) => {
  const input = page.getByRole("textbox", {
    name: "Sonstiges September 2026",
    exact: true,
  });
  const heading = page.getByRole("heading", { name: "Monate", exact: true });
  await expect(input).toHaveValue("100,00");
  await input.focus();
  await heading.click();
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "auto-Sonstiges")!
      .overrides?.["2026-09"],
  ).toBeUndefined();
  await input.focus();
  await input.press("Enter");
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "auto-Sonstiges")!
      .overrides?.["2026-09"],
  ).toBeUndefined();
  await input.fill("140");
  await input.press("Enter");
  await expect(input).toHaveValue("140,00");
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "auto-Sonstiges")!
      .overrides?.["2026-09"],
  ).toBe(140);
  await input.fill("");
  await input.press("Enter");
  await expect(input).toHaveValue("100,00");
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "auto-Sonstiges")!
      .overrides?.["2026-09"],
  ).toBeNull();
  await input.focus();
  await heading.click();
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "auto-Sonstiges")!
      .overrides?.["2026-09"],
  ).toBeNull();
  await input.fill("2000");
  await input.press("Escape");
  await heading.click();
  await expect(input).toHaveValue("100,00");
  await page.reload();
  await expect(input).toHaveValue("100,00");
});

test("an untouched focused cell follows a recalculated plan instead of freezing the old value", async ({
  page,
}) => {
  const input = page.getByRole("textbox", {
    name: "Sonstiges September 2026",
    exact: true,
  });
  await expect(input).toHaveValue("100,00");
  await input.focus();
  await page.evaluate((key) => {
    const state: AppState = JSON.parse(localStorage.getItem(key)!);
    state.transactions.push({
      id: "september-import",
      date: "2026-09-03",
      bank: "Raiffeisen",
      pocket: null,
      description: "Anderer Einkauf",
      category: "Sonstiges",
      amount: -200,
      includeInPlan: true,
    });
    const raw = JSON.stringify(state);
    localStorage.setItem(key, raw);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: raw }));
  }, storageKey);
  await expect(input).toHaveValue("180,00");
  await page.getByRole("heading", { name: "Monate", exact: true }).click();
  expect(
    (await stored(page)).financeRows.find((row) => row.id === "auto-Sonstiges")!
      .overrides?.["2026-09"],
  ).toBeUndefined();
});
