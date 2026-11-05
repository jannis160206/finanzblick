import { expect, it } from "vitest";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema } from "@/lib/types";
import { MerchantIndex, merchantSchema, seedMerchants } from "./merchants";
import {
  backfillBatch,
  enrichTransaction,
  retainLockedAssignments,
} from "./pipeline";
import { lockManualAssignments } from "./locks";
import { createAccountMerchantResolver } from "./aliases";
import { assignTransactions } from "@/lib/transaction-tools";
import { classify } from "@/lib/calc";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import {
  applyMerchantRules,
  rememberMerchants,
} from "@/lib/import/merchant-rules";
import {
  commitStatementImport,
  prepareStatementImport,
  queueLedgerReview,
} from "@/lib/import/review";

const index = new MerchantIndex(seedMerchants);
const booking = (description: string) =>
  transactionSchema.parse({
    id: "test",
    description,
    bank: "Amex",
    pocket: "Amex",
    date: "2026-10-08",
    amount: -42,
    category: "Prüfen",
    includeInPlan: true,
  });

it("preserves an existing equivalent public merchant ID and its licensed logo", () => {
  const common = merchantSchema.parse({
    id: "local-brand",
    canonicalName: "Nordlicht",
    defaultCategory: "Shopping",
    aliases: [],
    regexPatterns: [],
    region: "AT",
    source: "local",
    updatedAt: 1,
    wikidataId: "Q123",
  });
  const imported = {
    ...common,
    id: "osm-brand",
    source: "osm" as const,
    logo: {
      file: `${"a".repeat(64)}.png`,
      license: "CC-BY-4.0" as const,
      attribution: "Test artist",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Test.png",
    },
  };
  const index = new MerchantIndex([common, imported]);
  const original = {
    ...booking("Nordlicht"),
    merchantId: imported.id,
    merchantAlias: "Nordlicht",
    merchantLogo: true,
    merchantMatch: "alias" as const,
    category: "Shopping" as const,
    requires_manual_review: false,
  };
  expect(enrichTransaction(original, index)).toMatchObject({
    merchantId: imported.id,
    merchantLogo: true,
    merchantAlias: "Nordlicht",
    category: "Shopping",
    requires_manual_review: false,
  });
});

it("assigns Müller, reviews unresolved providers/conflicts and does not guess on fuzzy hits", () => {
  expect(enrichTransaction(booking("Müller Filiale 47"), index)).toMatchObject({
    merchantAlias: "Müller",
    category: "Drogerie",
    requires_manual_review: false,
    merchantLogo: false,
    merchantMatch: "alias",
  });
  expect(
    enrichTransaction(booking("PayPal * BILLA 1234"), index),
  ).toMatchObject({ merchantAlias: "BILLA" });
  for (const text of ["PayPal 123456", "BILLA PENNY", "Muelller"])
    expect(enrichTransaction(booking(text), index)).toMatchObject({
      requires_manual_review: true,
    });
});

it("keeps unknown, fuzzy, conflicting and category-less matches open without changing old assignments", () => {
  const ambiguous = new MerchantIndex([
    ...seedMerchants,
    merchantSchema.parse({
      id: "unknown-category",
      canonicalName: "Nordlicht Laden",
      aliases: [],
      regexPatterns: [],
      defaultCategory: null,
      region: "AT",
      source: "osm",
      license: "ODbL-1.0",
      attribution: "© OpenStreetMap contributors",
      updatedAt: 1,
    }),
  ]);
  for (const description of [
    "Muelller",
    "BILLA PENNY",
    "Nordlicht Laden",
    "Unbekannter Laden",
  ]) {
    const row = {
      ...booking(description),
      category: "Shopping" as const,
      merchantId: "previous-safe",
      merchantAlias: "Bisheriger Händler",
      requires_manual_review: false,
    };
    const result = enrichTransaction(row, ambiguous);
    expect(result).toMatchObject({
      merchantId: row.merchantId,
      merchantAlias: row.merchantAlias,
      category: row.category,
      requires_manual_review: true,
    });
  }
  const row = {
    ...booking("BILLA"),
    merchantId: "at-penny",
    merchantAlias: "PENNY",
    requires_manual_review: false,
    merchantMatch: "alias" as const,
  };
  expect(enrichTransaction(row, index)).toMatchObject({
    merchantAlias: "BILLA",
    merchantId: "at-billa",
    requires_manual_review: false,
  });
});

