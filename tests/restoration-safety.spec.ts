import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import type { AppState } from "@/lib/types";

type Snapshot = { state: AppState; stored: string | null; successes: string[] };
type RecoveryFixture = {
  snapshot: () => Snapshot;
  backup: () => string;
  edit: () => void;
  failWrites: () => void;
};

declare global {
  interface Window {
    financeRecovery: RecoveryFixture;
  }
}

let bundle: string;
const browserErrors = new WeakMap<Page, string[]>();
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, { StrictMode, useEffect } from "react";
        import { createRoot } from "react-dom/client";
        import { FinanceProvider, useFinance } from "@/components/finance-provider";
        import { ExcelActions } from "@/components/excel-actions";
        import { createEmptyAccountState } from "@/lib/account-state";
        import { FINANCE_STORAGE_KEY } from "@/lib/finance-storage";
        import { serializeFinanceBackup } from "@/lib/finance-backup";
        const initial = createEmptyAccountState();
        const replacement = createEmptyAccountState();
        replacement.transactions = [{
          id: "synthetic-restored", date: "2026-10-01", bank: "Testbank", pocket: null,
          description: "Synthetischer Einkauf", amount: -12.34, category: "Shopping",
          includeInPlan: false, reviewed: true
        }];
        window.successes = [];
        let failWrites = false;
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (failWrites && key === FINANCE_STORAGE_KEY)
            throw new DOMException("synthetic quota", "QuotaExceededError");
          write.call(this, key, value);
        };
        function Observer() {
          const finance = useFinance();
          useEffect(() => {
            window.financeRecovery = {
              snapshot: () => ({
                state: structuredClone(finance.state),
                stored: localStorage.getItem(FINANCE_STORAGE_KEY),
                successes: [...window.successes]
              }),
              backup: () => serializeFinanceBackup(replacement),
              edit: () => finance.update((state) => ({
                ...state, settings: { ...state.settings, emergencyTarget: 987 }
              })),
              failWrites: () => { failWrites = true; }
            };
          }, [finance]);
          return <><output aria-label="Speicherstatus">{finance.saved ? "Gespeichert" : "Offen"}</output><ExcelActions compact /></>;
        }
        createRoot(document.getElementById("root")).render(
          <StrictMode><FinanceProvider initialState={initial}><Observer /></FinanceProvider></StrictMode>
        );
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [{
      name: "isolated-restoration-notifications",
      setup(builder) {
        builder.onResolve({ filter: /^sonner$/ }, () => ({ path: "toast", namespace: "fixture" }));
        builder.onResolve({ filter: /^@\/components\/security-mode-provider$/ }, () => ({ path: "security", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          loader: "js",
          contents: path === "security"
            ? `export const useSecurityMode = () => ({ locked: false });`
            : `export const Toaster = () => null; export const toast = { success: (message) => window.successes.push(message), error: () => {} };`,
        }));
      },
    }],
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  await page.route("https://finanzblick-test.invalid/", (route) => route.fulfill({
    contentType: "text/html",
    body: "<html><body><div id='root'></div></body></html>",
  }));
  await page.goto("https://finanzblick-test.invalid/");
  await page.addScriptTag({ content: bundle });
  await expect(page.getByLabel("Speicherstatus")).toHaveText("Gespeichert");
});
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => window.financeRecovery.snapshot());
}

async function upload(page: Page, raw?: string) {
  const contents = raw ?? await page.evaluate(() => window.financeRecovery.backup());
  await page.getByLabel("Sicherungsdatei auswählen").setInputFiles({
    name: "synthetic-backup.json", mimeType: "application/json", buffer: Buffer.from(contents),
  });
}

test("JSON preview requires confirmation; cancel, Escape and close preserve the stored state", async ({ page }) => {
  const original = await snapshot(page);
  const dialog = page.getByRole("dialog", { name: "Sicherung wiederherstellen", exact: true });
  for (const action of ["Abbrechen", "escape", "Schließen"]) {
    await upload(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Finanzblick JSON");
    expect(await snapshot(page)).toEqual(original);
    if (action === "escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Wiederherstellen", exact: true })).toBeFocused();
    expect(await snapshot(page)).toEqual(original);
  }
  await upload(page);
  await dialog.getByRole("button", { name: "Sicherung wiederherstellen und aktuelle Daten ersetzen" }).click();
  await expect(dialog).not.toBeVisible();
  const restored = await snapshot(page);
  expect(restored.state.transactions[0].id).toBe("synthetic-restored");
  expect(JSON.parse(restored.stored ?? "{}").transactions).toEqual(restored.state.transactions);
  expect(restored.successes).toEqual(["Sicherung wiederhergestellt und gespeichert"]);
});

test("stale preview requires another explicit review and quota failure never reports saved success", async ({ page }) => {
  await upload(page);
  const dialog = page.getByRole("dialog", { name: "Sicherung wiederherstellen", exact: true });
  await page.evaluate(() => window.financeRecovery.edit());
  await expect(page.getByLabel("Speicherstatus")).toHaveText("Gespeichert");
  const current = await snapshot(page);
  const confirm = dialog.getByRole("button", { name: "Sicherung wiederherstellen und aktuelle Daten ersetzen" });
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("erneut prüfen");
  expect(current.state.settings.emergencyTarget).toBe(987);
  await dialog.getByRole("button", { name: "Vorschau auf aktuellen Stand beziehen" }).click();
  await page.evaluate(() => window.financeRecovery.failWrites());
  await confirm.click();
  await expect(dialog.getByRole("alert").filter({ hasText: "Browserspeicher" })).toBeVisible();
  const failed = await snapshot(page);
  expect(failed.stored).toBe(current.stored);
  expect(failed.successes).toEqual([]);
  await expect(page.getByLabel("Speicherstatus")).toHaveText("Offen");
});

test("invalid and foreign-account backups do not change local financial data", async ({ page }) => {
  const original = await snapshot(page);
  await upload(page, "{not JSON");
  await expect(page.getByRole("alert")).toContainText("unlesbar");
  expect(await snapshot(page)).toEqual(original);
  const foreign = JSON.parse(await page.evaluate(() => window.financeRecovery.backup()));
  foreign.accountId = "another-synthetic-account";
  await upload(page, JSON.stringify(foreign));
  await expect(page.getByRole("alert")).toContainText("anderen Konto");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await snapshot(page)).toEqual(original);
});
