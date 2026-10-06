import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createEmptyAccountState } from "../src/lib/account-state";

test.skip(process.env.FINANZBLICK_AUTH !== "true", "Requires a private account-mode test database.");

test("configured administrator signs in on the page without HTTP Basic authentication", async ({ page, baseURL }) => {
  await page.goto("/login");
  await page.getByLabel("Benutzername", { exact: true }).fill("admin");
  await page.getByLabel("Passwort", { exact: true }).fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeVisible();
  const user = (await (await page.request.get("/api/auth/session")).json()).user;
  expect(user.username).toBe("admin");
  expect(user.role).toBe("admin");
});

test("site registration, mobile login, user isolation, revision conflicts and logout", async ({ page, browser, baseURL }) => {
  const username = `check_${randomUUID().slice(0, 8)}`;
  const password = randomUUID();
  const origin = baseURL!;
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Willkommen zurück" })).toBeVisible();
  await page.goto("/register");
  await page.getByLabel("Benutzername", { exact: true }).fill(username);
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByLabel("Passwort bestätigen", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Konto erstellen", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.getByText("Synchronisiert", { exact: true })).toBeVisible();
  const session = await (await page.request.get("/api/auth/session")).json();
  const headers = { Origin: origin, "X-Finanzblick-Account": session.user.id };
  const snapshot = await (await page.request.get("/api/finance", { headers })).json();
  const state = createEmptyAccountState();
  state.holidayRanges = [{ from: "2026-10-20", to: "2026-10-22" }];
  expect((await page.request.put("/api/finance", { headers, data: { state, revision: snapshot.revision } })).status()).toBe(200);
  expect((await page.request.put("/api/finance", { headers, data: { state, revision: snapshot.revision } })).status()).toBe(409);

  const mobile = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    const phone = await mobile.newPage();
    await phone.goto("/login");
    await phone.getByLabel("Benutzername", { exact: true }).fill(username);
    await phone.getByLabel("Passwort", { exact: true }).fill(password);
    await phone.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(phone).toHaveURL(`${origin}/`);
    await expect(phone.getByText("Synchronisiert", { exact: true })).toBeAttached();
    const phoneState = await (await mobile.request.get("/api/finance", { headers })).json();
    expect(phoneState.state.holidayRanges).toEqual(state.holidayRanges);
    await phone.getByRole("button", { name: "Abmelden", exact: true }).click();
    await expect(phone).toHaveURL(/\/login$/);
    expect((await mobile.request.get("/api/finance", { headers })).status()).toBe(401);
    const second = await mobile.request.post("/api/auth/register", {
      headers: { Origin: origin }, data: { username: `${username}_2`, password },
    });
    expect(second.status()).toBe(201);
    const other = (await second.json()).user;
    expect((await mobile.request.get("/api/finance", { headers })).status()).toBe(401);
    const otherState = await (await mobile.request.get("/api/finance", {
      headers: { "X-Finanzblick-Account": other.id },
    })).json();
    expect(otherState.state).toBeNull();
    expect((await page.request.get("/api/finance", { headers })).status()).toBe(200);
  } finally {
    await mobile.close();
  }
});