it("uses a confirmed tenant alias for the next identical POS text without touching another account", () => {
  const row = booking("POS Nordlicht Laden Terminal 4711 12:42");
  const state = assignTransactions(
    { ...blankTestState(), transactions: [row] },
    [row.id],
    { merchantAlias: "Nordlicht", category: "Shopping" },
  );
  const future = { ...row, id: "future", date: "2026-10-09" };
  expect(
    enrichTransaction(future, index, createAccountMerchantResolver(state)),
  ).toMatchObject({
    merchantAlias: "Nordlicht",
    category: "Shopping",
    requires_manual_review: false,
    merchantMatch: "rule",
  });

  expect(
    enrichTransaction(
      future,
      index,
      createAccountMerchantResolver(blankTestState()),
    ),
  ).toMatchObject({
    requires_manual_review: true,
  });
  const backfilled = backfillBatch(state, new Set([row.id]), index);
  expect(backfilled.transactions[0]).toMatchObject({
    merchantAlias: "Nordlicht",
    category: "Shopping",
    is_locked: true,
  });
  expect(
    state.merchantRules?.some(
      (rule) =>
        rule.key === merchantRuleKey(row) && rule.merchantAlias === "Nordlicht",
    ),
  ).toBe(true);
});

it("does not learn or infer automatic global matches as confirmed aliases", () => {
  const row = enrichTransaction(booking("BILLA"), index);
  const state = { ...blankTestState(), transactions: [row] };
  expect(rememberMerchants(state, [row]).merchantRules ?? []).toEqual([]);
  const collision = new MerchantIndex([
    ...seedMerchants,
    {
      ...seedMerchants[0],
      id: "second-billa",
      canonicalName: "BILLA",
      wikidataId: null,
      aliases: [],
      regexPatterns: [],
    },
  ]);
  const future = enrichTransaction(
    { ...booking("BILLA"), id: "future", date: "2026-10-09" },
    collision,
    createAccountMerchantResolver(state),
  );
  expect(future.requires_manual_review).toBe(true);
  const prepared = prepareStatementImport(
    [
      {
        file: "test.csv",
        source: "Amex",
        rows: [future],
        skipped: 0,
        issues: [],
      },
    ],
    state,
  );
  const committed = queueLedgerReview(
    commitStatementImport(state, prepared.automatic, [], prepared.metadata)
      .state,
  );
  expect(committed.reviewQueue?.some((item) => item.id === future.id)).toBe(
    true,
  );
  expect(
    applyMerchantRules(state, [booking("BILLA")])[0].categoryOverride,
  ).not.toBe(true);
  const legacy = {
    ...state,
    merchantRules: [
      {
        key: merchantRuleKey(booking("BILLA")),
        category: row.category,
        merchantAlias: "BILLA",
      },
    ],
  };
  expect(
    enrichTransaction(
      { ...booking("BILLA"), id: "future" },
      collision,
      createAccountMerchantResolver(legacy),
    ).requires_manual_review,
  ).toBe(true);
  expect(
    applyMerchantRules(legacy, [booking("BILLA")])[0].merchantAlias,
  ).toBeUndefined();
});

it("does not override contradictory merchant fields with an exact description match", () => {
  const row = {
    ...booking("POS BILLA"),
    rawDetails: ["Händler Name: BILLA", "Merchant Name: PENNY"],
  };
  const enriched = enrichTransaction(row, index);
  expect(enriched).toEqual({ ...row, requires_manual_review: true });
  const state = blankTestState();
  const prepared = prepareStatementImport(
    [
      {
        file: "test.csv",
        source: "Raiffeisen",
        rows: [enriched],
        skipped: 0,
        issues: [],
      },
    ],
    state,
  );
  expect(prepared.automatic).toHaveLength(0);
  expect(prepared.metadata.reviewQueue).toHaveLength(1);
});

