import { describe, expect, it } from "vitest";
import { assistantCardSchema } from "@/lib/types";
import { buildChart, samplePoints } from "./chart";
import { forecastQuestion, projectAccounts } from "./forecast";
import { detectTool } from "./tools";

describe("account forecast", () => {
  const input = {
    today: "2026-11-06", end: "2027-01-31",
    accounts: [{ name: "Girokonto", start: 400, threshold: 100 }, { name: "Sparkonto", start: 1000, threshold: 0 }],
    events: [
      { date: "2026-11-10", account: "Girokonto", amount: -50, label: "Alltag", kind: "spending" as const },
      { date: "2026-11-15", account: "Girokonto", amount: -500, label: "Amex-Abbuchung", kind: "amex" as const },
      { date: "2026-11-20", account: "Girokonto", amount: -20, label: "Alltag", kind: "spending" as const },
      { date: "2026-11-28", account: "Girokonto", amount: 2000, label: "Gehalt", kind: "salary" as const },
      { date: "2026-11-28", account: "Sparkonto", amount: 200, label: "Sparrate", kind: "transfer" as const },
      { date: "2026-10-01", account: "Girokonto", amount: -9999, label: "Vergangen", kind: "fixed" as const },
    ],
  };

  it("finds the first low point, its cause and when the balance recovers", () => {
    const [giro, savings] = projectAccounts(input);
    expect(giro.lows).toHaveLength(1);
    expect(giro.lows[0]).toMatchObject({ date: "2026-11-15", balance: -150, lowest: -170, lowestDate: "2026-11-20", recovered: "2026-11-28" });
    expect(giro.lows[0].cause?.kind).toBe("amex");
    expect(giro.lowest).toEqual({ date: "2026-11-20", balance: -170 });
    expect(giro.end).toBe(1830);
    expect(giro.months.map((month) => month.month)).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(giro.months[0].min).toBe(-170);
    expect(savings.lows).toEqual([]);
    expect(savings.end).toBe(1200);
  });

  it("prefers a non-spending outflow as the cause on the same day", () => {
    const [giro] = projectAccounts({ ...input, accounts: [{ name: "Girokonto", start: 100, threshold: 0 }], events: [
      { date: "2026-11-07", account: "Girokonto", amount: -300, label: "Alltag", kind: "spending" },
      { date: "2026-11-07", account: "Girokonto", amount: -40, label: "Netflix", kind: "subscription" },
    ] });
    expect(giro.lows[0].cause?.label).toBe("Netflix");
    expect(giro.lows[0].recovered).toBeUndefined();
  });

  it("routes forecast questions without stealing budget or account questions", () => {
    for (const text of ["Wird mein Konto knapp?", "wie entwickelt sich mein kontostand", "reicht mein geld bis jänner", "Kontoprognose", "Cashflow für nächstes Jahr"]) {
      expect(forecastQuestion(text.toLowerCase())).toBe(true);
      expect(detectTool(text)).toBe("forecast");
    }
    expect(detectTool("was bleibt mir diesen monat noch")).toBe("budget");
    expect(detectTool("wie viel ist am sparkonto")).toBe("accounts");
    expect(detectTool("wie haben sich meine ausgaben entwickelt")).toBe("query");
  });
});

describe("chat charts", () => {
  it("samples long series to the bound and keeps both ends", () => {
    const items = Array.from({ length: 100 }, (_, index) => index);
    const sampled = samplePoints(items);
    expect(sampled).toHaveLength(24);
    expect(sampled[0]).toBe(0);
    expect(sampled.at(-1)).toBe(99);
  });

  it("builds charts that fit the card schema and drops empty ones", () => {
    const points = Array.from({ length: 40 }, (_, index) => ({ label: `Monat mit sehr langem Namen ${index}`, value: index * 1.2345 }));
    const chart = buildChart("line", [1, 2, 3, 4].map((index) => ({ name: `Reihe ${index}`, points })), { label: "Puffer", value: 100 });
    expect(chart?.series).toHaveLength(3);
    expect(chart?.series[0].points).toHaveLength(24);
    expect(assistantCardSchema.safeParse({ kind: "forecast", title: "Kontoprognose", lines: [], chart }).success).toBe(true);
    expect(buildChart("bar", [{ name: "x", points: [{ label: "a", value: 1 }] }])).toBeUndefined();
    const tooMany = { type: "bar", series: [{ name: "x", points: Array.from({ length: 25 }, () => ({ label: "a", value: 1 })) }] };
    expect(assistantCardSchema.safeParse({ kind: "answer", title: "x", lines: [], chart: tooMany }).success).toBe(false);
    const infinite = { type: "bar", series: [{ name: "x", points: [{ label: "a", value: Infinity }] }] };
    expect(assistantCardSchema.safeParse({ kind: "answer", title: "x", lines: [], chart: infinite }).success).toBe(false);
  });
});
