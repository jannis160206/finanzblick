import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState } from "../src/lib/types";

const key = "finanzdashboard.v1";
test.use({ timezoneId: "America/Los_Angeles" });
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-14T19:00:00Z") });
  await page.addInitScript(
    ({ key, state }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify(state));
    },
    { key, state: createSeed() },
  );
});
async function stored(page: Page): Promise<AppState> {
  await expect(
    page.getByText("Lokal gespeichert", { exact: true }),
  ).toBeVisible();
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}
async function settings(page: Page) {
  await page.goto("/einstellungen");
  await stored(page);
}
const themeLabels: Record<string, string> = { default: "Standard", halloween: "Halloween", christmas: "Weihnachten", newyear: "Neujahr", carnival: "Fasching", easter: "Ostern", summer: "Sommer", betweenyears: "Zwischen den Jahren" };
const sceneThemes = ["halloween", "christmas", "newyear", "carnival", "easter", "summer", "betweenyears"];
async function fixed(page: Page, theme: string) {
  await page.getByRole("radio", { name: themeLabels[theme], exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Einstellungen speichern" }).click();
  await expect(
    page.getByRole("button", { name: "Einstellungen speichern" }),
  ).toHaveCount(0);
  return stored(page);
}
async function palette(page: Page) {
  return page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      [
        "--background",
        "--foreground",
        "--card",
        "--border",
        "--muted",
        "--muted-foreground",
        "--primary",
        "--ring",
        "--chart-1",
      ].map((name) => [name, css.getPropertyValue(name).trim()]),
    );
  });
}
async function accent(page: Page, color: string) {
  await page.getByLabel("Eigene Akzentfarbe", { exact: true }).fill(color);
  await expect.poll(async () => (await palette(page))["--primary"]).toBe(color);
}

test("personal accent previews immediately, discards and persists without changing financial data", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await settings(page);
  const before = await stored(page);
  const input = page.getByRole("searchbox", { name: "Einstellungen durchsuchen" });
  const yellow = await input.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await expect(page.getByLabel("Eigene Akzentfarbe")).toBeVisible();
  await expect(page.getByLabel("Festes Theme", { exact: true })).toHaveCount(0);
  await page.getByRole("radio", { name: "Blau", exact: true }).check();
  await expect
    .poll(async () => (await palette(page))["--primary"])
    .toBe("#60a5fa");
  await expect(page.locator(".brand-mark")).toHaveCSS(
    "background-color",
    "rgb(96, 165, 250)",
  );
  expect((await stored(page)).seasonalTheme).toBeUndefined();
  await page.getByRole("button", { name: "Verwerfen" }).click();
  await expect(input).toHaveValue("");
  await accent(page, "#b57edc");
  const after = await save(page);
  expect(after.seasonalTheme).toEqual({
    mode: "auto",
    theme: "default",
    accentColor: "#b57edc",
  });
  delete after.seasonalTheme;
  expect(after).toEqual(before);
  await page.reload();
  await stored(page);
  await expect(page.getByLabel("Eigene Akzentfarbe")).toHaveValue("#b57edc");
  expect(
    await input.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(yellow);
  await accent(page, "#60a5fa");
  await page.getByRole("link", { name: "Übersicht", exact: true }).click();
  await expect
    .poll(async () => (await palette(page))["--primary"])
    .toBe("#b57edc");
  expect(errors).toEqual([]);
  await page.route("**/_next/static/**/*.js", (route) => route.abort());
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect
    .poll(async () => (await palette(page))["--primary"])
    .toBe("#b57edc");
});

