import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState, Transaction } from "../src/lib/types";
import { normalizeAccount } from "../src/lib/accounts";
import { statementFingerprint } from "../src/lib/import/identity";

async function unlock(page: Page) {
  const privacy = page.getByRole("button", { name: /^Sicherheitsmodus (deaktivieren|aktivieren)$/ });
  await expect(privacy).toBeEnabled();
  if (await privacy.getAttribute("aria-pressed") === "true") await privacy.click();
}

const stored = (page: Page): Promise<AppState> =>
  page.evaluate(() => JSON.parse(localStorage.getItem("finanzdashboard.v1")!));

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
    { ...original, id: "other-review", description: "Ungeklärter Testladen", amount: -11 },
  ];
  state.fixedReceipts = [];
  await page.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await page.addInitScript((state) => {
    if (!localStorage.getItem("finanzdashboard.v1")) localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
  }, state);
  await page.goto("/umsaetze");
  await unlock(page);
  const status = page.getByRole("group", { name: "Zuordnungsstatus filtern" });
  await expect(status.getByRole("button", { name: "Prüfung offen 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Zuordnung ändern: ${original.description}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Zuordnung ändern", exact: true });
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Shopping");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(status.getByRole("button", { name: "Prüfung offen 2", exact: true })).toBeVisible();
  expect((await stored(page)).transactions.find((row) => row.id === original.id)?.reviewed).toBeUndefined();
  await page.getByRole("button", { name: `Zuordnung ändern: ${original.description}`, exact: true }).click();
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Shopping");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(status.getByRole("button", { name: "Prüfung offen 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Zuordnung ändern: ${original.description}`, exact: true }).click();
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Shopping");
  await dialog.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const read = () => stored(page);
  await expect.poll(async () => (await read()).transactions.find((row) => row.id === original.id)?.category).toBe("Shopping");
  const pos = page.getByRole("row").filter({ has: page.getByRole("cell", { name: original.description, exact: true }) });
  await expect(pos.getByText("Geprüft", { exact: true })).toBeVisible();
  await expect(status.getByRole("button", { name: "Prüfung offen 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Zuordnung prüfen", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
  await expect(review.getByRole("region", { name: `Buchung prüfen: ${original.description}`, exact: true })).toHaveCount(0);
  await expect(review.getByRole("region", { name: "Buchung prüfen: Ungeklärter Testladen", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await unlock(page);
  await expect(pos).toContainText("Shopping");
  await expect(pos.getByText("Geprüft", { exact: true })).toBeVisible();
  expect((await read()).transactions.find((row) => row.id === original.id)).toMatchObject({
    ...normalizeAccount(original), category: "Shopping", categoryOverride: true, includeInPlan: true, reviewed: true,
  });
  expect((await read()).reviewQueue).toHaveLength(1);
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles({
    name: "Geprueft-Raiffeisen.csv", mimeType: "text/csv",
    buffer: Buffer.from(`Raiffeisen\nBuchungsdatum;Verwendungszweck/Text;Valuta;Betrag\n10.09.2026;${original.description};10.09.2026;-3,50`),
  });
  await expect(page.getByText("0 neu, 1 Duplikate ignoriert", { exact: true })).toBeVisible();
  await expect(pos.getByText("Geprüft", { exact: true })).toBeVisible();
  expect((await read()).transactions).toHaveLength(state.transactions.length);
  expect((await read()).reviewQueue).toHaveLength(1);
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
  expect((await read()).transactions.find((row) => row.id === "protected-lunch")?.reviewed).toBeUndefined();
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await page.getByRole("button", { name: `Zuordnung ändern: ${original.description}`, exact: true }).click();
  await dialog.getByLabel("Kategorie", { exact: true }).selectOption("Prüfen");
  await dialog.getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
  await expect(pos.getByText("Prüfung offen", { exact: true })).toBeVisible();
  await expect(status.getByRole("button", { name: "Prüfung offen 2", exact: true })).toBeVisible();
  await expect.poll(async () => (await read()).transactions.find((row) => row.id === original.id)?.reviewed).toBe(false);
});

test("pencil save acknowledges receipt-only fixed-cost review without changing the monthly plan", async ({ page }) => {
  const state = createSeed();
  state.settings.asOf = "2026-09-17";
  state.settings.baselineDate = "2026-09-01";
  const original: Transaction = {
    id: "receipt-original", date: "2026-09-10", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
    description: "Porsche Bank Leasing", amount: -45, category: "Leasing", includeInPlan: false,
  };
  const key = statementFingerprint(original);
  state.transactions = [];
  state.financeRows = [{ id: "leasing", label: "Leasing", kind: "fixed", planCategory: "Leasing", values: { "2026-09": 40, "2026-10": 40 } }];
  state.fixedReceipts = [{ key, booking: original, category: "Leasing", date: original.date, amount: original.amount, rowId: "leasing" }];
  state.reviewQueue = [{ kind: "fixed", id: "price-change", change: {
    id: "price-change", category: "Leasing", month: "2026-09", previous: 40, amount: 45, rowId: "leasing", bookings: [original],
  } }];
  await page.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await page.addInitScript((state) => {
    if (!localStorage.getItem("finanzdashboard.v1")) localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
  }, state);
  await page.goto("/umsaetze");
  await unlock(page);
  const status = page.getByRole("group", { name: "Zuordnungsstatus filtern" });
  await expect(status.getByRole("button", { name: "Prüfung offen 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Zuordnung ändern: ${original.description}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Zuordnung übernehmen", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Buchungen" }).getByText("Geprüft", { exact: true })).toBeVisible();
  await expect(status.getByRole("button", { name: "Prüfung offen 0", exact: true })).toBeVisible();
  await expect.poll(async () => (await stored(page)).fixedReceipts?.[0].booking?.reviewed).toBe(true);
  const saved = await stored(page);
  expect(saved.reviewQueue).toEqual([]);
  expect(saved.transactions).toEqual([]);
  expect(saved.fixedReceipts?.[0].booking).toMatchObject({ ...original, reviewed: true });
  expect(saved.financeRows.find((row) => row.id === "leasing")).toEqual(state.financeRows[0]);
  await page.reload();
  await unlock(page);
  await expect(status.getByRole("button", { name: "Prüfung offen 0", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Zuordnung prüfen", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Alle Umsätze sind zugeordnet", { exact: true })).toBeVisible();
});
