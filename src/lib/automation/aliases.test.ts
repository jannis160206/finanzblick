import { describe, expect, it } from "vitest";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema } from "@/lib/types";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import { createAccountMerchantResolver } from "./aliases";
import { enrichTransaction } from "./pipeline";
import { MerchantIndex, seedMerchants } from "./merchants";

const row = (description: string, bank = "Amex") =>
  transactionSchema.parse({
    id: "alias-source",
    date: "2026-10-08",
    bank,
    pocket: bank,
    description,
    category: "Prüfen",
    amount: -42,
    includeInPlan: true,
  });
const rule = (
  description: string,
  merchantAlias = "Nordlicht",
  category = "Shopping" as const,
) => ({ key: merchantRuleKey(row(description)), merchantAlias, category });
const index = new MerchantIndex(seedMerchants);

describe("tenant-only normalized confirmed aliases", () => {
  it("reuses a confirmed alias when terminal, branch and reference metadata change", () => {
    const resolver = createAccountMerchantResolver({
      ...blankTestState(),
      merchantRules: [rule("POS Nordlicht Laden Terminal 4711 Ref: OLD123")],
    });
    expect(
      enrichTransaction(
        row("POS Nordlicht Laden Terminal 9876 Ref: NEW999"),
        index,
        resolver,
      ),
    ).toMatchObject({
      merchantAlias: "Nordlicht",
      category: "Shopping",
      requires_manual_review: false,
    });
    expect(
      resolver(row("POS Nordlicht Laden Terminal 9876 Ref: NEW999", "Revolut"))
        .kind,
    ).toBe("none");
  });

  it("keeps collisions created by normalization open instead of selecting the latest rule", () => {
    const resolver = createAccountMerchantResolver({
      ...blankTestState(),
      merchantRules: [
        rule("POS Nordlicht Laden Ref: OLD123", "Nordlicht"),
        rule("POS Nordlicht Laden Ref: NEW999", "Other Company"),
      ],
    });
    expect(resolver(row("POS Nordlicht Laden Ref: THIRD777"))).toEqual({
      kind: "conflict",
    });
  });

  it("does not generalize category-only rules or generic provider/metadata descriptions", () => {
    const resolver = createAccountMerchantResolver({
      ...blankTestState(),
      merchantRules: [
        {
          key: merchantRuleKey(row("POS Nordlicht Laden Ref: OLD123")),
          category: "Shopping",
        },
        rule("PayPal", "Nordlicht"),
        rule("POS 3,00 AT D1", "Nordlicht"),
      ],
    });
    for (const text of [
      "POS Nordlicht Laden Ref: NEW999",
      "PayPal * Other Shop",
      "POS 5,00 AT D2",
    ])
      expect(resolver(row(text)).kind).toBe("none");
  });

  it("does not extend a special-purpose manual choice to different contextual evidence", () => {
    const resolver = createAccountMerchantResolver({
      ...blankTestState(),
      merchantRules: [
        {
          key: merchantRuleKey(row("POS BILLA Ref: OLD123")),
          merchantAlias: "BILLA",
          category: "Mittagessen",
        },
      ],
    });
    expect(
      enrichTransaction(row("POS BILLA Ref: NEW999"), index, resolver),
    ).toMatchObject({ category: "Prüfen", requires_manual_review: true });
  });

  it("includes category-only confirmations in normalized conflict detection", () => {
    for (const rules of [
      [
        rule("POS Nordlicht Laden Ref: OLD123"),
        {
          key: merchantRuleKey(row("POS Nordlicht Laden Ref: NEW999")),
          category: "Gesundheit" as const,
        },
      ],
      [
        {
          key: merchantRuleKey(row("POS Nordlicht Laden Ref: NEW999")),
          category: "Gesundheit" as const,
        },
        rule("POS Nordlicht Laden Ref: OLD123"),
      ],
    ]) {
      const resolver = createAccountMerchantResolver({
        ...blankTestState(),
        merchantRules: rules,
      });
      expect(resolver(row("POS Nordlicht Laden Ref: THIRD777"))).toEqual({
        kind: "conflict",
      });
    }
  });

  it("allows an agreeing category-only confirmation but not conflicting fixed-cost choices", () => {
    const named = rule("POS Nordlicht Laden Ref: OLD123");
    const categoryOnly = {
      key: merchantRuleKey(row("POS Nordlicht Laden Ref: NEW999")),
      category: named.category,
    };
    for (const rules of [
      [named, categoryOnly],
      [categoryOnly, named],
    ]) {
      const resolver = createAccountMerchantResolver({
        ...blankTestState(),
        merchantRules: rules,
      });
      expect(resolver(row("POS Nordlicht Laden Ref: THIRD777"))).toMatchObject({
        kind: "matched",
        normalized: true,
        choice: { merchantAlias: "Nordlicht", category: "Shopping" },
      });
    }
    const resolver = createAccountMerchantResolver({
      ...blankTestState(),
      merchantRules: [
        { ...named, fixedCost: true },
        { ...categoryOnly, fixedCost: false },
      ],
    });
    expect(resolver(row("POS Nordlicht Laden Ref: THIRD777"))).toEqual({
      kind: "conflict",
    });
  });
});
