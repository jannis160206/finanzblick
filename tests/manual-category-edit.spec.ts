import { expect, test } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState, Transaction } from "../src/lib/types";
import { normalizeAccount } from "../src/lib/accounts";

test("manual POS assignment saves, reloads and inferred fixed expenses show a flag", async ({ page }) => {
  const state = createSeed();
  state.settings.asOf = "2026-09-17";
  state.settings.baselineDate = "2026-09-01";
  const original: Transaction = {
    id: "manual-pos", date: "2026-09-10", bank: "Raiffeisen", pocket: "Hauptkonto",
    description: "POS 3,50 AT D1 09.09. 11:53 Kartenfolge-Nr.: 1",
    amount: -3.5, category: "Prüfen", includeInPlan: false,
  };
  state.transactions = [
    original,
    { ...original, id: "legacy-fixed", description: "A1 Telekom", amount: -24, category: "Telefon & Internet" },
    { ...original, id: "manual-ordinary", description: "Einmaliger Anschluss", amount: -15, category: "Telefon & Internet", categoryOverride: true, fixedCost: false, includeInPlan: true },
    { ...original, id: "protected-lunch", description: "BIPA", amount: -5, category: "Mittagessen", includeInPlan: true },
  ];
  state.fixedReceipts = [];
  await page.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await page.addInitScript((state) => {
    if (!localStorage.getItem("finanzdashboard.v1")) localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
  }, state);
  await page.goto("/umsaetze");
  await page.getByRole("button", { name: `Zuordnung ändern: ${original.description}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Zuordnung ändern", exact: true });
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Shopping");
  await dialog.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const read = () => page.evaluate(() => JSON.parse(localStorage.getItem("finanzdashboard.v1")!) as AppState);
  await expect.poll(async () => (await read()).transactions.find((row) => row.id === original.id)?.category).toBe("Shopping");
  await page.reload();
  const privacy = page.getByRole("button", { name: /^Sicherheitsmodus (deaktivieren|aktivieren)$/ });
  await expect(privacy).toBeEnabled();
  if (await privacy.getAttribute("aria-pressed") === "true") await privacy.click();
  const pos = page.getByRole("row").filter({ has: page.getByRole("cell", { name: original.description, exact: true }) });
  await expect(pos).toContainText("Shopping");
  expect((await read()).transactions.find((row) => row.id === original.id)).toMatchObject({
    ...normalizeAccount(original), category: "Shopping", categoryOverride: true, includeInPlan: true,
  });
  const fixed = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "A1 Telekom", exact: true }) });
  await expect(fixed.getByText("Fixkosten", { exact: true })).toBeVisible();
  const ordinary = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Einmaliger Anschluss", exact: true }) });
  await expect(ordinary.getByText("Fixkosten", { exact: true })).toHaveCount(0);
  await fixed.getByRole("button", { name: "Zuordnung ändern: A1 Telekom", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Als Fixkosten markieren" })).toBeChecked();
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await page.getByRole("button", { name: "Zuordnung ändern: BIPA", exact: true }).click();
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Shopping");
  await dialog.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("feste Zuordnung „Mittagessen“");
  expect((await read()).transactions.find((row) => row.id === "protected-lunch")?.category).toBe("Mittagessen");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
});
