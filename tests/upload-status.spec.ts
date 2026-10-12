import { expect, test, type Page } from "@playwright/test";
import { createEmptyAccountState } from "../src/lib/account-state";
import { SECURITY_MODE_KEY, SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";

async function open(page: Page) {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.settings.baselineDate = "2026-10-01";
  await page.clock.setFixedTime(new Date("2026-10-07T12:00:00Z"));
  await page.addInitScript(({ state, lock, activation }) => {
    localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
    localStorage.setItem(lock, "false");
    localStorage.setItem(activation, "manual");
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (this.name === "status-fixture.csv") await new Promise<void>((resolve) =>
        document.addEventListener("release-import", () => resolve(), { once: true }));
      return read.call(this);
    };
  }, { state, lock: SECURITY_MODE_KEY, activation: SECURITY_ACTIVATION_KEY });
  await page.goto("/umsaetze");
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeAttached();
  await expect(page.getByRole("button", { name: "Dateien auswählen" })).toBeEnabled();
}

for (const width of [1440, 390]) {
  test(`clean ledger and keyboard-accessible upload activity at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const clock = page.getByRole("button", { name: "Uploadstatus", exact: true });
    const chooser = page.getByRole("button", { name: "Dateien auswählen", exact: true });
    await expect(page.getByRole("group", { name: "Zuordnungsstatus filtern" })).toHaveCount(0);
    await expect(page.getByLabel("Importstatus")).toHaveCount(0);
    const clockBox = (await clock.boundingBox())!, chooserBox = (await chooser.boundingBox())!;
    expect(clockBox.x + clockBox.width).toBeLessThan(chooserBox.x);
    expect(Math.abs(clockBox.y - chooserBox.y)).toBeLessThan(2);
    await clock.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Uploadstatus", exact: true });
    await expect(dialog.getByText("Noch keine Uploads")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(clock).toBeFocused();
    await page.getByLabel("Kontoauszüge auswählen").setInputFiles([10, 20].map((amount) => ({
      name: "status-fixture.csv", mimeType: "text/csv",
      buffer: Buffer.from(`Revolut\nHauptkonto (EUR)\nDatum,Beschreibung,Betrag\n0${amount / 10}.10.2026,SPAR,-${amount}`),
    })));
    await expect(clock.locator("[data-upload-badge]")).toHaveText("2");
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await clock.click();
    await expect(dialog.getByRole("article")).toHaveCount(2);
    await expect(dialog.getByText("Datei wird geprüft", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Wartet auf Übertragung", { exact: true })).toBeVisible();
    for (const bar of await dialog.getByRole("progressbar").all())
      await expect(bar).not.toHaveAttribute("aria-valuenow");
    await page.screenshot({ path: testInfo.outputPath("upload-active.png") });
    await page.evaluate(() => document.dispatchEvent(new Event("release-import")));
    await expect(dialog.getByText("Buchungen werden gespeichert", { exact: true })).toBeVisible();
    await page.evaluate(() => document.dispatchEvent(new Event("release-import")));
    await expect(dialog.getByText("Abgeschlossen", { exact: true })).toHaveCount(2);
    await expect(clock.locator("[data-upload-badge]")).toHaveCount(0);
    await expect(dialog.getByLabel("Importstatus")).toContainText("Übernommen");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(page.getByLabel("Importstatus")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("finanzdashboard.v1")!));
    expect(persisted.transactions).toHaveLength(2);
    expect(persisted.transactions.reduce((sum: number, row: { amount: number }) => sum + row.amount, 0)).toBe(-30);
    await page.screenshot({ path: testInfo.outputPath("upload-clean-ledger.png") });
    expect(errors).toEqual([]);
  });
}

test("failed local imports retain an exclamation and private details in the panel only", async ({ page }) => {
  await open(page);
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles({
    name: "beschädigt.csv", mimeType: "text/csv", buffer: Buffer.from("not a statement"),
  });
  const clock = page.getByRole("button", { name: "Uploadstatus", exact: true });
  await expect(clock.locator("[data-upload-badge]")).toHaveText("!");
  await expect(page.getByRole("article", { name: "Verarbeitung: beschädigt.csv" })).toHaveCount(0);
  await clock.click();
  const dialog = page.getByRole("dialog", { name: "Uploadstatus", exact: true });
  await expect(dialog.getByRole("article", { name: "Verarbeitung: beschädigt.csv" })).toBeVisible();
  await expect(dialog.getByText("Import fehlgeschlagen", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Importhinweise", exact: true }).click();
  await expect(dialog.getByRole("list", { name: "Importhinweise" })).toBeVisible();
  await page.keyboard.press("Escape");
  await clock.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Sicherheitsmodus aktivieren"]')!.click());
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Verarbeitung: beschädigt.csv" })).toHaveCount(0);
});