test("season decorates the same palette and logo instead of replacing the brand", async ({
  page,
}) => {
  await settings(page);
  await accent(page, "#60a5fa");
  const baseline = await palette(page);
  const headingFont = await page.locator("h1").evaluate((el) => getComputedStyle(el).fontFamily);
  const before = await stored(page);
  for (const theme of ["default", "halloween", "christmas", "newyear", "carnival", "easter", "summer", "betweenyears"]) {
    await fixed(page, theme);
    expect(await palette(page)).toEqual(baseline);
    await expect(page.getByLabel("Eigene Akzentfarbe")).toHaveValue("#60a5fa");
    await expect(
      page.locator('[data-logo-mark="finanzblick"] .lucide-landmark'),
    ).toHaveCount(1);
    await expect(page.locator(".logo-motif")).toHaveCount(theme === "default" ? 0 : 1);
    await expect(page.locator(".logo-season-detail")).toHaveCount(0);
    await expect(page.locator("canvas.season-scene")).toHaveAttribute("data-season-scene", sceneThemes.includes(theme) ? theme : "none");
    await expect(page.locator("h1")).toHaveCSS("font-family", headingFont);
    await expect(page.locator("h1")).toHaveCSS("text-shadow", "none");
    await expect(page.locator(".brand-mark")).toHaveCSS(
      "background-color",
      "rgb(96, 165, 250)",
    );
  }
  await expect(page.getByRole("radiogroup", { name: "Thema" }).getByRole("radio")).toHaveCount(8);
  const chosen = await stored(page);
  expect(chosen.seasonalTheme).toMatchObject({ mode: "fixed", theme: "betweenyears", accentColor: "#60a5fa" });
  delete chosen.seasonalTheme;
  delete before.seasonalTheme;
  expect(chosen).toEqual(before);
  await page.reload();
  await stored(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "betweenyears");
  await page.getByRole("button", { name: "Automatisch (Saison)" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  expect(await palette(page)).toEqual(baseline);
});

test("automatic uses local midnight and retains the personal accent after reload", async ({
  page,
}) => {
  await page.clock.pauseAt(new Date("2026-10-25T06:59:59Z"));
  await page.goto("/einstellungen");
  await expect(page.getByLabel("Eigene Akzentfarbe", { exact: true })).toBeVisible();
  await page.clock.runFor(200);
  await stored(page);
  await accent(page, "#a78bfa");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  await page.clock.runFor(1500);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "halloween");
  expect((await palette(page))["--primary"]).toBe("#a78bfa");
  await page.clock.resume();
  await save(page);
  await page.reload();
  await stored(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "halloween");
  expect((await palette(page))["--primary"]).toBe("#a78bfa");
});

for (const [theme, date] of [["halloween", "2026-10-31"], ["christmas", "2026-12-24"], ["carnival", "2026-02-14"], ["easter", "2026-04-05"], ["summer", "2026-07-14"], ["betweenyears", "2026-12-29"], ["newyear", "2027-01-02"]]) {
  test(`${theme} uses sparse static icons under reduced motion with untouched data pages`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.clock.setFixedTime(new Date(`${date}T19:00:00Z`));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await settings(page);
    await accent(page, "#a78bfa");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await save(page);
    const base = await palette(page);
    for (const route of ["/", "/umsaetze", "/monate", "/pockets", "/plan"]) {
      await page.goto(route);
      await stored(page);
      expect(await palette(page)).toEqual(base);
      await expect(
        page.locator(
          "[data-atmosphere], .seasonal-scene, .seasonal-particles, canvas",
        ),
      ).toHaveCount(0);
      await expect(page.locator("table [data-seasonal-icon]")).toHaveCount(0);
      const icons = page.locator("[data-seasonal-icon]:visible");
      expect(await icons.count()).toBe(route === "/" ? 5 : 3);
      for (const icon of await icons.all()) {
        await expect(icon).toHaveAttribute("aria-hidden", "true");
        await expect(icon).toHaveCSS("animation-name", "none");
        const size = await icon.boundingBox();
        expect(size!.width).toBeLessThanOrEqual(18);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Navigation öffnen" }).click();
    await page
      .getByRole("dialog")
      .getByRole("link", { name: "Übersicht", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Übersicht", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("light/dark and arbitrary extremes keep button and accent text contrast", async ({
  page,
}) => {
  await settings(page);
  for (const mode of ["dark", "light"]) {
    if (mode === "light")
      await page.getByRole("button", { name: "Farbschema wechseln" }).click();
    for (const color of ["#000000", "#ffffff", "#777777", "#ff0000"]) {
      await accent(page, color);
      // CSS tokens change immediately; rendered button colors transition.
      await expect.poll(() => page.evaluate(() => {
        const context = document.createElement("canvas").getContext("2d")!;
        const luminance = (color: string) => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((n) => {
              n /= 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            })
            .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
        };
        const ratio = (a: string, b: string) => {
          const sorted = [luminance(a), luminance(b)].sort((x, y) => x - y);
          return (sorted[1] + 0.05) / (sorted[0] + 0.05);
        };
        const button = getComputedStyle(
          document.querySelector('[data-variant="default"][type="submit"]')!,
        );
        const sample = document.createElement("span");
        sample.className = "text-primary";
        document.querySelector(".panel")!.append(sample);
        const result = [
          ratio(button.color, button.backgroundColor),
          ratio(
            getComputedStyle(sample).color,
            getComputedStyle(sample.parentElement!).backgroundColor,
          ),
        ];
        sample.remove();
        return Math.min(...result);
      }), { message: `${mode}/${color}` }).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("another tab's accent survives saving unrelated financial fields", async ({
  page,
}) => {
  await settings(page);
  const before = await stored(page);
  const preference = {
    mode: "fixed",
    theme: "christmas",
    accentColor: "#60a5fa",
  };
  await page.evaluate(
    ({ key, state }) => {
      localStorage.setItem(key, JSON.stringify(state));
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: JSON.stringify(state) }),
      );
    },
    { key, state: { ...before, seasonalTheme: preference } },
  );
  await expect
    .poll(async () => (await palette(page))["--primary"])
    .toBe("#60a5fa");
  await page.getByRole("link", { name: "Umsätze", exact: true }).click();
  await page.getByRole("button", { name: "Urlaub", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Von", { exact: true }).fill("2026-07-01");
  await dialog.getByLabel("Bis", { exact: true }).fill("2026-07-05");
  await dialog.getByRole("button", { name: "Zeitraum speichern" }).click();
  await expect.poll(async () => (await stored(page)).holidayRanges?.length).toBe(1);
  const after = await stored(page);
  expect(after.seasonalTheme).toEqual(preference);
  await dialog.getByRole("button", { name: "Fertig" }).click();
  await page.getByRole("link", { name: "Einstellungen", exact: true }).click();
  await expect(page.getByLabel("Eigene Akzentfarbe")).toHaveValue("#60a5fa");
});
