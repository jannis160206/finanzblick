import { expect, test } from "@playwright/test";

test.skip(process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1", "Requires explicitly configured local admin acceptance.");

test("local administrator logs in, keeps the account on reload and logs out", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Willkommen zurück" })).toBeVisible();
  await page.getByLabel("Benutzername", { exact: true }).fill("admin");
  await page.getByLabel("Passwort", { exact: true }).fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeVisible();
  const session = await (await page.request.get("/api/auth/session")).json();
  expect(session.user).toMatchObject({ username: "admin", role: "admin" });
  await page.reload();
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeVisible();
  expect((await (await page.request.get("/api/auth/session")).json()).user.id).toBe(session.user.id);
  await page.getByRole("button", { name: "Abmelden", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});
