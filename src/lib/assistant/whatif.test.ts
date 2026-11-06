import { describe, expect, it } from "vitest";
import { assistantCardSchema, type AssistantWhatIf } from "@/lib/types";
import { detectTool } from "./tools";
import { computeWhatIf, reachMonth, whatIfQuestion } from "./whatif";

const data: AssistantWhatIf = {
  goal: { id: "japan", name: "Japan", target: 3000, saved: 1000, date: "2027-06-01", monthly: 200 },
  start: "2026-12", rates: [200, 200, 200], tail: 200, extra: 0,
  subscriptions: [{ name: "Netflix", monthly: 15, cancel: true }, { name: "Spotify", monthly: 11, cancel: false }],
};

describe("what-if", () => {
  it("finds the month a goal is reached", () => {
    expect(reachMonth(data, 1000, 3000)).toBe("2027-09");
    expect(reachMonth(data, 1000, 3000, 300)).toBe("2027-03");
    expect(reachMonth(data, 3000, 3000)).toBe("2026-11");
    expect(reachMonth({ start: "2026-12", rates: [], tail: 0 }, 0, 100)).toBeUndefined();
  });

  it("adds cancelled subscriptions and extra savings and compares the reach date", () => {
    const outcome = computeWhatIf(data, 185);
    expect(outcome).toMatchObject({ cancelled: 15, extra: 185, freed: 200, yearly: 2400, before: "2027-09", after: "2027-04", earlier: 5, onTime: true, beforeOnTime: false });
    expect(computeWhatIf(data, 0, [true, true]).freed).toBe(26);
    expect(computeWhatIf({ ...data, goal: undefined }, 50, [false, false])).toEqual({ cancelled: 0, extra: 50, freed: 50, yearly: 600 });
  });

  it("is a valid persisted card", () => {
    expect(assistantCardSchema.safeParse({ kind: "whatif", title: "Was wäre wenn", lines: [], whatif: data }).success).toBe(true);
    expect(assistantCardSchema.safeParse({ kind: "whatif", title: "x", lines: [], whatif: { ...data, rates: Array(37).fill(1) } }).success).toBe(false);
  });

  it("recognises what-if questions without stealing others", () => {
    for (const text of ["Wenn ich Netflix kündige und 200 € mehr spare, wann erreiche ich Japan?", "was wäre wenn ich 100 € im monat mehr spare",
      "Was wäre, wenn ich Spotify kündige?", "wenn ich monatlich 50 € extra spare, wann hab ich das motorrad"]) {
      expect(whatIfQuestion(text.toLowerCase())).toBe(true);
      expect(detectTool(text)).toBe("whatif");
    }
    expect(detectTool("Kündige Netflix")).toBe("cancel");
    expect(detectTool("Ich will 200 € mehr im Monat sparen")).toBe("coach");
    expect(whatIfQuestion("was wäre, wenn ich im april 600 € für möbel ausgebe? geht sich das aus?")).toBe(false);
    expect(whatIfQuestion("was wäre wenn ich bis juli 3000 € für japan spare")).toBe(false);
  });
});
