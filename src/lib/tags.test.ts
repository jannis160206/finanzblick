import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type Transaction } from "@/lib/types";
import { allTags, setTag, tagSummaries } from "./tags";

const booking = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-09-03", bank: "Raiffeisen", pocket: "Testkonto",
  description: "Hotel Sol Malaga", amount: -100, category: "Urlaub", includeInPlan: true, ...overrides,
});
const state = () => appStateSchema.parse({
  ...createSeed(), transactions: [
    booking("hotel"),
    booking("food", { description: "Restaurante Playa", amount: -40, category: "Restaurants", date: "2026-09-05" }),
    booking("ignored", { amount: -999, ignored: true }),
    booking("other", { description: "Billa", amount: -20, category: "Lebensmittel" }),
  ],
});

describe("tags", () => {
  it("adds and removes a tag case-insensitively without duplicates", () => {
    const tagged = setTag(state(), new Set(["hotel", "food", "ignored"]), "#Malaga 2026");
    expect(tagged.transactions.find((row) => row.id === "hotel")?.tags).toEqual(["Malaga 2026"]);
    expect(setTag(tagged, new Set(["hotel"]), "malaga 2026")).toBe(tagged);
    const removed = setTag(tagged, new Set(["hotel"]), "MALAGA 2026", true);
    expect(removed.transactions.find((row) => row.id === "hotel")?.tags).toBeUndefined();
    expect(allTags(removed)).toEqual(["Malaga 2026"]);
  });

  it("sums spending per tag across categories and skips ignored bookings", () => {
    const tagged = setTag(state(), new Set(["hotel", "food", "ignored"]), "Malaga 2026");
    expect(tagSummaries(tagged)).toEqual([{
      tag: "Malaga 2026", count: 2, spent: 140, from: "2026-09-03", to: "2026-09-05",
      categories: [{ category: expect.any(String), amount: 100 }, { category: expect.any(String), amount: 40 }],
    }]);
  });

  it("survives schema validation", () => {
    const tagged = setTag(state(), new Set(["hotel"]), "Malaga");
    expect(appStateSchema.parse(tagged).transactions.find((row) => row.id === "hotel")?.tags).toEqual(["Malaga"]);
  });
});
