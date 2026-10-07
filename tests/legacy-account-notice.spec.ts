import { expect, test, type Page } from "@playwright/test";
import { createEmptyAccountState } from "../src/lib/account-state";
import { accountUserSchema, financeSnapshotSchema } from "../src/lib/account-schema";
import { FINANCE_BACKUP_KEY, FINANCE_STORAGE_KEY } from "../src/lib/finance-storage";
import { legacyNoticeKey } from "../src/lib/legacy-account-notice";

test.skip(process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1", "Requires an isolated account-mode test database.");

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Benutzername", { exact: true }).fill("admin");
  await page.getByLabel("Passwort", { exact: true }).fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
  await unlock(page);
}
async function unlock(page: Page) {
  const privacy = page.getByRole("button", { name: /^Sicherheitsmodus (aktivieren|deaktivieren)$/ });
  await expect(privacy).toBeEnabled();
  if (await privacy.getAttribute("aria-pressed") === "true") await privacy.click();
}
async function snapshot(page: Page) {
  const user = accountUserSchema.parse((await (await page.request.get("/api/auth/session")).json()).user);
  const response = await page.request.get("/api/finance", { headers: { "X-Finanzblick-Account": user.id } });
  expect(response.status()).toBe(200);
  const data = financeSnapshotSchema.parse(await response.json());
  if (!data.state) throw new Error("Expected initialized account data.");
  return { user, state: data.state, revision: data.revision };
}
async function prepare(page: Page) {
  await page.clock.setFixedTime(new Date("2026-10-07T10:00:00Z"));
  const legacy = createEmptyAccountState();
  legacy.settings.asOf = "2026-10-07";
  legacy.holidayRanges = [{ from: "2026-10-20", to: "2026-10-22" }];
  const original = JSON.stringify(legacy);
  await page.addInitScript(({ original, keys }) => {
    for (const key of keys) if (localStorage.getItem(key) === null) localStorage.setItem(key, original);
  }, { original, keys: [FINANCE_STORAGE_KEY, FINANCE_BACKUP_KEY] });
  await signIn(page);
  await expect(page.getByRole("button", { name: "Bisherige Browserdaten übernehmen", exact: true })).toBeVisible();
  const before = await snapshot(page);
  expect(before.state.holidayRanges).not.toEqual(legacy.holidayRanges);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), legacyNoticeKey(before.user.id))).toBe("seen");
  return { before, legacy, original };
}
async function preserved(page: Page, original: string) {
  expect(await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)),
    [FINANCE_STORAGE_KEY, FINANCE_BACKUP_KEY])).toEqual([original, original]);
}

test("legacy notice appears once across reloads and sign-in without automatically importing or deleting data", async ({ page }) => {
  const { before, original } = await prepare(page);
  for (let reload = 0; reload < 3; reload++) {
    await page.reload();
    await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
    await unlock(page);
    await expect(page.getByRole("region", { name: "Kontodaten übertragen" })).toHaveCount(0);
    expect((await snapshot(page)).state).toEqual(before.state);
    await preserved(page, original);
  }
  await page.getByRole("button", { name: "Abmelden", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page);
  await expect(page.getByRole("region", { name: "Kontodaten übertragen" })).toHaveCount(0);
  expect((await snapshot(page)).state).toEqual(before.state);
  await preserved(page, original);
});

test("an administrator can still explicitly import preserved browser data later in settings", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { legacy, original } = await prepare(page);
  await page.reload();
  await unlock(page);
  await expect(page.getByRole("region", { name: "Kontodaten übertragen" })).toHaveCount(0);
  await page.goto("/einstellungen#sicherung");
  await unlock(page);
  const backups = page.locator("#sicherung");
  await backups.locator("summary", { hasText: "Bisherige Browserdaten" }).click();
  await backups.getByRole("button", { name: "Bisherige Browserdaten übernehmen", exact: true }).click();
  expect((await snapshot(page)).state.holidayRanges).not.toEqual(legacy.holidayRanges);
  await backups.getByRole("button", { name: "Übernahme bestätigen", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).state.holidayRanges).toEqual(legacy.holidayRanges);
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeAttached();
  await preserved(page, original);
  await page.goto("/");
  await unlock(page);
  await page.reload();
  await unlock(page);
  await expect(page.getByRole("region", { name: "Kontodaten übertragen" })).toHaveCount(0);
  expect((await snapshot(page)).state.holidayRanges).toEqual(legacy.holidayRanges);
  await preserved(page, original);
});
