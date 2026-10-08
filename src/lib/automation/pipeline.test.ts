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
import { applyMerchantRules, rememberMerchants } from "@/lib/import/merchant-rules";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "@/lib/import/review";

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
    merchantAlias: "PENNY",
    merchantId: "at-penny",
    requires_manual_review: true,
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
    { ...seedMerchants[0], id: "second-billa", canonicalName: "BILLA", aliases: [], regexPatterns: [] },
  ]);
  const future = enrichTransaction({ ...booking("BILLA"), id: "future", date: "2026-10-09" }, collision,
    createAccountMerchantResolver(state));
  expect(future.requires_manual_review).toBe(true);
  const prepared = prepareStatementImport([{ file: "test.csv", source: "Amex", rows: [future], skipped: 0, issues: [] }], state);
  const committed = queueLedgerReview(commitStatementImport(state, prepared.automatic, [], prepared.metadata).state);
  expect(committed.reviewQueue?.some(item => item.id === future.id)).toBe(true);
  expect(applyMerchantRules(state, [booking("BILLA")])[0].categoryOverride).not.toBe(true);
  const legacy = { ...state, merchantRules: [{ key: merchantRuleKey(booking("BILLA")), category: row.category, merchantAlias: "BILLA" }] };
  expect(enrichTransaction({ ...booking("BILLA"), id: "future" }, collision,
    createAccountMerchantResolver(legacy)).requires_manual_review).toBe(true);
  expect(applyMerchantRules(legacy, [booking("BILLA")])[0].merchantAlias).toBeUndefined();
});

it("does not override contradictory merchant fields with an exact description match", () => {
  const row = { ...booking("POS BILLA"), rawDetails: ["Händler Name: BILLA", "Merchant Name: PENNY"] };
  const enriched = enrichTransaction(row, index);
  expect(enriched).toEqual({ ...row, requires_manual_review: true });
  const state = blankTestState();
  const prepared = prepareStatementImport([{ file: "test.csv", source: "Raiffeisen", rows: [enriched], skipped: 0, issues: [] }], state);
  expect(prepared.automatic).toHaveLength(0);
  expect(prepared.metadata.reviewQueue).toHaveLength(1);
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

it("excludes bank transfers but not direct debits, and keeps transfer rows out of merchant review", () => {
  const row = {
    ...booking("SEPA Überweisung an BILLA"),
    sourceCategory: "Überweisung",
  };
  expect(enrichTransaction(row, index)).toEqual(row);
  const backfilled = backfillBatch(
    { ...blankTestState(), transactions: [row] },
    new Set([row.id]),
    index,
  );
  expect(backfilled.reviewQueue).toEqual([]);
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