it("does not hide contradictory category evidence behind an explicit merchant field", () => {
  const row = {
    ...booking("BILLA KINO"),
    rawDescription: "BILLA KINO",
    rawDetails: ["Merchant Name: BILLA"],
  };
  expect(enrichTransaction(row, index)).toEqual({
    ...row,
    requires_manual_review: true,
  });
  const learnedRow = {
    ...booking("BILLA KINO Ref: NEW999"),
    rawDetails: ["Merchant Name: BILLA"],
  };
  const resolver = createAccountMerchantResolver({
    ...blankTestState(),
    merchantRules: [
      {
        key: merchantRuleKey(booking("BILLA KINO Ref: OLD123")),
        merchantAlias: "BILLA",
        category: "Lebensmittel",
      },
    ],
  });
  expect(
    enrichTransaction(learnedRow, index, resolver).requires_manual_review,
  ).toBe(true);
  expect(
    enrichTransaction({ ...booking("BILLA"), sourceCategory: "Kino" }, index)
      .requires_manual_review,
  ).toBe(true);
  const normalized = createAccountMerchantResolver({
    ...blankTestState(),
    merchantRules: [
      {
        key: merchantRuleKey(booking("BILLA Ref: OLD123")),
        merchantAlias: "BILLA",
        category: "Lebensmittel",
      },
    ],
  });
  expect(
    enrichTransaction(
      { ...booking("BILLA Ref: NEW999"), sourceCategory: "Kino" },
      index,
      normalized,
    ).requires_manual_review,
  ).toBe(true);
  for (const description of [
    "Netflix & Partner Steuerberatung",
    "AMZN Immobilien",
  ])
    expect(
      enrichTransaction(
        {
          ...booking(description),
          rawDetails: [
            `Merchant Name: ${description.startsWith("Netflix") ? "Netflix" : "AMZN"}`,
          ],
        },
        index,
      ).merchantAlias,
    ).toBeUndefined();
});

it.each(["Apple.com/bill"])(
  "recognizes %s without guessing the purchase category",
  (description) => {
    const result = enrichTransaction(booking(description), index);
    expect(result).toMatchObject({
      category: "Prüfen",
      merchantMatch: "alias",
      requires_manual_review: true,
    });
    expect(result.merchantId).toBeTruthy();
    expect(result.merchantAlias).toBeTruthy();
    expect(result.categoryOverride).not.toBe(true);
  },
);

it("accepts the recurring station purpose or fuel MCC but rejects contradictory labelled MCCs", () => {
  const original = booking("Shell Villach");
  expect(
    enrichTransaction({ ...original, rawDetails: ["MCC: 5542"] }, index),
  ).toMatchObject({ category: "Tanken", requires_manual_review: false });
  for (const detail of ["MCC: 5541", "Referenz: MCC 5542", "5542"])
    expect(
      enrichTransaction({ ...original, rawDetails: [detail] }, index)
        .requires_manual_review,
    ).toBe(false);
  for (const other of ["MCC: 5812", "MCC: unknown", "MCC: 554299"])
    expect(
      enrichTransaction(
        { ...original, rawDetails: ["MCC: 5542", other] },
        index,
      ).requires_manual_review,
    ).toBe(true);
  expect(
    enrichTransaction(
      {
        ...original,
        rawDetails: ["MCC: 5542", "Merchant Category Code: 5542"],
      },
      index,
    ).requires_manual_review,
  ).toBe(false);
});

it("lets an explicit confirmed marketplace choice resolve purchase-purpose uncertainty", () => {
  const original = booking("AMZN Mktp");
  const resolver = createAccountMerchantResolver({
    ...blankTestState(),
    merchantRules: [
      {
        key: merchantRuleKey(original),
        merchantAlias: "Amazon",
        category: "Möbel & Einrichtung",
      },
    ],
  });
  expect(enrichTransaction(original, index, resolver)).toMatchObject({
    merchantAlias: "Amazon",
    category: "Möbel & Einrichtung",
    requires_manual_review: false,
  });
});

it("does not mistake a generic salary credit from a known merchant for a refund", () => {
  const original = { ...booking("Gutschrift Gehalt BILLA"), amount: 2000 };
  expect(enrichTransaction(original, index)).toEqual(original);
  expect(
    enrichTransaction(
      { ...booking("Rueckerstattung AMZN Mktp"), amount: 42 },
      index,
    ),
  ).toMatchObject({
    merchantAlias: "Amazon",
    category: "Rückerstattungen",
    requires_manual_review: false,
  });
});

it("does not apply a confirmed refund category to the next outgoing purchase", () => {
  const row = booking("BILLA");
  const resolver = createAccountMerchantResolver({
    ...blankTestState(),
    merchantRules: [
      {
        key: merchantRuleKey(row),
        merchantAlias: "BILLA",
        category: "Rückerstattungen",
      },
    ],
  });
  expect(enrichTransaction(row, index, resolver)).toMatchObject({
    category: "Prüfen",
    requires_manual_review: true,
  });
});

