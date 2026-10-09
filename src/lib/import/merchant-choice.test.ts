import { describe, expect, it } from "vitest";
import { merchantRuleSchema } from "@/lib/types";
import { mergeConfirmedMerchantChoices } from "./merchant-choice";

const name = {
  key: "amex|nordlicht",
  merchantAlias: "Nordlicht",
  category: "Prüfen" as const,
  identityOnly: true,
};
const category = { key: name.key, category: "Shopping" as const };

describe("independent confirmed name and category choices", () => {
  it("merges complementary confirmations without treating a missing category as disagreement", () => {
    for (const [first, second] of [
      [name, category],
      [category, name],
    ])
      expect(mergeConfirmedMerchantChoices(first, second)).toMatchObject({
        merchantAlias: "Nordlicht",
        category: "Shopping",
        identityOnly: undefined,
      });
    expect(mergeConfirmedMerchantChoices(name, name)?.identityOnly).toBe(true);
  });

  it("rejects true category, name and fixed-cost conflicts", () => {
    const full = { ...category, merchantAlias: "Nordlicht", fixedCost: true };
    for (const other of [
      { ...full, category: "Gesundheit" as const },
      { ...full, merchantAlias: "Anderer Laden" },
      { ...full, fixedCost: false },
      { ...category, category: "Prüfen" as const },
    ])
      expect(mergeConfirmedMerchantChoices(full, other)).toBeNull();
    expect(
      mergeConfirmedMerchantChoices(undefined, {
        ...category,
        category: "Prüfen",
      }),
    ).toBeNull();
  });

  it("validates name-only rules and rejects category/fixed-cost escalation", () => {
    expect(merchantRuleSchema.parse(name)).toEqual(name);
    for (const other of [
      { ...name, merchantAlias: undefined },
      { ...name, category: "Shopping" },
      { ...name, fixedCost: false },
    ])
      expect(merchantRuleSchema.safeParse(other).success).toBe(false);
  });
});
