import { describe, expect, it } from "vitest";
import { classify } from "@/lib/calc";
import type { Transaction } from "@/lib/types";

const booking = (patch: Partial<Transaction> = {}): Transaction => ({
  id: "cache-1", date: "2026-09-14", description: "Spar Filiale 12 Wien", amount: -23.4,
  bank: "Revolut", pocket: null, category: "Prüfen", includeInPlan: true, ...patch,
});

describe("classify result reuse", () => {
  it("returns equal results for repeated calls on the same booking object", () => {
    const row = booking();
    expect(classify(row)).toEqual(classify(row));
  });

  it("does not let callers poison the stored result", () => {
    const row = booking();
    const first = classify(row);
    const original = first.category;
    first.category = "Gehalt";
    expect(classify(row).category).toBe(original);
  });

  it("recomputes after the same object was edited in place", () => {
    const row = booking({ category: "Freizeit", categoryOverride: true });
    expect(classify(row).category).toBe("Freizeit");
    row.category = "Shopping";
    expect(classify(row).category).toBe("Shopping");
    row.amount = 40;
    row.categoryOverride = false;
    row.category = "Prüfen";
    expect(classify(row)).toEqual(classify({ ...row }));
  });

  it("treats a copy with a changed field as a different booking", () => {
    const row = booking({ category: "Freizeit", categoryOverride: true });
    expect(classify(row).category).toBe("Freizeit");
    expect(classify({ ...row, category: "Shopping" }).category).toBe("Shopping");
    expect(classify(row).category).toBe("Freizeit");
  });
});