it("keeps a locked receipt's wrapper category independent of the protected booking", () => {
  const original = {
    ...booking("BILLA"),
    category: "Shopping" as const,
    manualCategory: true,
    is_locked: true,
  };
  const input = {
    ...blankTestState(),
    transactions: [],
    fixedReceipts: [
      {
        key: "receipt",
        date: original.date,
        amount: original.amount,
        category: "Möbel & Einrichtung" as const,
        booking: original,
      },
    ],
  };
  expect(
    backfillBatch(input, new Set([original.id]), index).fixedReceipts?.[0],
  ).toEqual(input.fixedReceipts[0]);
  const changed = {
    ...input,
    fixedReceipts: [
      { ...input.fixedReceipts[0], category: "Shopping" as const },
    ],
  };
  expect(retainLockedAssignments(input, changed).fixedReceipts?.[0]).toEqual(
    input.fixedReceipts[0],
  );
});

it("does not let a global match override conflicting account aliases", () => {
  const row = booking("BILLA");
  const resolver = createAccountMerchantResolver({
    ...blankTestState(),
    merchantRules: [
      {
        key: merchantRuleKey(row),
        category: "Lebensmittel",
        merchantAlias: "BILLA",
      },
      {
        key: merchantRuleKey(row),
        category: "Shopping",
        merchantAlias: "Anderer Händler",
      },
    ],
  });
  expect(enrichTransaction(row, index, resolver)).toMatchObject({
    category: "Prüfen",
    requires_manual_review: true,
  });
  expect(enrichTransaction(row, index, resolver).merchantAlias).toBeUndefined();
});

it.each([
  ["Müller", "Müller"],
  ["BIPA", "BIPA"],
] as const)(
  "assigns %s refunds to the same merchant without spending or fixed-expense classification",
  (name, alias) => {
    const row = { ...booking(`Rückerstattung ${name} Filiale 47`), amount: 42 };
    const result = enrichTransaction(row, index);
    expect(result).toMatchObject({
      merchantAlias: alias,
      category: "Rückerstattungen",
      requires_manual_review: false,
    });
    expect(result.amount).toBe(42);
    expect(classify(result).isFixedCost).toBe(false);
    expect(classify(result).category).toBe("Rückerstattungen");
  },
);

it.each(["Transfer intern", "Transfer"] as const)(
  "does not categorize a %s from the merchant index",
  (category) => {
    const row = { ...booking("BILLA"), category, categoryOverride: true };
    expect(enrichTransaction(row, index)).toEqual(row);
  },
);

it("excludes bank transfers from merchant matching, but keeps their unknown purpose in review", () => {
  const row = {
    ...booking("SEPA Überweisung an BILLA"),
    sourceCategory: "Überweisung",
  };
  expect(enrichTransaction(row, index)).toMatchObject({
    category: "Prüfen",
    requires_manual_review: true,
    merchantLogo: false,
  });
  const backfilled = backfillBatch(
    { ...blankTestState(), transactions: [row] },
    new Set([row.id]),
    index,
  );
  expect(backfilled.reviewQueue).toEqual([
    expect.objectContaining({
      kind: "booking",
      draft: expect.objectContaining({
        id: row.id,
        requires_manual_review: true,
      }),
    }),
  ]);
  expect(
    enrichTransaction(
      { ...booking("Müller"), sourceCategory: "SEPA Lastschrift" },
      index,
    ).merchantId,
  ).toBe("at-mueller");
});

it("persists manual locks and never overwrites their merchant/category during automated reconciliation", () => {
  const row = {
    ...booking("BILLA"),
    category: "Shopping" as const,
    merchantAlias: "Mein Laden",
    manualCategory: true,
  };
  const state = lockManualAssignments({
    ...blankTestState(),
    transactions: [row],
  });
  expect(state.transactions[0].is_locked).toBe(true);
  expect(enrichTransaction(state.transactions[0], index)).toEqual(
    state.transactions[0],
  );
  const reconciled = retainLockedAssignments(state, {
    ...state,
    transactions: [
      {
        ...state.transactions[0],
        merchantAlias: "BILLA",
        category: "Lebensmittel",
      },
    ],
  });
  expect(reconciled.transactions[0]).toEqual(state.transactions[0]);
});

it("protects legacy manual aliases before applying a conflicting learned rule", () => {
  const row = {
    ...booking("BILLA"),
    category: "Shopping" as const,
    merchantAlias: "Mein Laden",
  };
  const state = {
    ...blankTestState(),
    transactions: [row],
    merchantRules: [
      { key: "amex|mein laden", category: "Lebensmittel" as const },
    ],
  };
  const updated = backfillBatch(state, new Set([row.id]), index);
  expect(updated.transactions[0]).toMatchObject({
    merchantAlias: "Mein Laden",
    category: "Shopping",
    is_locked: true,
  });
});

