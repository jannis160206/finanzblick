import { describe, expect, it } from "vitest";
import { classify } from "@/lib/calc";
import { bankOperation } from "@/lib/bank-operation";
import { shouldShowMerchantMark } from "@/lib/merchant-mark-policy";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema, type Transaction } from "@/lib/types";
import { MerchantIndex, merchantSchema, seedMerchants } from "./merchants";
import { backfillBatch, enrichTransaction } from "./pipeline";
import { recurringLunchCategory } from "@/lib/recurring-purpose";

const booking = (description: string, patch: Partial<Transaction> = {}) =>
  transactionSchema.parse({
    id: "recurring-synthetic",
    description,
    date: "2026-10-09",
    amount: -30,
    bank: "Raiffeisen",
    pocket: null,
    category: "Prüfen",
    includeInPlan: true,
    ...patch,
  });
const index = new MerchantIndex(seedMerchants);

describe("source-backed recurring purpose upgrades", () => {
  it.each([
    "Kapitalertragsteuer",
    "KESt",
    "Kontoführung",
    "Erste Bank Kontoführungsgebühr",
  ])(
    "assigns explicit debit bank operations without merchant marks: %s",
    (description) => {
      const row = enrichTransaction(booking(description), index);
      expect(row).toMatchObject({
        category: "Bankgebühren",
        requires_manual_review: false,
        merchantLogo: false,
      });
      expect(row.merchantId).toBeUndefined();
      expect(shouldShowMerchantMark(row, classify(row))).toBe(false);
      expect(enrichTransaction(row, index)).toEqual(row);
    },
  );
  it.each(["Keine Kapitalertragsteuer", "SEPA Überweisung ohne KESt"])(
    "does not accept negated capital tax as a bank fee: %s",
    (description) => {
      expect(enrichTransaction(booking(description), index)).toMatchObject({
        category:"Prüfen",requires_manual_review:true,
      });
    },
  );
  it.each([
    "Habenzinsen",
    "0,125 % p.a. Habenzinsen ab",
    "Zinsgutschrift",
    "Credit interest",
  ])("treats positive interest as income, never refund: %s", (description) => {
    const source = booking(description, {
      amount: 2,
      category: "Rückerstattungen",
      categoryOverride: true,
    });
    expect(bankOperation(source)).toEqual({
      kind: "interest",
      category: "Einkommen",
    });
    const row = enrichTransaction(source, index);
    expect(row).toMatchObject({
      category: "Einkommen",
      requires_manual_review: false,
      merchantLogo: false,
      fixedCost: false,
    });
    expect(row.merchantAlias).toBeUndefined();
    expect(classify(row)).toMatchObject({
      category: "Einkommen",
      merchant: "Zinsertrag",
      isTransfer: false,
    });
    expect(classify(source).category).toBe("Einkommen");
    expect(shouldShowMerchantMark(row, classify(row))).toBe(false);
  });
  it.each([
    ["Habenzinsen", -1],
    ["Habenzinsen Kapitalertragsteuer", 1],
    ["Erstattung Habenzinsen", 1],
    ["Keine Habenzinsen", 1],
  ])(
    "leaves contradictory interest evidence open: %s",
    (description, amount) => {
      expect(
        enrichTransaction(booking(description, { amount }), index)
          .requires_manual_review,
      ).toBe(true);
    },
  );
  it.each(["BIPA", "Mensa", "Mensen", "Hotspot"])(
    "applies the personal weekday lunch rule but not weekends or Carinthian holidays: %s",
    (name) => {
      for (const date of ["2026-10-09", "2026-10-12"]) {
        const row = enrichTransaction(booking(name, { date }), index);
        expect(row).toMatchObject({
          category: "Mittagessen",
          requires_manual_review: false,
        });
        expect(classify(row).category).toBe("Mittagessen");
      }
      for (const date of [
        "2026-10-10",
        "2026-10-11",
        "2026-10-26",
        "2025-10-10",
      ]) {
        const row = enrichTransaction(
          booking(name, {
            date,
            category: "Mittagessen",
            categoryOverride: true,
          }),
          index,
        );
        const category = name === "BIPA" ? "Drogerie" : "Restaurants";
        expect(row).toMatchObject({ category, requires_manual_review: false });
        expect(classify(row).category).toBe(category);
        expect(
          classify(
            booking(name, {
              date,
              category: "Mittagessen",
              categoryOverride: true,
            }),
          ).category,
        ).toBe(category);
      }
      expect(recurringLunchCategory(name, "2026-02-30", -1)).toBeUndefined();
      expect(recurringLunchCategory(name, "2026-10-09", 1)).toBeUndefined();
    },
  );
  it("never binds generic lunch names to a global merchant or an invented logo", () => {
    for (const text of ["Hotspot", "Mensa", "Mensen"]) {
      const row = enrichTransaction(booking(text), index);
      expect(row.merchantId).toBeUndefined();
      expect(row.merchantAlias).toBeUndefined();
      expect(row.merchantLogo).toBe(false);
    }
    expect(
      enrichTransaction(booking("Hotspot Telekom GmbH"), index)
        .requires_manual_review,
    ).toBe(true);
    expect(
      enrichTransaction(booking("BIPA Netflix"), index).requires_manual_review,
    ).toBe(true);
  });
  it.each([
    "Shell Furnitz",
    "OMV Villach",
    "Eni Servicestation Villach",
    "JET",
    "Avanti",
  ])(
    "uses the explicit fuel purpose for a known recurring station: %s",
    (description) => {
      const row = enrichTransaction(booking(description), index);
      expect(row).toMatchObject({
        category: "Tanken",
        requires_manual_review: false,
      });
      expect(row.merchantId).toBeTruthy();
      expect(classify(row).category).toBe("Tanken");
    },
  );
  it("does not turn a station shop, cafe, car wash or contradictory MCC into fuel", () => {
    for (const patch of [
      { description: "Shell Cafe" },
      { description: "Shell Waschcenter" },
      { description: "Shell Tankstellenshop" },
      { description: "Shell Waschanlage" },
      { description: "JET Waschstraße" },
      { description: "Shell Car Wash" },
      { description: "Shell Coffee" },
      { description: "Shell", sourceCategory: "Fahrzeugwartung" },
      { description: "Shell", rawDetails: ["MCC: 5411"] },
    ]) {
      expect(
        enrichTransaction(booking(patch.description, patch), index)
          .requires_manual_review,
      ).toBe(true);
    }
  });
  // OFFEN (Fachentscheidung nötig, siehe README „Prüfungen“): 
  it.fails("requires consistent fuel evidence even for a generic fuel-purpose name", () => {
    for (const description of ["Tankstelle", "Diskont"]) {
      for (const patch of [
        { sourceCategory: "Café" },
        { sourceCategory: "Fahrzeugwartung" },
        { rawDetails: ["MCC: 5411"] },
      ]) {
        const row = enrichTransaction(booking(description, patch), index);
        expect(row.requires_manual_review).toBe(true);
        expect(classify(row).category).not.toBe("Tanken");
      }
    }
  });
  it("preserves equivalent verified IDs without losing the Prime or Eni purpose", () => {
    for (const [id, description, category] of [
      ["amazon", "Amazon Prime", "Abonnements"],
      ["eni", "Eni Servicestation Villach", "Tanken"],
    ] as const) {
      const seed = seedMerchants.find((merchant) => merchant.id === id)!;
      const equivalent = merchantSchema.parse({
        ...seed,
        id: `equivalent-${id}`,
        source: "osm",
      });
      const upgraded = enrichTransaction(
        booking(description, {
          merchantId: equivalent.id,
          merchantAlias: seed.canonicalName,
          merchantMatch: "alias",
          requires_manual_review: false,
          category: "Shopping",
        }),
        new MerchantIndex([seed, equivalent]),
      );
      expect(upgraded).toMatchObject({
        merchantId: equivalent.id,
        category,
        requires_manual_review: false,
      });
    }
  });
  it.each(["Tankstelle", "TANKSTELLE 2141", "Tankstelle2141", "Diskont", "DISKONT 2009 VILLACH 9500"])(
    "assigns the explicit recurring fuel purpose without inventing a shop identity: %s",
    (description) => {
      const row = enrichTransaction(booking(description), index);
      expect(row).toMatchObject({
        category: "Tanken",
        requires_manual_review: false,
        merchantLogo: false,
      });
      expect(row.merchantId).toBeUndefined();
      expect(classify(row).category).toBe("Tanken");
    },
  );
  it("does not mistake the legacy Hotspot/Trafik source bucket for a conflicting merchant", () => {
    const row=booking("Hotspot",{sourceCategory:"Hotspot / Trafik"});
    expect(enrichTransaction(row,index)).toMatchObject({category:"Mittagessen",requires_manual_review:false});
    expect(classify(row).category).toBe("Mittagessen");
    expect(enrichTransaction(booking("Hotspot Trafik",{sourceCategory:"Hotspot / Trafik"}),index).requires_manual_review).toBe(true);
  });
  it("does not conflate a PAGRO grocery/retail descriptor with Diskont fuel", () => {
    expect(
      enrichTransaction(booking("PAGRO Diskont"), index).category,
    ).not.toBe("Tanken");
    expect(
      enrichTransaction(booking("Diskont Markt"), index).requires_manual_review,
    ).toBe(true);
  });
  it.each(["Amazon Prime", "AMZNPrime amzn.de/info", "AMZNPrime", "AMZNPrime 123456789"])(
    "corrects old Prime shopping to subscription, retaining the Amazon identity: %s",
    (description) => {
      const row = enrichTransaction(
        booking(description, {
          category: "Shopping",
          merchantId: "amazon",
          merchantAlias: "Amazon",
          merchantMatch: "alias",
          requires_manual_review: false,
        }),
        index,
      );
      expect(row).toMatchObject({
        category: "Abonnements",
        merchantId: "amazon",
        requires_manual_review: false,
      });
      expect(classify(row).category).toBe("Abonnements");
      expect(classify(booking(description)).category).toBe("Abonnements");
      expect(enrichTransaction(row, index)).toEqual(row);
    },
  );
  // OFFEN (Fachentscheidung nötig, siehe README „Prüfungen“): 
  it.fails("corrects an old automatic row's name/category/logo from exact source evidence", () => {
    const billa = seedMerchants.find((merchant) => merchant.id === "at-billa");
    const logo = {
      file: `${"a".repeat(64)}.png`,
      license: "CC-BY-4.0",
      attribution: "Synthetic publicly licensed logo",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Synthetic.svg",
    };
    const complete = merchantSchema.parse({ ...billa, logo });
    const source = booking(
      "POS BILLA Filiale 4711 Terminal-ID: X992 12:42 Kartenfolge 3",
      {
        merchantId: "at-penny",
        merchantAlias: "PENNY",
        merchantMatch: "alias",
        merchantLogo: false,
        category: "Shopping",
        requires_manual_review: false,
      },
    );
    const receiptBooking = { ...source, id: "old-fixed-receipt" };
    const pendingBooking = { ...source, id: "pending-only" };
    const state = {
      ...blankTestState(),
      transactions: [source],
      fixedReceipts: [
        {
          key: "receipt",
          date: source.date,
          category: source.category,
          amount: source.amount,
          booking: receiptBooking,
        },
      ],
      reviewQueue: [
        {
          kind: "booking" as const,
          id: "pending-review",
          draft: pendingBooking,
          message: "Requires acceptance",
        },
      ],
    };
    const ids = new Set([source.id, receiptBooking.id, pendingBooking.id]);
    const corrected = backfillBatch(state, ids, new MerchantIndex([complete]));
    expect(corrected.transactions[0]).toMatchObject({
      description: source.description,
      amount: source.amount,
      merchantId: "at-billa",
      merchantAlias: "BILLA",
      category: "Lebensmittel",
      merchantLogo: true,
      requires_manual_review: false,
    });
    expect(corrected.fixedReceipts?.[0]).toMatchObject({
      category: "Lebensmittel",
      amount: receiptBooking.amount,
      booking: {
        merchantId: "at-billa",
        merchantAlias: "BILLA",
        merchantLogo: true,
        category: "Lebensmittel",
      },
    });
    expect(corrected.reviewQueue?.[0]).toMatchObject({
      draft: {
        id: pendingBooking.id,
        category: "Lebensmittel",
        merchantId: "at-billa",
        merchantLogo: true,
        requires_manual_review: true,
      },
    });
    expect(corrected.transactions).toHaveLength(1);
    expect(
      backfillBatch(corrected, ids, new MerchantIndex([complete])),
    ).toEqual(corrected);
  });
  it("does not change fuzzy or unproven historical identities", () => {
    const source = booking("BILLA", {
      merchantId: "previous-safe",
      merchantAlias: "Legacy",
      requires_manual_review: false,
    });
    expect(enrichTransaction(source, index)).toMatchObject({
      merchantId: "previous-safe",
      merchantAlias: "Legacy",
      requires_manual_review: true,
    });
    const fuzzy = {
      ...source,
      description: "Billaa",
      merchantMatch: "alias" as const,
    };
    expect(enrichTransaction(fuzzy, index)).toMatchObject({
      merchantId: fuzzy.merchantId,
      category: fuzzy.category,
    });
  });
  it("preserves every locked field and removes stale transfer logos only on unlocked rows", () => {
    const locked = booking("BIPA", {
      id: "locked",
      is_locked: true,
      category: "Geschenke & Spenden",
      merchantAlias: "Private choice",
    });
    const transfer = booking("SEPA Überweisung an Beispiel", {
      id: "transfer",
      merchantId: "at-billa",
      merchantAlias: "BILLA",
      merchantLogo: true,
      category: "Transfer",
      merchantMatch: "alias",
    });
    const state = { ...blankTestState(), transactions: [locked, transfer] };
    const result = backfillBatch(
      state,
      new Set([locked.id, transfer.id]),
      index,
    );
    expect(result.transactions[0]).toEqual(locked);
    const cleaned = enrichTransaction(transfer, index);
    expect(cleaned).toMatchObject({
      category: "Transfer",
      merchantLogo: false,
    });
    expect(cleaned.merchantId).toBeUndefined();
    expect(cleaned.merchantAlias).toBeUndefined();
    expect(result.transactions[1]).toEqual(cleaned);
  });
});
