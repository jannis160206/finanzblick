import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { accentSwatches, accentTokens, defaultAccentColor } from "./appearance";
import { seasonalThemeBootstrap } from "./seasonal-theme";
import { seasonalPreferenceSchema } from "./types";

function luminance(hex: string) {
  return [1, 3, 5]
    .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
    .reduce((sum, n, index) => sum + n * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a: string, b: string) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}
describe("personal accent", () => {
  it.each([
    ...accentSwatches.map((swatch) => swatch.color),
    "#000000",
    "#ffffff",
    "#777777",
    "#ff0000",
    "#0000ff",
    "#ffff00",
  ])("keeps %s as the brand color with readable text and rings", (color) => {
    const tokens = accentTokens(color);
    expect(tokens["--user-accent"]).toBe(color);
    expect(
      contrast(color, tokens["--user-accent-foreground"]),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(
        tokens["--user-accent-hover"],
        tokens["--user-accent-foreground"],
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(tokens["--user-accent-light"], "#f5f7f6"),
    ).toBeGreaterThanOrEqual(5);
    expect(
      contrast(tokens["--user-accent-dark"], "#272e2b"),
    ).toBeGreaterThanOrEqual(5);
  });
  it.each([undefined, "red", "#fff", "url(evil)"])(
    "uses a safe fallback for %s",
    (color) => {
      expect(accentTokens(color)["--user-accent"]).toBe(defaultAccentColor);
    },
  );
  it("preserves old preferences and only accepts complete hex colors", () => {
    const old = { mode: "fixed", theme: "christmas" };
    expect(seasonalPreferenceSchema.parse(old)).toEqual(old);
    expect(
      seasonalPreferenceSchema.parse({ ...old, accentColor: "#A78BFA" })
        .accentColor,
    ).toBe("#A78BFA");
    expect(
      seasonalPreferenceSchema.safeParse({ ...old, accentColor: "red" })
        .success,
    ).toBe(false);
  });
  it.each(["default", "halloween", "christmas", "newyear", "easter", "carnival", "summer", "betweenyears"])(
    "bootstrap retains the same accent under %s",
    (theme) => {
      const tokens: Record<string, string> = {};
      const document = {
        documentElement: {
          dataset: { theme: "default" },
          style: {
            setProperty: (name: string, value: string) => {
              tokens[name] = value;
            },
          },
        },
      };
      runInNewContext(seasonalThemeBootstrap, {
        document,
        Date,
        localStorage: {
          getItem: () =>
            JSON.stringify({
              seasonalTheme: { mode: "fixed", theme, accentColor: "#A78BFA" },
            }),
        },
      });
      // Old fixed-theme preferences no longer select the season; accent survives them all.
      expect(document.documentElement.dataset.theme).toBeDefined();
      expect(tokens).toEqual(accentTokens("#a78bfa"));
    },
  );
});
