import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import { SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";

// Läuft ausschließlich mit synthetischen Daten (createSeed, per localStorage eingespielt).
// Kritische und schwere Verstöße lassen den Test scheitern; übrige Treffer werden nur protokolliert.
const storageKey = "finanzdashboard.v1";
const pages = [
  { path: "/", heading: "Übersicht" },
  { path: "/umsaetze", heading: "Umsätze" },
  { path: "/monate", heading: "Monate" },
  { path: "/einstellungen", heading: "Einstellungen" },
] as const;
const blocking = new Set(["critical", "serious"]);

async function seed(page: Page, theme: "light" | "dark") {
  const state = createSeed();
  await page.clock.setFixedTime(new Date("2026-09-12T12:00:00Z"));
  await page.addInitScript(
    ({ key, state, theme, activation }) => {
      localStorage.setItem("theme", theme);
      // Der automatische Sichtschutz würde Inhalte vor axe verbergen; geprüft wird der echte Inhalt.
      localStorage.setItem(activation, "off");
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
    },
    { key: storageKey, state, theme, activation: SECURITY_ACTIVATION_KEY },
  );
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`axe · ${theme}`, () => {
    for (const { path, heading } of pages) {
      test(`${path} hat keine kritischen oder schweren Verstöße`, async ({ page }, testInfo) => {
        await seed(page, theme);
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
        await expect(page.locator("html")).toHaveClass(new RegExp(theme));
        await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible();
        await expect(page.locator("html")).not.toHaveAttribute("data-security-mode", "locked");
        const { violations } = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        const summary = violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodes: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
        }));
        await testInfo.attach(`axe-${theme}${path.replace("/", "-") || "-start"}.json`, {
          body: JSON.stringify(summary, null, 2),
          contentType: "application/json",
        });
        const rest = summary.filter((item) => !blocking.has(item.impact ?? ""));
        if (rest.length) console.log(`axe (nicht blockierend) ${theme} ${path}: ${JSON.stringify(rest)}`);
        expect(summary.filter((item) => blocking.has(item.impact ?? "")), "kritische/schwere A11y-Verstöße").toEqual([]);
      });
    }
  });
}
