import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState } from "../src/lib/types";

const key = "finanzdashboard.v1";
test.use({ timezoneId: "America/Los_Angeles" });
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-12T19:00:00Z") });
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
  await page.getByText("Jahreszeit", { exact: true }).click();
}
async function fixed(page: Page, theme: string) {
  await page.getByLabel("Modus", { exact: true }).selectOption("fixed");
  await page.getByLabel("Theme", { exact: true }).selectOption(theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Einstellungen speichern" }).click();
  await expect(
    page.getByRole("button", { name: "Einstellungen speichern" }),
  ).toHaveCount(0);
  return stored(page);
}

test("preview is immediate, discard rolls back, save persists without changing finance data", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await settings(page);
  const before = await stored(page);
  const input = page.getByLabel("Motorrad", { exact: true });
  const yellow = await input.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await expect(page.getByLabel("Modus", { exact: true })).toHaveValue("auto");
  await expect(page.getByLabel("Theme", { exact: true })).toHaveCount(0);
  await fixed(page, "halloween");
  expect((await stored(page)).seasonalTheme).toBeUndefined();
  expect(
    await input.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(yellow);
  await input.fill("9100");
  await page.getByRole("button", { name: "Verwerfen" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  await expect(input).toHaveValue(String(before.settings.bikeTarget));
  await fixed(page, "christmas");
  const after = await save(page);
  expect(after.seasonalTheme).toEqual({ mode: "fixed", theme: "christmas" });
  delete after.seasonalTheme;
  expect(after).toEqual(before);
  await page.reload();
  await stored(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "christmas");
  await page.getByText("Jahreszeit", { exact: true }).click();
  await fixed(page, "halloween");
  await page.getByRole("link", { name: "Übersicht", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "christmas");
  expect(errors).toEqual([]);

  // The saved palette must also be correct before React can hydrate.
  await page.route("**/_next/static/**/*.js", (route) => route.abort());
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "christmas");
});

test("automatic uses the browser calendar at midnight and always-standard overrides it", async ({
  page,
}) => {
  await page.clock.pauseAt(new Date("2026-10-25T06:59:59Z")); // Oct 24, 23:59:59 locally.
  await page.goto("/einstellungen");
  await expect(page.getByLabel("Motorrad", { exact: true })).toBeVisible();
  await page.clock.runFor(200);
  await stored(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  await page.clock.runFor(1500);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "halloween");
  await page.clock.resume();
  await page.getByText("Jahreszeit", { exact: true }).click();
  await page.getByLabel("Modus", { exact: true }).selectOption("default");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  await save(page);
  await page.reload();
  await stored(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
});

test("all palettes keep text contrast and yellow inputs in both light and dark mode", async ({
  page,
}) => {
  await settings(page);
  for (const mode of ["dark", "light"]) {
    if (mode === "light")
      await page.getByRole("button", { name: "Farbschema wechseln" }).click();
    const yellow = await page
      .getByLabel("Motorrad", { exact: true })
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    for (const theme of ["halloween", "christmas", "newyear"]) {
      await fixed(page, theme);
      const contrast = await page.evaluate(() => {
        const sample = document.createElement("span");
        document.body.append(sample);
        function luminance(color: string) {
          const rgb = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map((value) => Number(value) / 255);
          const linear = rgb.map((v) =>
            v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
          );
          return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        }
        function token(name: string) {
          sample.style.color = `var(--${name})`;
          return luminance(getComputedStyle(sample).color);
        }
        const bg = token("card");
        const values = [
          "foreground",
          "muted-foreground",
          "primary",
          "chart-4",
        ].map((name) => {
          const fg = token(name);
          return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        });
        sample.remove();
        return values;
      });
      for (const value of contrast)
        expect(value, `${mode}/${theme}`).toBeGreaterThanOrEqual(4.5);
      expect(
        await page
          .getByLabel("Motorrad", { exact: true })
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      ).toBe(yellow);
    }
    await page.getByRole("button", { name: "Verwerfen" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
    await expect(page.locator("html")).toHaveClass(new RegExp(mode));
  }
});

for (const theme of ["halloween", "christmas"]) {
  test(`${theme} atmosphere stays behind the overview, pauses when hidden and respects reduced motion`, async ({
    page,
  }) => {
    await settings(page);
    await fixed(page, theme);
    await save(page);
    await page.goto("/");
    const particles = page.locator(".seasonal-particles");
    await expect(particles).toHaveCount(1);
    await expect(particles.locator("span")).toHaveCount(8);
    await expect(particles).toHaveAttribute("aria-hidden", "true");
    expect(
      await particles.evaluate((el) => getComputedStyle(el).pointerEvents),
    ).toBe("none");
    if (theme === "halloween")
      await expect(page.locator("header .seasonal-particles")).toHaveCount(1);
    else await expect(page.locator(".seasonal-shell")).toHaveCount(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(particles).toHaveAttribute("data-paused", "true");
    await expect(particles.locator("span").first()).toHaveCSS(
      "animation-play-state",
      "paused",
    );
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(particles).toHaveAttribute("data-paused", "false");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(particles).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator('[data-atmosphere="hero"]')).toHaveCount(1);
    await page.reload();
    await expect(particles).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(particles).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

test("working pages have zero atmosphere and no seasonal change affects chart data", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await settings(page);
  await fixed(page, "christmas");
  await save(page);
  for (const route of [
    "/umsaetze",
    "/monate",
    "/pockets",
    "/plan",
    "/einstellungen",
  ]) {
    await page.goto(route);
    await stored(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "christmas",
    );
    await expect(page.locator("[data-atmosphere]")).toHaveCount(0);
    await expect(page.locator(".app-shell")).toHaveAttribute(
      "data-seasonal-atmosphere",
      "none",
    );
  }
  await page.goto("/");
  await expect(page.locator(".seasonal-bike")).toHaveCount(1);
  const chart = page.locator(".recharts-area-curve").first();
  await expect(chart).toHaveAttribute("stroke", "var(--chart-1)");
  await page.screenshot({
    path: "test-results/seasonal-christmas.png",
    fullPage: true,
  });
  await settings(page);
  await fixed(page, "newyear");
  await save(page);
  await page.goto("/");
  await expect(page.locator(".seasonal-particles")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "newyear");
});
