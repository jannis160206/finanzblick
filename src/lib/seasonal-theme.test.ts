import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSeasonalTheme,
  seasonalThemeBootstrap,
  seasonalThemes,
} from "./seasonal-theme";
import { appStateSchema, seasonalPreferenceSchema } from "./types";
import { createSeed } from "./seed";

afterEach(() => vi.useRealTimers());

describe("local seasonal calendar", () => {
  it.each([
    [2026, 1, 1, "newyear"],
    [2026, 1, 5, "newyear"],
    [2026, 1, 6, "default"],
    [2026, 9, 12, "default"],
    [2026, 10, 24, "default"],
    [2026, 10, 25, "halloween"],
    [2026, 10, 31, "halloween"],
    [2026, 11, 1, "halloween"],
    [2026, 11, 2, "default"],
    [2026, 11, 30, "default"],
    [2026, 12, 1, "christmas"],
    [2026, 12, 26, "christmas"],
    [2026, 12, 27, "newyear"],
    [2026, 12, 31, "newyear"],
    [2027, 1, 5, "newyear"],
    [2027, 1, 6, "default"],
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

  it.each(seasonalThemes)("fixed %s overrides the calendar", (theme) => {
    expect(
      resolveSeasonalTheme({ mode: "fixed", theme }, new Date(2026, 11, 24)),
    ).toBe(theme);
  });
  it("always-standard wins during seasonal windows", () => {
    expect(
      resolveSeasonalTheme(
        { mode: "default", theme: "christmas" },
        new Date(2026, 11, 24),
      ),
    ).toBe("default");
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
  it("works when storage is blocked and honors saved overrides", () => {
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
  });
});
