import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";

// Läuft ausschließlich mit synthetischen Daten (createSeed, per localStorage eingespielt).
const storageKey = "finanzdashboard.v1";
const blocking = new Set(["critical", "serious"]);
const viewports = [
  { width: 375, height: 812, presentation: "sheet" },
  { width: 768, height: 1024, presentation: "modal" },
  { width: 1440, height: 1000, presentation: "modal" },
] as const;

function syntheticState() {
  const state = createSeed();
  const months = ["05", "06", "07", "08", "09"];
  state.transactions = [
    ...months.map((month, index) => ({
      id: `stream-${index}`, date: `2026-${month}-03`, description: "Streamflix Abo", amount: -12.99, bank: "Raiffeisen", pocket: "Raiffeisen Giro",
      category: "Abonnements", categoryOverride: true, manualCategory: true, reviewed: true, includeInPlan: true,
    })),
    ...months.map((month, index) => ({
      id: `gym-${index}`, date: `2026-${month}-02`, description: "FITNESS PRO GmbH", amount: -35, bank: "Raiffeisen", pocket: "Raiffeisen Giro",
      category: "Sport & Fitness", categoryOverride: true, manualCategory: true, reviewed: true, includeInPlan: true,
    })),
  ] as typeof state.transactions;
  return state;
}

async function seed(page: Page, width: number, height: number, theme: "light" | "dark" = "light") {
  await page.clock.setFixedTime(new Date("2026-09-12T12:00:00Z"));
  await page.setViewportSize({ width, height });
  await page.addInitScript(
    ({ key, state, theme, activation }) => {
      localStorage.setItem("theme", theme);
      localStorage.setItem(activation, "off");
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
    },
    { key: storageKey, state: syntheticState(), theme, activation: SECURITY_ACTIVATION_KEY },
  );
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

async function axe(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  // Contrast is measured on the settled dialog, not on its fade-in.
  await page.waitForTimeout(900);
  const { violations } = await new AxeBuilder({ page }).include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.filter((item) => blocking.has(item.impact ?? "")).flatMap((item) =>
    item.nodes.slice(0, 6).map((node) => `${item.id}: ${node.target.join(" ")} – ${node.failureSummary?.split("\n").slice(-1)[0] ?? ""}`))).toEqual([]);
}

for (const { width, height, presentation } of viewports) {
  test(`contract wizard at ${width} px opens as ${presentation} and creates a contract`, async ({ page }) => {
    await seed(page, width, height);
    await page.goto("/vertraege");
    await expect(page.getByRole("heading", { level: 1, name: "Verträge" })).toBeVisible();
    const add = page.getByRole("button", { name: "Vertrag hinzufügen" }).first();
    await add.click();
    const dialog = page.getByRole("dialog", { name: "Vertrag hinzufügen" });
    await expect(dialog).toHaveAttribute("data-presentation", presentation);
    await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
    await axe(page, dialog);
    await noHorizontalScroll(page);
    await dialog.getByLabel("Name", { exact: true }).fill("Fitnessstudio");
    await dialog.getByLabel("Betrag je Abbuchung").fill("35");
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    await expect(dialog.getByRole("group", { name: "Rhythmus" })).toBeVisible();
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    const bookings = dialog.getByRole("group", { name: "Buchungen" });
    await bookings.getByRole("searchbox", { name: "Buchungen durchsuchen" }).fill("fitness");
    for (const box of await bookings.getByRole("checkbox", { name: /FITNESS PRO GmbH/ }).all()) await box.check({ force: true });
    await expect(bookings.getByText("5 Buchungen ausgewählt")).toBeVisible();
    await noHorizontalScroll(page);
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    await expect(dialog.getByRole("switch", { name: /Neue Abbuchungen automatisch zuordnen/ })).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    await dialog.getByRole("button", { name: "Vertrag anlegen", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("region", { name: "Alle Verträge" }).getByText("Fitnessstudio")).toBeVisible();
    await expect(add).toBeFocused();
  });

  test(`goal wizard at ${width} px plans a distribution`, async ({ page }) => {
    await seed(page, width, height, "dark");
    await page.goto("/sparen");
    await page.getByRole("button", { name: "Sparziel hinzufügen" }).click();
    const dialog = page.getByRole("dialog", { name: "Sparziel hinzufügen" });
    await expect(dialog).toHaveAttribute("data-presentation", presentation);
    await dialog.getByLabel("Name", { exact: true }).fill(`Kamera ${width}`);
    await dialog.getByLabel("Zielbetrag").fill("1200");
    await dialog.getByLabel("Zieldatum").fill("2027-06-30");
    for (const step of ["Startkapital", "Konten", "Verteilung"]) {
      await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
      await expect(dialog.getByRole("group", { name: step, exact: true })).toBeVisible();
    }
    await expect(dialog.getByRole("table")).toBeVisible();
    await axe(page, dialog);
    await noHorizontalScroll(page);
    await dialog.getByRole("button", { name: "Weiter", exact: true }).click();
    await expect(dialog.getByRole("img", { name: /von 1\.200,00/ })).toBeVisible();
    await dialog.getByRole("button", { name: "Sparziel anlegen", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("article", { name: `Sparziel Kamera ${width}` })).toBeVisible();
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), storageKey);
    const goal = stored.savingsGoals?.find((item: { name: string }) => item.name === `Kamera ${width}`);
    expect(goal?.funding?.auto).toBe(true);
    expect(goal?.funding?.window).toEqual({ from: "2026-09", to: "2027-06" });
    expect(Array.isArray(goal?.funding?.plan)).toBe(true);
  });
}

test("bottom sheet closes when swiped down and with Escape", async ({ page }) => {
  await seed(page, 375, 812);
  await page.goto("/vertraege");
  await page.getByRole("button", { name: "Vertrag hinzufügen" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Vertrag hinzufügen" });
  await expect(dialog).toHaveAttribute("data-presentation", "sheet");
  // Drag from the settled sheet, not while it is still sliding in.
  await page.waitForTimeout(700);
  const box = (await dialog.getByRole("heading", { name: "Vertrag hinzufügen" }).boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 420, { steps: 10 });
  await page.mouse.up();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Vertrag hinzufügen" }).first().click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("simple input dialogs use the premium surface on phone and desktop", async ({ page }) => {
  for (const { width, height, presentation } of [viewports[0], viewports[2]]) {
    await seed(page, width, height);
    await page.goto("/");
    await page.getByRole("button", { name: "Geplante Ausgaben" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Geplante Ausgaben" });
    await expect(dialog).toHaveAttribute("data-presentation", presentation);
    await axe(page, dialog);
    await noHorizontalScroll(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});
