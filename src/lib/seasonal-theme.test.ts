import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseSeasonalTheme,
  isManualSeasonalTheme,
  resetSeasonalTheme,
  resolveSeasonalTheme,
  seasonalThemeBootstrap,
  seasonalThemes,
  type SeasonalPreference,
} from "./seasonal-theme";
import { appStateSchema, seasonalPreferenceSchema } from "./types";
import { createSeed } from "./seed";

afterEach(() => vi.useRealTimers());

describe("local seasonal calendar", () => {
  it.each([
    [2026, 1, 1, "newyear"],
    [2026, 1, 5, "newyear"],
    [2026, 1, 6, "default"],
    [2026, 2, 10, "default"],
    [2026, 2, 11, "carnival"],
    [2026, 2, 12, "carnival"],
    [2026, 2, 17, "carnival"],
    [2026, 2, 18, "default"],
    [2026, 3, 31, "default"],
    [2026, 4, 1, "easter"],
    [2026, 4, 2, "easter"],
    [2026, 4, 6, "easter"],
    [2026, 4, 10, "easter"],
    [2026, 4, 11, "default"],
    [2026, 6, 20, "default"],
    [2026, 6, 21, "summer"],
    [2026, 7, 1, "summer"],
    [2026, 8, 31, "summer"],
    [2026, 9, 1, "default"],
    [2026, 9, 12, "default"],
    [2026, 10, 24, "default"],
    [2026, 10, 25, "halloween"],
    [2026, 10, 31, "halloween"],
    [2026, 11, 1, "halloween"],
    [2026, 11, 2, "default"],
    [2026, 11, 30, "default"],
    [2026, 12, 1, "christmas"],
    [2026, 12, 26, "christmas"],
    [2026, 12, 27, "betweenyears"],
    [2026, 12, 31, "betweenyears"],
    [2027, 1, 5, "newyear"],
    [2027, 1, 6, "default"],
    [2027, 2, 4, "carnival"],
    [2027, 2, 9, "carnival"],
    [2027, 2, 10, "default"],
    [2027, 3, 25, "easter"],
    [2027, 3, 29, "easter"],
    [2027, 4, 2, "easter"],
    [2027, 4, 3, "default"],
  ] as const)(
    "%i-%i-%i resolves to %s at local midnight",
    (year, month, day, expected) => {
      const date = new Date(year, month - 1, day);
      expect(resolveSeasonalTheme(undefined, date)).toBe(expected);
      expect(
        resolveSeasonalTheme({ mode: "auto", theme: "halloween" }, date),
      ).toBe(expected);
    },
  );

  it.each(seasonalThemes)("a manual %s choice wins over the calendar", (theme) => {
    expect(
      resolveSeasonalTheme({ mode: "fixed", theme }, new Date(2026, 11, 24)),
    ).toBe(theme);
  });
  it("always-standard overrides the calendar", () => {
    expect(
      resolveSeasonalTheme(
        { mode: "default", theme: "christmas" },
        new Date(2026, 11, 24),
      ),
    ).toBe("default");
  });
  it("ignores an unknown stored theme and falls back to the calendar", () => {
    const preference = { mode: "fixed", theme: "script" } as unknown as SeasonalPreference;
    expect(resolveSeasonalTheme(preference, new Date(2026, 11, 24))).toBe("christmas");
  });
  it("choosing and resetting keeps accent and motion settings", () => {
    const base: SeasonalPreference = { mode: "auto", theme: "default", accentColor: "#60a5fa", reduceMotion: true };
    const chosen = chooseSeasonalTheme(base, "summer");
    expect(chosen).toEqual({ mode: "fixed", theme: "summer", accentColor: "#60a5fa", reduceMotion: true });
    expect(isManualSeasonalTheme(chosen)).toBe(true);
    const reset = resetSeasonalTheme(chosen);
    expect(reset).toEqual(base);
    expect(isManualSeasonalTheme(reset)).toBe(false);
  });
});
describe("presentation-only storage", () => {
  it("keeps old stores valid without modifying financial settings", () => {
    const seed = createSeed();
    const old = appStateSchema.parse(seed);
    expect(old.seasonalTheme).toBeUndefined();
    const preference = { mode: "fixed", theme: "christmas" };
    const themed = appStateSchema.parse({ ...seed, seasonalTheme: preference });
    expect(themed.seasonalTheme).toEqual(preference);
    const finance = { ...themed };
    delete finance.seasonalTheme;
    expect(finance).toEqual(old);
  });
  it("rejects invalid stored modes and themes", () => {
    expect(
      seasonalPreferenceSchema.safeParse({ mode: "unknown", theme: "default" })
        .success,
    ).toBe(false);
    expect(
      seasonalPreferenceSchema.safeParse({ mode: "fixed", theme: "script" })
        .success,
    ).toBe(false);
  });
});

describe("pre-paint bootstrap", () => {
  it.each([
    null,
    "{invalid",
    JSON.stringify({ seasonalTheme: { mode: "auto", theme: "default" } }),
  ])("uses the local calendar for old or unreadable storage: %s", (stored) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 1));
    const document = {
      documentElement: {
        dataset: { theme: "default" },
        style: { setProperty: vi.fn() },
      },
    };
    runInNewContext(seasonalThemeBootstrap, {
      document,
      Date,
      localStorage: { getItem: () => stored },
    });
    expect(document.documentElement.dataset.theme).toBe("christmas");
  });
  it("works when storage is blocked and applies a stored manual choice", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 31));
    const document = {
      documentElement: {
        dataset: { theme: "default" },
        style: { setProperty: vi.fn() },
      },
    };
    runInNewContext(seasonalThemeBootstrap, {
      document,
      Date,
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(document.documentElement.dataset.theme).toBe("halloween");
    runInNewContext(seasonalThemeBootstrap, {
      document,
      Date,
      localStorage: {
        getItem: () =>
          JSON.stringify({
            seasonalTheme: { mode: "default", theme: "halloween" },
          }),
      },
    });
    expect(document.documentElement.dataset.theme).toBe("default");
    runInNewContext(seasonalThemeBootstrap, {
      document,
      Date,
      localStorage: {
        getItem: () =>
          JSON.stringify({
            seasonalTheme: { mode: "fixed", theme: "summer" },
          }),
      },
    });
    expect(document.documentElement.dataset.theme).toBe("summer");
  });
});
