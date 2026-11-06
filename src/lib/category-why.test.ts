import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import type { AppState, Transaction } from "@/lib/types";
import { categoryWhyText, explainCategory } from "./category-why";

const row = (extra: Partial<Transaction> = {}): Transaction =>
  ({ id: "t1", date: "2026-10-02", bank: "Raiffeisen", pocket: "Raiffeisen Giro", description: "MUSTERHOF HOFLADEN", amount: -25, category: "Lebensmittel", includeInPlan: true, ...extra });
const state = (): AppState => createEmptyAccountState();

describe("explainCategory", () => {
  it("prefers a person's choice", () => {
    const why = explainCategory(state(), row({ manualCategory: true }));
    expect(why).toMatchObject({ kind: "manual", source: "Manuell gesetzt", category: "Lebensmittel", date: "2026-10-02" });
  });

  it("reports the local AI", () => {
    expect(explainCategory(state(), row({ aiAssigned: true })).kind).toBe("ai");
  });

  it("finds a learned merchant rule", () => {
    const current = state();
    const booking = row();
    current.merchantRules = [{ key: merchantRuleKey(booking), category: "Lebensmittel" }];
    expect(explainCategory(current, booking)).toMatchObject({ kind: "learned", source: "Von dir gelernt" });
  });

  it("names the merchant rule from stored import evidence", () => {
    const why = explainCategory(state(), row({ automaticCategoryEvidence: { method: "merchant", category: "Lebensmittel" } }));
    expect(why.kind).toBe("rule");
    expect(why.detail).toContain("MUSTERHOF HOFLADEN → Lebensmittel");
    expect(categoryWhyText(why)).toMatch(/^MUSTERHOF HOFLADEN ist „Lebensmittel“/);
  });

  it("ignores a learned rule for a different category", () => {
    const current = state();
    const booking = row({ category: "Prüfen" });
    current.merchantRules = [{ key: merchantRuleKey(booking), category: "Freizeit" }];
    expect(explainCategory(current, booking).kind).not.toBe("learned");
  });
});