it("keeps deliberately reopened locked bookings in the review queue during backfill", () => {
  const row = { ...booking("BILLA"), manualCategory: true, is_locked: true };
  const state = {
    ...blankTestState(),
    transactions: [row],
    reviewQueue: [
      {
        kind: "booking" as const,
        id: row.id,
        draft: row,
        message: "Bewusst erneut prüfen",
      },
    ],
  };
  const updated = backfillBatch(state, new Set([row.id]), index);
  expect(updated.transactions[0].category).toBe("Prüfen");
  expect(updated.reviewQueue?.[0]).toEqual(state.reviewQueue[0]);
});

it("round-trips worker merchant IDs, locks and review flags through Excel without turning automatic aliases into manual ones", async () => {
  const row = {
    ...enrichTransaction(booking("Müller"), index),
    is_locked: false,
  };
  const state = { ...blankTestState(), transactions: [row] };
  const restored = await parseWorkbook(await exportWorkbook(state));
  expect(restored.state.transactions[0]).toMatchObject({
    merchantId: row.merchantId,
    merchantAlias: row.merchantAlias,
    is_locked: false,
    requires_manual_review: false,
    merchantLogo: row.merchantLogo,
    merchantMatch: row.merchantMatch,
  });
});

it("derives a curated chain's purpose over same-named map entries without guessing the outlet", () => {
  const curated = merchantSchema.parse({
    id: "local-kette", canonicalName: "Kettenmarkt", defaultCategory: "Drogerie", aliases: [],
    regexPatterns: [], region: "AT", source: "local", updatedAt: 1,
  });
  const branch = (id: string, defaultCategory: "Shopping" | null) => merchantSchema.parse({
    ...curated, id, defaultCategory, source: "osm", license: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
  });
  const chain = new MerchantIndex([curated, branch("osm-1", "Shopping"), branch("osm-2", null)]);
  expect(chain.match("Kettenmarkt").requiresManualReview).toBe(true);
  const result = enrichTransaction(booking("Kettenmarkt Filiale 12"), chain);
  expect(result).toMatchObject({
    category: "Drogerie", requires_manual_review: false,
    automaticCategoryEvidence: { method: "merchant", category: "Drogerie" },
  });
  expect(result.merchantId).toBeUndefined();
  const rival = merchantSchema.parse({ ...curated, id: "local-rival", defaultCategory: "Shopping" });
  const otherBrand = { ...branch("osm-3", null), wikidataId: "Q123" };
  for (const catalogue of [[curated, rival], [{ ...curated, wikidataId: "Q1" }, otherBrand]])
    expect(enrichTransaction(booking("Kettenmarkt"), new MerchantIndex(catalogue)))
      .toMatchObject({ requires_manual_review: true });
});

it("uses specific purpose keywords as evidence and reviews conflicting account history", () => {
  const empty = new MerchantIndex([]);
  for (const [description, category] of [
    ["Post Pp 9503", "Porto & Versand"], ["APOTHEKE.AT DUIVEN", "Gesundheit"],
    ["WWW.OEBB.AT TICKET FOR WIEN", "Öffentliche Verkehrsmittel"],
    ["PARKHAUS CITY ARKADEN KLAGENFURT", "Parken & Maut"],
    ["HOTEL ON BOOKING.COM AMSTERDAM", "Urlaub"], ["SWISS Intl Air Lines LJUBLJANA", "Urlaub"],
  ] as const)
    expect(enrichTransaction(booking(description), empty)).toMatchObject({
      category, requires_manual_review: false,
      automaticCategoryEvidence: { method: "purpose", category },
    });
  expect(enrichTransaction(booking("Post Pp 9503"), empty, undefined, () => "Geschenke & Spenden"))
    .toMatchObject({ requires_manual_review: true });
  expect(enrichTransaction(booking("Post Pp 9503"), empty, undefined, () => "Porto & Versand"))
    .toMatchObject({ category: "Porto & Versand", requires_manual_review: false });
  expect(enrichTransaction(booking("Kartenzahlung 9500"), empty)).toMatchObject({ requires_manual_review: true });
});

it("does not book small gas-station amounts as fuel", () => {
  const shell = { ...booking("Shell Furnitz 9586"), amount: -4.48 };
  expect(enrichTransaction(shell, index).category).not.toBe("Tanken");
});
